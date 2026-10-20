param(
    [ValidateRange(1024, 65535)][int]$Port = 8779,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$viewerRoot = Split-Path -Parent $PSScriptRoot
$viewerUrl = "http://127.0.0.1:$Port/uvyazka/"
$sitePath = Join-Path $viewerRoot '.uvyazka-build/public-site/uvyazka'
$pythonPath = Join-Path $viewerRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw 'Local Python environment missing. Install the project into .venv first.'
}
foreach ($asset in @('index.html', 'release.json', 'runtime/rvt/uvyazka_rvt_browser_bg.wasm', 'runtime/web-ifc/web-ifc.wasm')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sitePath $asset))) {
        throw "Viewer assets missing: $asset. Build tools/build_browser_runtime.py and tools/build_demo_site.py first."
    }
}
function Test-ViewerReady {
    try {
        $release = Invoke-RestMethod -Uri ($viewerUrl + 'release.json') -TimeoutSec 2
        return ($release.mode -eq 'browser-compute-and-synthetic-demo' -and $release.browser_file_open -eq $true)
    } catch { return $false }
}
if (-not (Test-ViewerReady)) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($listener) { throw "Port $Port is occupied by another service; use -Port with a free port." }
    $logRoot = Join-Path $viewerRoot '.uvyazka-build'
    $server = Start-Process -FilePath $pythonPath -ArgumentList @('-u', 'tools/serve_browser_demo.py', '--port', "$Port") `
        -WorkingDirectory $viewerRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logRoot "local-viewer-$Port.out.log") `
        -RedirectStandardError (Join-Path $logRoot "local-viewer-$Port.err.log")
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (Test-ViewerReady) { $ready = $true; break }
        if ($server.HasExited) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw "Viewer did not start. Check .uvyazka-build/local-viewer-$Port.err.log." }
}
Write-Output $viewerUrl
if (-not $NoBrowser) { Start-Process $viewerUrl }
