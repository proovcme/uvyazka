# Runs the real orchestration and validation with synthetic transport/processes.
# No network, real installer, registry write, process termination or model needed.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/install-windows.ps1" -Version '1.2.3-alpha.1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('uvyazka-install-test-'+[guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($fixture)
try {
    $bytes = New-Object byte[] 100002; $bytes[0]=77; $bytes[1]=90
    [IO.File]::WriteAllBytes((Join-Path $fixture 'fixture.exe'),$bytes)
    $digest = (Get-FileHash (Join-Path $fixture 'fixture.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    function New-FixtureManifest {
        return @{schema='uvyazka.install.v1';version='1.2.3-alpha.1';release_tag='v1.2.3-alpha.1';platform='windows-x86_64';operation='first_install';existing_installation='use_in_app_signed_updater';installer=@{kind='nsis';scope='currentUser';url='https://github.com/proovcme/uvyazka/releases/download/v1.2.3-alpha.1/uvyazka_1.2.3-alpha.1_x64-setup.exe';size=100002;sha256=$digest;arguments=@('/S')}}
    }
    function Reset-Fixture {
        $script:manifest = New-FixtureManifest
        $script:downloads=0; $script:starts=0; $script:installed=$false; $script:tampered=$false; $script:exitCode=0
        $script:installChecks=0; $script:appearsDuringDownload=$false; $script:lastTemporary=$null
    }
    function Test-UvyazkaAlreadyInstalled { $script:installChecks++; return ($script:installed -or ($script:appearsDuringDownload -and $script:installChecks -gt 1)) }
    function Receive-UvyazkaFile([string]$Url,[string]$Destination,[long]$Limit) {
        $script:downloads++; $script:lastTemporary=Split-Path $Destination
        if ($Url.EndsWith('.json')) { [IO.File]::WriteAllText($Destination,($script:manifest | ConvertTo-Json -Depth 8)) }
        elseif ($script:tampered) { [IO.File]::WriteAllText($Destination,'changed installer') }
        else { [IO.File]::Copy((Join-Path $fixture 'fixture.exe'),$Destination) }
    }
    function Start-Process($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru) {
        if ($ArgumentList -cne '/S' -or $WindowStyle -ne 'Hidden' -or -not $PassThru) { throw 'Unexpected process invocation' }
        $script:starts++
        return ([pscustomobject]@{ExitCode=$script:exitCode} | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {param($timeout) return $true} -PassThru)
    }
    function Assert-Result([int]$Expected,[int]$Downloads,[int]$Starts) {
        $priorOutput=[Console]::Out; $events=New-Object IO.StringWriter
        try { [Console]::SetOut($events); $code = Invoke-UvyazkaFirstInstall }
        finally { [Console]::SetOut($priorOutput) }
        if ($code -ne $Expected -or $script:downloads -ne $Downloads -or $script:starts -ne $Starts) { throw 'Wrong orchestration result' }
        $rows=@($events.ToString().Split([char]10) | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
        $finished=@($rows | Where-Object state -EQ 'installer_finished')
        if ($Expected -ne 0 -and $finished.Count) { throw 'Failed operation reported installation success' }
        if ($Starts -eq 1 -and $Expected -eq 0 -and ($finished.Count -ne 1 -or $finished[0].service_ready -ne $false)) { throw 'Missing truthful completion event' }
        if (@($rows | Where-Object schema -NE 'uvyazka.install-event.v1').Count) { throw 'Invalid progress contract' }
        $events.Dispose()
        if ($script:lastTemporary -and (Test-Path -LiteralPath $script:lastTemporary)) { throw 'Temporary download leaked' }
    }
    Reset-Fixture; $Install=$false; $VerifyOnly=$false; Assert-Result 0 1 0
    Reset-Fixture; $VerifyOnly=$true; Assert-Result 0 2 0
    Reset-Fixture; $script:tampered=$true; Assert-Result 1 2 0
    foreach ($change in @('url','arguments','scope','version','size','sha256','platform')) {
        Reset-Fixture
        switch ($change) {
            'url' {$script:manifest.installer.url='https://example.com/other.exe'}
            'arguments' {$script:manifest.installer.arguments=@('/S','/D=C:\other')}
            'scope' {$script:manifest.installer.scope='perMachine'}
            'version' {$script:manifest.version='1.2.4'}
            'size' {$script:manifest.installer.size=1610612737}
            'sha256' {$script:manifest.installer.sha256='wrong'}
            'platform' {$script:manifest.platform='windows-arm64'}
        }
        Assert-Result 1 1 0
    }
    $Install=$true; $VerifyOnly=$false
    Reset-Fixture; $script:installed=$true; Assert-Result 3 0 0
    Reset-Fixture; $script:appearsDuringDownload=$true; Assert-Result 3 2 0
    Reset-Fixture; Assert-Result 0 2 1
    Reset-Fixture; $script:exitCode=1603; Assert-Result 1 2 1
    foreach ($bad in @('http://github.com/proovcme/uvyazka/releases/download/v1/a','https://example.com/a','https://github.com/other/repo/releases/download/v1/a','https://user:secret@github.com/proovcme/uvyazka/releases/download/v1/a')) {
        $rejected=$false; try { Assert-UvyazkaReleaseUri ([uri]$bad) } catch { $rejected=$true }
        if (-not $rejected) { throw 'Unsafe redirect accepted' }
    }
    'Synthetic first-install orchestration passed; no installer was executed.'
} finally { [IO.Directory]::Delete($fixture,$true) }
