<#
.SYNOPSIS
  Builds DevHQ and packages it as an MSIX for Microsoft Store submission
  (or local sideload testing).

.DESCRIPTION
  Tauri cannot emit MSIX directly, so this script:
    1. Runs `tauri build` to produce the release exe (frontend is embedded).
    2. Stages the exe + generated logo assets into a layout folder.
    3. Renders AppxManifest.xml from the template (token substitution).
    4. Packs it into an .msix with makeappx.exe (Windows SDK).
    5. (Optional) signs it with a self-signed cert for local install testing.

  For the Microsoft Store you submit the UNSIGNED .msix - Partner Center
  re-signs it with the Store certificate. Use -SelfSign only to sideload and
  test locally.

  Identity values must match what you reserved in Partner Center
  (Partner Center > your app > Product management > Product identity).

.EXAMPLE
  # Store submission build (unsigned). The identity defaults below are already
  # DevHQ's reserved Partner Center values, so this is the whole command:
  #   1. add the release to the top of src/changelog.js
  #   2. then:
  ./scripts/package-msix.ps1 -BumpVersion

.EXAMPLE
  # Local test build, self-signed so you can install it:
  ./scripts/package-msix.ps1 -SelfSign -IdentityName "Dev.DevHQ" `
      -Publisher "CN=DevHQDev" -PublisherDisplayName "Dev"
#>
[CmdletBinding()]
param(
    # Package Identity > Name from Partner Center. This is per-app, NOT per
    # account: every app under the same publisher shares the "53653Gyxi."
    # prefix but has its own name after it. Passing another app's value is
    # rejected at upload ("Invalid package identity name").
    [string]$IdentityName = "53653Gyxi.DevHQ",

    # Package Identity > Publisher from Partner Center. Account-wide, so it is
    # the same for every app. For -SelfSign this must match the cert subject.
    [string]$Publisher = "CN=E33FD025-8793-475B-BE54-EF895462FBA0",

    # Publisher Display Name from Partner Center.
    [string]$PublisherDisplayName = "Gyxi",

    [string]$DisplayName = "DevHQ",
    [string]$Description = "Developer overview of every project in a folder.",

    # Skip the tauri build step and reuse the existing release exe.
    [switch]$SkipBuild,

    # Bring tauri.conf.json up to the version at the top of src/changelog.js
    # before packaging. Without this, a build whose two versions disagree is
    # refused rather than shipped under a number the app cannot explain.
    [switch]$BumpVersion,

    # Sign with a generated self-signed cert for LOCAL sideload testing only.
    [switch]$SelfSign,

    # Defaults to <repo>/target/msix, worked out below - `$PSScriptRoot` is not
    # populated while parameter defaults are being bound, so using it here
    # silently resolves to "/../target/msix" and writes to the root of C:.
    [string]$OutDir
)

$ErrorActionPreference = "Stop"
$repoRoot   = (Resolve-Path "$PSScriptRoot/..").Path
$tauriRoot  = Join-Path $repoRoot "src-tauri"
$templatePath = Join-Path $repoRoot "packaging/msix/AppxManifest.template.xml"
if (-not $OutDir) { $OutDir = Join-Path $repoRoot "target/msix" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

function Find-SdkTool([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $bases = @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "$env:ProgramFiles\Windows Kits\10\bin")
    foreach ($base in $bases) {
        if (Test-Path $base) {
            $hit = Get-ChildItem -Path $base -Recurse -Filter $name -ErrorAction SilentlyContinue |
                   Where-Object { $_.FullName -match "\\x64\\" } |
                   Sort-Object FullName -Descending | Select-Object -First 1
            if ($hit) { return $hit.FullName }
        }
    }
    throw "$name not found. Install the Windows 10/11 SDK (includes makeappx/signtool)."
}

function ConvertTo-XmlText([string]$value) {
    return [System.Security.SecurityElement]::Escape($value)
}

# --- 1. Version (4-part, last digit 0 per Store rules) --------------------
# The release list in the app is the source of truth. Whatever sits at the top
# of src/changelog.js is the version being built, and tauri.conf.json has to
# say the same thing - that is what the exe carries, what the MSIX is named
# after, and what the status bar shows through `app_version`. A package whose
# number is not in the list in the window is one nobody can place.
#
# Resolved BEFORE the build so the version baked into the exe matches the MSIX.
$changelogPath = Join-Path $repoRoot "src/changelog.js"
$changelogRaw  = Get-Content $changelogPath -Raw
$topRelease = [regex]::Match(
    $changelogRaw,
    '(?m)^\s*version:\s*"(\d+\.\d+\.\d+)"',
    [System.Text.RegularExpressions.RegexOptions]::None,
    [TimeSpan]::FromSeconds(5))
if (-not $topRelease.Success) {
    throw "No release found in $changelogPath. The newest release goes at the top of the list."
}
$listVersion = $topRelease.Groups[1].Value

$confPath = Join-Path $tauriRoot "tauri.conf.json"
$confRaw  = Get-Content $confPath -Raw
$conf     = $confRaw | ConvertFrom-Json
$confVersion = $conf.version

if ($confVersion -ne $listVersion) {
    if (-not $BumpVersion) {
        throw ("Version mismatch: tauri.conf.json says $confVersion, the top of src/changelog.js says $listVersion. " +
               "Add the release you are building to the top of src/changelog.js, then re-run with -BumpVersion.")
    }
    if ([version]$listVersion -lt [version]$confVersion) {
        throw ("src/changelog.js is behind tauri.conf.json ($listVersion < $confVersion). " +
               "Add the new release to the top of the list rather than moving the app's version backwards.")
    }
    # Replace only the version line so the rest of the file keeps its formatting.
    $confRaw = [regex]::Replace(
        $confRaw,
        '("version"\s*:\s*")[^"]*(")',
        ('${1}' + $listVersion + '${2}'),
        [System.Text.RegularExpressions.RegexOptions]::None,
        [TimeSpan]::FromSeconds(5))
    # Write UTF-8 WITHOUT a BOM; Windows PowerShell's `Set-Content -Encoding UTF8`
    # emits a BOM that the Tauri JSON config parser rejects.
    [System.IO.File]::WriteAllText($confPath, $confRaw, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "==> tauri.conf.json moved $confVersion -> $listVersion, from the changelog" -ForegroundColor Cyan
}

$parts = @($listVersion.Split('.'))
while ($parts.Count -lt 3) { $parts += '0' }
$version = "{0}.{1}.{2}.0" -f $parts[0], $parts[1], $parts[2]
Write-Host "==> Package version: $version (release '$listVersion' in src/changelog.js)" -ForegroundColor Cyan

# --- 2. Build -------------------------------------------------------------
# The release notes and version number are the content of this build and
# must already be in src/changelog.js. The checksum cannot go in first: it
# is a hash of the finished exe, and putting it in the frontend would change
# the binary. So: notes first, then this build, then hash that exact file.
# The hash is written into changelog.js afterwards for the repo and for later
# versions. Do not rebuild after that write - a second build would be a
# different binary.
if (-not $SkipBuild) {
    Write-Host "==> Building release exe (tauri build)..." -ForegroundColor Cyan
    Push-Location $repoRoot
    try { npm run build } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed." }
}

# Cargo names the binary after the package (`devhq`), which is not the product
# name; the manifest's Executable= is, so it is copied across under that name.
$exeSource = Join-Path $tauriRoot "target/release/devhq.exe"
if (-not (Test-Path $exeSource)) {
    throw "Release exe not found at $exeSource. Run without -SkipBuild first."
}
$exeChecksum = (Get-FileHash -Path $exeSource -Algorithm SHA256).Hash.ToLowerInvariant()

function Set-ChangelogBuildChecksum([string]$version, [string]$checksum) {
    $raw = [System.IO.File]::ReadAllText($changelogPath)
    $verEsc = [regex]::Escape($version)
    $block = [regex]::Match(
        $raw,
        "(?ms)^\s*\{\s*\r?\n\s*version:\s*`"$verEsc`",.*?^\s*\},",
        [System.Text.RegularExpressions.RegexOptions]::None,
        [TimeSpan]::FromSeconds(5))
    if (-not $block.Success) {
        throw "Release $version not found in $changelogPath."
    }
    $entry = $block.Value
    if ($entry -match '(?m)^\s*buildChecksum:\s*"[^"]*",\s*\r?\n') {
        $entry = [regex]::Replace(
            $entry,
            '(?m)^\s*buildChecksum:\s*"[^"]*",\s*\r?\n',
            "      buildChecksum: `"$checksum`",`r`n",
            [System.Text.RegularExpressions.RegexOptions]::None,
            [TimeSpan]::FromSeconds(5))
    } elseif ($entry -match '(?m)^(\s*title:\s*"[^"]*",\s*\r?\n)') {
        $entry = [regex]::Replace(
            $entry,
            '(?m)^(\s*title:\s*"[^"]*",\s*\r?\n)',
            "`${1}      buildChecksum: `"$checksum`",`r`n",
            [System.Text.RegularExpressions.RegexOptions]::None,
            [TimeSpan]::FromSeconds(5))
    } else {
        throw "Could not place buildChecksum in release $version (no title line)."
    }
    $raw = $raw.Remove($block.Index, $block.Length).Insert($block.Index, $entry)
    [System.IO.File]::WriteAllText($changelogPath, $raw, (New-Object System.Text.UTF8Encoding($false)))
}

