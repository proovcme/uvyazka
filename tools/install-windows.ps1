# First installation only. Download this file from the same official release as
# uvyazka-install.json; callers pin its SHA-256 before invoking it.
# No Python, PowerShell modules, model weights or administrator elevation needed.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')][string]$Version,
    [switch]$Install,
    [switch]$VerifyOnly
)

function Write-UvyazkaInstallEvent([string]$State, [string]$Message, [hashtable]$Data = @{}) {
    $row = @{schema='uvyazka.install-event.v1'; state=$State; message=$Message}
    foreach ($key in $Data.Keys) { $row[$key] = $Data[$key] }
    [Console]::Out.WriteLine(($row | ConvertTo-Json -Compress -Depth 8))
}

function Assert-UvyazkaReleaseUri([uri]$Uri) {
    if ($Uri.Scheme -ne 'https' -or $Uri.Port -ne 443 -or $Uri.UserInfo -or $Uri.Fragment) {
        throw 'HTTPS release URL required.'
    }
    if ($Uri.Host -eq 'github.com') {
        if (-not $Uri.AbsolutePath.StartsWith('/proovcme/uvyazka/releases/download/')) { throw 'Unexpected release repository.' }
    } elseif ($Uri.Host -notin @('release-assets.githubusercontent.com','objects.githubusercontent.com')) {
        throw 'Unexpected release download host.'
    }
}

function Receive-UvyazkaFile([string]$Url, [string]$Destination, [long]$Limit) {
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('Uvyazka-First-Install/1')
    $response = $null; $inputStream = $null; $outputStream = $null
    try {
        $uri = [uri]$Url
        for ($redirect=0; $redirect -le 5; $redirect++) {
            Assert-UvyazkaReleaseUri $uri
            $response = $client.GetAsync($uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            if ([int]$response.StatusCode -in @(301,302,303,307,308)) {
                if ($redirect -eq 5 -or -not $response.Headers.Location) { throw 'Too many or invalid redirects.' }
                $uri = [uri]::new($uri, $response.Headers.Location)
                $response.Dispose(); $response = $null
                continue
            }
            $null = $response.EnsureSuccessStatusCode(); break
        }
        $length = $response.Content.Headers.ContentLength
        if ($length -and $length -gt $Limit) { throw 'Download exceeds size limit.' }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [IO.File]::Create($Destination)
        $buffer = New-Object byte[] 65536; [long]$received = 0
        $clock = [Diagnostics.Stopwatch]::StartNew(); [long]$lastEvent = 0
        while ($true) {
            if ($clock.Elapsed.TotalMinutes -gt 10) { throw 'Download timed out.' }
            $pendingRead = $inputStream.ReadAsync($buffer,0,$buffer.Length)
            if (-not $pendingRead.Wait(30000)) { throw 'Download stopped responding.' }
            $count = $pendingRead.GetAwaiter().GetResult()
            if ($count -eq 0) { break }
            $received += $count
            if ($received -gt $Limit) { throw 'Download exceeds size limit.' }
            $outputStream.Write($buffer,0,$count)
            if ($clock.ElapsedMilliseconds - $lastEvent -ge 1000) {
                Write-UvyazkaInstallEvent 'downloading' 'Downloading release file.' @{received=$received; total=$length}
                $lastEvent = $clock.ElapsedMilliseconds
            }
        }
        if ($length -and $received -ne $length) { throw 'Incomplete download.' }
    } finally {
        if ($outputStream) { $outputStream.Dispose() }; if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }; $client.Dispose(); $handler.Dispose()
    }
}

function Assert-UvyazkaInstallManifest($Manifest, [string]$ExpectedVersion) {
    $expectedUrl = 'https://github.com/proovcme/uvyazka/releases/download/v' + $ExpectedVersion + '/uvyazka_' + $ExpectedVersion + '_x64-setup.exe'
    if ($Manifest.schema -ne 'uvyazka.install.v1' -or $Manifest.version -ne $ExpectedVersion -or
        $Manifest.release_tag -ne ('v'+$ExpectedVersion) -or $Manifest.platform -ne 'windows-x86_64' -or
        $Manifest.operation -ne 'first_install' -or $Manifest.installer.kind -ne 'nsis' -or
        $Manifest.installer.scope -ne 'currentUser' -or $Manifest.installer.url -cne $expectedUrl -or
        $Manifest.installer.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $Manifest.installer.size -lt 100000 -or $Manifest.installer.size -gt 1610612736 -or
        @($Manifest.installer.arguments).Count -ne 1 -or $Manifest.installer.arguments[0] -cne '/S' -or
        $Manifest.existing_installation -ne 'use_in_app_signed_updater') {
        throw 'Unsupported or inconsistent install manifest.'
    }
}

