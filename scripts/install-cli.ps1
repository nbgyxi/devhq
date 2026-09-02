param([switch]$Debug, [switch]$BuildOnly)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $repo "src-tauri\Cargo.toml"
$profile = if ($Debug) { "debug" } else { "release" }
$cargoArgs = @("build", "--manifest-path", $manifest, "--bin", "wint-cli")
if (-not $Debug) { $cargoArgs += "--release" }

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    $cargoPath = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (-not (Test-Path -LiteralPath $cargoPath)) { throw "Rust/Cargo is required to build the WinT CLI." }
    $cargo = $cargoPath
}
& $cargo @cargoArgs
if ($LASTEXITCODE -ne 0) { throw "The WinT CLI build failed." }
if ($BuildOnly) { exit 0 }

$installDir = Join-Path $env:LOCALAPPDATA "WinT\bin"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force -LiteralPath (Join-Path $repo "src-tauri\target\$profile\wint-cli.exe") -Destination (Join-Path $installDir "wint.exe")
$desktopExe = Join-Path $repo "src-tauri\target\$profile\wint.exe"
if (Test-Path -LiteralPath $desktopExe) {
    Copy-Item -Force -LiteralPath $desktopExe -Destination (Join-Path $installDir "wint-desktop.exe")
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ })
if (-not ($entries | Where-Object { $_.TrimEnd("\") -ieq $installDir.TrimEnd("\") })) {
    [Environment]::SetEnvironmentVariable("Path", (($entries + $installDir) -join ";"), "User")
}
if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $installDir.TrimEnd("\") })) {
    $env:Path += ";$installDir"
}

Write-Host "Installed WinT CLI to $installDir\wint.exe"
Write-Host "Open a new terminal, then run: wint help"
