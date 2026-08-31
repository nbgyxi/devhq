param([switch]$Debug, [switch]$BuildOnly)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $repo "src-tauri\Cargo.toml"
$profile = if ($Debug) { "debug" } else { "release" }
$cargoArgs = @("build", "--manifest-path", $manifest, "--bin", "devhq-cli")
if (-not $Debug) { $cargoArgs += "--release" }

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    $cargoPath = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (-not (Test-Path -LiteralPath $cargoPath)) { throw "Rust/Cargo is required to build the DevHQ CLI." }
    $cargo = $cargoPath
}
& $cargo @cargoArgs
if ($LASTEXITCODE -ne 0) { throw "The DevHQ CLI build failed." }
if ($BuildOnly) { exit 0 }

$installDir = Join-Path $env:LOCALAPPDATA "DevHQ\bin"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force -LiteralPath (Join-Path $repo "src-tauri\target\$profile\devhq-cli.exe") -Destination (Join-Path $installDir "devhq.exe")
$desktopExe = Join-Path $repo "src-tauri\target\$profile\devhq.exe"
if (Test-Path -LiteralPath $desktopExe) {
    Copy-Item -Force -LiteralPath $desktopExe -Destination (Join-Path $installDir "devhq-desktop.exe")
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ })
if (-not ($entries | Where-Object { $_.TrimEnd("\") -ieq $installDir.TrimEnd("\") })) {
    [Environment]::SetEnvironmentVariable("Path", (($entries + $installDir) -join ";"), "User")
}
if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $installDir.TrimEnd("\") })) {
    $env:Path += ";$installDir"
}

Write-Host "Installed DevHQ CLI to $installDir\devhq.exe"
Write-Host "Open a new terminal, then run: devhq help"
