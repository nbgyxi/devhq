$ErrorActionPreference = "Stop"

$pidFile = Join-Path $env:TEMP "devhq-orphan-test.pid"
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host "No DevHQ orphan-test PID file was found."
    exit 0
}

$testPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$process = Get-Process -Id $testPid -ErrorAction SilentlyContinue
if ($process) {
    Stop-Process -Id $testPid -Force
    Write-Host "Stopped DevHQ orphan-test process $testPid."
} else {
    Write-Host "DevHQ orphan-test process $testPid was already stopped."
}

Remove-Item -LiteralPath $pidFile -Force