Set-ChangelogBuildChecksum $listVersion $exeChecksum
Write-Host "==> Recorded exe SHA-256 in src/changelog.js for $listVersion : $exeChecksum" -ForegroundColor Cyan

# --- 3. Stage layout ------------------------------------------------------
$stage = Join-Path $OutDir "layout"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage "Assets") | Out-Null

Copy-Item $exeSource (Join-Path $stage "DevHQ.exe") -Force

# --- 4. Generate logo assets from icon.png --------------------------------
Add-Type -AssemblyName System.Drawing
$srcIcon = Join-Path $tauriRoot "icons/icon.png"
if (-not (Test-Path $srcIcon)) { throw "Source icon not found: $srcIcon (run `npm run icons`)." }
$src = [System.Drawing.Image]::FromFile($srcIcon)
try {
    $assets = @{
        "Square44x44Logo.png"   = @(44, 44)
        "Square71x71Logo.png"   = @(71, 71)
        "Square150x150Logo.png" = @(150, 150)
        "Square310x310Logo.png" = @(310, 310)
        "Wide310x150Logo.png"   = @(310, 150)
        "StoreLogo.png"         = @(50, 50)
    }
    foreach ($name in $assets.Keys) {
        $w, $h = $assets[$name]
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.Clear([System.Drawing.Color]::Transparent)
        # Fit the square icon centered (handles the wide tile too).
        $scale = [Math]::Min($w / $src.Width, $h / $src.Height)
        $dw = [int]($src.Width * $scale); $dh = [int]($src.Height * $scale)
        $g.DrawImage($src, [int](($w - $dw) / 2), [int](($h - $dh) / 2), $dw, $dh)
        $g.Dispose()
        $bmp.Save((Join-Path $stage "Assets/$name"), [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
    }
} finally { $src.Dispose() }
Write-Host "==> Generated $($assets.Count) logo assets." -ForegroundColor Cyan

# --- 5. Render manifest ---------------------------------------------------
$manifest = Get-Content $templatePath -Raw
$manifest = $manifest.
    Replace("{{IDENTITY_NAME}}", (ConvertTo-XmlText $IdentityName)).
    Replace("{{PUBLISHER}}", (ConvertTo-XmlText $Publisher)).
    Replace("{{PUBLISHER_DISPLAY_NAME}}", (ConvertTo-XmlText $PublisherDisplayName)).
    Replace("{{DISPLAY_NAME}}", (ConvertTo-XmlText $DisplayName)).
    Replace("{{DESCRIPTION}}", (ConvertTo-XmlText $Description)).
    Replace("{{VERSION}}", $version)
Set-Content -Path (Join-Path $stage "AppxManifest.xml") -Value $manifest -Encoding UTF8

if ($IdentityName -eq "Dev.DevHQ" -or $Publisher -eq "CN=DevHQDev") {
    Write-Warning "Using dev identity values. The .msix will build but is NOT submittable until you pass the real Partner Center values."
}

# --- 6. Pack --------------------------------------------------------------
$makeappx = Find-SdkTool "makeappx.exe"
$msixPath = Join-Path $OutDir ("DevHQ_{0}.msix" -f $version)
Write-Host "==> Packing $msixPath ..." -ForegroundColor Cyan
& $makeappx pack /o /d $stage /p $msixPath
if ($LASTEXITCODE -ne 0) { throw "makeappx failed." }

# --- 7. Optional self-sign (local testing only) ---------------------------
if ($SelfSign) {
    Write-Host "==> Self-signing for local install..." -ForegroundColor Cyan
    $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher `
        -KeyUsage DigitalSignature -CertStoreLocation "Cert:\CurrentUser\My" `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
    $signtool = Find-SdkTool "signtool.exe"
    & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint $msixPath
    if ($LASTEXITCODE -ne 0) { throw "signtool failed." }
    Write-Host "Self-signed. To install locally, first trust the cert:" -ForegroundColor Yellow
    Write-Host "  Export it and import into 'Trusted People' (LocalMachine), then: Add-AppxPackage '$msixPath'" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done -> $msixPath" -ForegroundColor Green
if (-not $SelfSign) {
    Write-Host "Submit this UNSIGNED .msix in Partner Center; the Store re-signs it." -ForegroundColor Green
}
