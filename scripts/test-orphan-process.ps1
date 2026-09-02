$ErrorActionPreference = "Stop"

$pidFile = Join-Path $env:TEMP "wint-orphan-test.pid"
$marker = "WINT_ORPHAN_TEST"
$childCommand = @"
`$host.UI.RawUI.WindowTitle = '$marker'
while (`$true) { Start-Sleep -Seconds 1 }
"@

$child = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @(
    "-NoLogo",
    "-NoProfile",
    "-Command",
    $childCommand
)

Set-Content -LiteralPath $pidFile -Value $child.Id -Encoding ascii

Write-Host "WinT orphan-process test is ready." -ForegroundColor Cyan
Write-Host "Hidden child PID: $($child.Id)"
Write-Host "Now close this terminal tab. After about two seconds, the Terminal button should show warning 1."
Write-Host "Cleanup afterward: powershell -ExecutionPolicy Bypass -File .\scripts\stop-test-orphan-process.ps1"
Write-Host "Keeping this parent attached so WinT can snapshot the complete process tree..."

while ($true) { Start-Sleep -Seconds 1 }
