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

# A process that has been terminated but still has a thread blocked in the
# kernel (a read or write to a drive that never answered) stays in the process
# table with HasExited set. Nothing in user mode can finish it off - not even
# an elevated prompt - so it is told apart from one that is genuinely alive.
function Get-Live($names) {
    Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object { -not $_.HasExited }
}
function Get-Stuck($names) {
    Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.HasExited }
}

$deadline = (Get-Date).AddSeconds($GraceSeconds)
while ((Get-Live $engine) -and (Get-Date) -lt $deadline) {
    Write-Host "Waiting for the torrent engine to shut down..."
    Start-Sleep -Seconds 1
}

$left = Get-Live $engine
if ($left) {
    $left | ForEach-Object {
        $p = $_
        Write-Host "Forcing $($p.Name) ($($p.Id)) - it did not stop within $GraceSeconds s"
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop }
        catch { Write-Warning "Could not stop $($p.Name): $($_.Exception.Message)" }
        $null = $p.WaitForExit(5000)
    }
}

$stuck = Get-Stuck ($app + $engine)
$stuck | ForEach-Object {
    Write-Warning ("$($_.Name) ($($_.Id)) has been killed but Windows cannot remove it yet: " +
        "a thread is still waiting on a drive (often one that was unplugged or stopped answering). " +
        "It runs no code and goes away once that I/O completes, or on the next restart.")
}

$still = Get-Live ($app + $engine)
if ($still) {
    $still | ForEach-Object { Write-Warning "$($_.Name) ($($_.Id)) is still running - it may belong to another user." }
    exit 1
}
if ($stuck) { exit 1 }
Write-Host 'No WinT processes left.'
