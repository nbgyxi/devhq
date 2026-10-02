# Stops every running WinT, and the torrent engine with it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\stop-wint.ps1
#
# WinT goes first. The torrent engine watches WinT's process and, once it is
# gone, writes down what it has transferred and closes its session, so it is
# given time to do that before being forced; killing it outright loses the
# last few seconds of progress.

param(
    # How long the torrent engine gets to shut itself down before it is forced.
    [int]$GraceSeconds = 15
)

# An elevated WinT (or the PC Detective's elevated host it starts) can only be
# stopped from an elevated prompt, so the script reopens itself as admin. The
# window stays open afterwards so what it did can be read.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`"", '-GraceSeconds', $GraceSeconds
    )
    exit
}

$app = 'wint', 'wint-desktop', 'wint-cli'
$engine = 'wint-torrent-helper'

$running = Get-Process -Name $app -ErrorAction SilentlyContinue
if ($running) {
    $running | ForEach-Object { Write-Host "Stopping $($_.Name) ($($_.Id))" }
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
} else {
    Write-Host 'WinT is not running.'
}

$deadline = (Get-Date).AddSeconds($GraceSeconds)
while ((Get-Process -Name $engine -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Write-Host "Waiting for the torrent engine to shut down..."
    Start-Sleep -Seconds 1
}

$left = Get-Process -Name $engine -ErrorAction SilentlyContinue
if ($left) {
    $left | ForEach-Object { Write-Host "Forcing $($_.Name) ($($_.Id)) - it did not stop within $GraceSeconds s" }
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
}

$still = Get-Process -Name ($app + $engine) -ErrorAction SilentlyContinue
if ($still) {
    $still | ForEach-Object { Write-Warning "$($_.Name) ($($_.Id)) is still running - it may belong to another user or need an elevated prompt." }
    exit 1
}
Write-Host 'No WinT processes left.'