function Test-UvyazkaAlreadyInstalled {
    $name = -join ([char[]]@(0x423,0x432,0x44f,0x437,0x43a,0x430))
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        if (Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $name }) { return $true }
    }
    return [bool](Get-Process -Name 'uvyazka-desktop','uvyazka-core' -ErrorAction SilentlyContinue)
}

function Invoke-UvyazkaFirstInstall {
    $ErrorActionPreference = 'Stop'
    $temporary = $null; $mutex = $null; $locked = $false; $keepFiles = $false
    try {
        if ($env:OS -ne 'Windows_NT' -or ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64')) { throw 'Windows x64 is required.' }
        if ($Install -and $VerifyOnly) { throw 'Choose Install or VerifyOnly.' }
        $mutex = New-Object Threading.Mutex($false,'Local\uvyazka.first-install.v1')
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Another Uvyazka installation is in progress.' }
        if ($Install -and (Test-UvyazkaAlreadyInstalled)) {
            Write-UvyazkaInstallEvent 'existing_installation' 'Use the in-app signed updater after finishing active jobs.'
            return 3
        }
        $temporary = Join-Path ([IO.Path]::GetTempPath()) ('uvyazka-install-'+[guid]::NewGuid().ToString('N'))
        $null = [IO.Directory]::CreateDirectory($temporary)
        $manifestPath = Join-Path $temporary 'manifest.json'
        $manifestUrl = 'https://github.com/proovcme/uvyazka/releases/download/v'+$Version+'/uvyazka-install.json'
        Write-UvyazkaInstallEvent 'checking' 'Checking the requested official release.' @{version=$Version}
        Receive-UvyazkaFile $manifestUrl $manifestPath 262144
        $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
        Assert-UvyazkaInstallManifest $manifest $Version
        if (-not $Install -and -not $VerifyOnly) {
            Write-UvyazkaInstallEvent 'plan' 'Ready for explicit first-install command.' @{version=$Version; size=$manifest.installer.size; scope='currentUser'; arguments=@('/S')}
            return 0
        }
        $installer = Join-Path $temporary 'uvyazka-setup.exe'
        Receive-UvyazkaFile $manifest.installer.url $installer ([long]$manifest.installer.size)
        if ((Get-Item -LiteralPath $installer).Length -ne $manifest.installer.size -or
            (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.installer.sha256) { throw 'Installer checksum or size mismatch. Nothing was executed.' }
        Write-UvyazkaInstallEvent 'verified' 'Installer bytes match the official HTTPS release manifest.' @{version=$Version; verification='sha256_over_official_https'; updater_signature_verified=$false}
        if ($VerifyOnly) { return 0 }
        if (Test-UvyazkaAlreadyInstalled) {
            Write-UvyazkaInstallEvent 'existing_installation' 'Installation appeared during download. Use the in-app signed updater.'
            return 3
        }
        # Fixed arguments only; no shell command, elevation, process killing or relaunch.
        Write-UvyazkaInstallEvent 'installing' 'Installing for the current user.'
        $process = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -PassThru
        $minutes = [Diagnostics.Stopwatch]::StartNew()
        while (-not $process.WaitForExit(15000)) {
            Write-UvyazkaInstallEvent 'installing' 'Installer is still running.'
            if ($minutes.Elapsed.TotalMinutes -ge 30) { $keepFiles=$true; throw 'Installer is still running after 30 minutes. Check Windows before retrying.' }
        }
        if ($process.ExitCode -notin @(0,3010)) { throw ('Installer failed with code '+$process.ExitCode+'.') }
        Write-UvyazkaInstallEvent 'installer_finished' 'Installer finished. Discover and check the local API before reporting readiness.' @{version=$Version; reboot_required=($process.ExitCode -eq 3010); service_ready=$false}
        return 0
    } catch {
        Write-UvyazkaInstallEvent 'error' $_.Exception.Message
        return 1
    } finally {
        if ($temporary -and -not $keepFiles) {
            try { [IO.Directory]::Delete($temporary,$true) } catch { Write-UvyazkaInstallEvent 'cleanup_pending' 'Temporary installer files could not be removed.' @{path=$temporary} }
        }
        if ($locked) { $mutex.ReleaseMutex() }; if ($mutex) { $mutex.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') { exit (Invoke-UvyazkaFirstInstall) }
