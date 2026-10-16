param([string]$HomePath = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskArguments = @('run', '--directory', $taskRoot, 'python', (Join-Path $PSScriptRoot 'setup_rvt.py'))
if ($HomePath) { $taskArguments += @('--home', $HomePath) }
& uv @taskArguments
if ($LASTEXITCODE -ne 0) { throw 'RVT runtime build failed; see output above.' }
