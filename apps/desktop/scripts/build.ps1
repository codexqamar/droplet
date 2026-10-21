# DROPLET desktop release build (Windows).
#
#   1. release signing key (dev: generated into .keys/, production: HSM/KMS)
#   2. stage the daemon source and stamp the release public key into the staged copy
#   3. PyInstaller onedir bundle
#   4. hash + sign the bundle manifest
#   5. build the desktop UI (apps/web in desktop mode)
#   6. tauri build -> NSIS installer (shell embeds the release public key)
#   7. register the build + installer with the cloud release registry
#
# Usage:  npm run build            (from apps/desktop)
param(
  # Cloud API the desktop app talks to (baked into the build). For production use your portal
  # address, e.g. -Api https://portal.example.com
  [string]$Api = "http://localhost:8080",
  # Publish to a deployed install instead of the local dev database:
  #   -RegisterUrl https://portal.example.com -OpsToken <DROPLET_OPS_TOKEN>
  [string]$RegisterUrl = "",
  [string]$OpsToken = "",
  [switch]$SkipRegister
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$repo = Resolve-Path (Join-Path $root "..\..")
$daemon = Join-Path $root "daemon"
$py = Join-Path $daemon ".venv\Scripts\python.exe"
$build = Join-Path $root "build"
$keys = Join-Path $root ".keys"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

$version = (Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version
$buildId = "$version+win-x64.$(Get-Date -Format 'yyyyMMddHHmm')"

Step "Python build environment"
if (-not (Test-Path $py)) { python -m venv (Join-Path $daemon ".venv"); Check "venv" }
& $py -m pip install --quiet --disable-pip-version-check "fastapi==0.115.4" "uvicorn==0.32.0" "httpx==0.27.2" cryptography pyinstaller pytest
Check "pip install"

Step "Release signing key"
New-Item -ItemType Directory -Force $keys | Out-Null
$seedFile = Join-Path $keys "release_ed25519.seed"
if (-not (Test-Path $seedFile)) {
  & $py -I -c "import base64,os,sys; open(sys.argv[1],'w').write(base64.b64encode(os.urandom(32)).decode())" $seedFile
  Check "key generation"
  Write-Host "Generated dev release key at $seedFile (production: keep this in an HSM)"
}
$pub = & $py -I -c "import base64,sys; from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as K; from cryptography.hazmat.primitives.serialization import Encoding as E, PublicFormat as P; k=K.from_private_bytes(base64.b64decode(open(sys.argv[1]).read().strip())); print(base64.b64encode(k.public_key().public_bytes(E.Raw,P.Raw)).decode())" $seedFile
Check "public key derivation"
$pub = $pub.Trim()

Step "Daemon tests"
Push-Location $daemon
& $py -m pytest -q
Check "pytest"
Pop-Location

Step "Stage + stamp daemon source"
$stage = Join-Path $build "stage"
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item -Recurse (Join-Path $daemon "droplet_daemon") (Join-Path $stage "droplet_daemon")
Copy-Item (Join-Path $daemon "run_daemon.py") $stage
Get-ChildItem -Recurse -Directory -Filter __pycache__ $stage | Remove-Item -Recurse -Force
& $py -I (Join-Path $root "tools\build_manifest.py") stamp --src (Join-Path $stage "droplet_daemon\integrity.py") --pubkey $pub
Check "stamp"

Step "PyInstaller bundle"
$dist = Join-Path $daemon "dist"
if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
& $py -m PyInstaller --noconfirm --clean --onedir --console --name droplet-daemon `
  --distpath $dist --workpath (Join-Path $build "pyi") --specpath $build `
  --paths $stage --collect-submodules uvicorn --collect-submodules droplet_daemon `
  --icon (Join-Path $root "src-tauri\icons\icon.ico") `
  (Join-Path $stage "run_daemon.py")
Check "pyinstaller"

Step "Sign bundle manifest"
$info = Join-Path $build "manifest-info.json"
& $py -I (Join-Path $root "tools\build_manifest.py") manifest --bundle (Join-Path $dist "droplet-daemon") `
  --build-id $buildId --version $version --platform win-x64 --signing-key-file $seedFile | Out-File -Encoding ascii $info
Check "manifest"
Get-Content $info

Step "Desktop UI"
npm --prefix (Join-Path $repo "apps\web") run build:desktop
Check "web build"

Step "App icons"
# Always regenerate from assets/icon.svg so the exe, installer, shortcuts and favicon match.
Push-Location $root
npm run icons
Check "icons"
Pop-Location
# Cargo does not track icon files: drop the crate's build-script output so the Windows
# resource (exe icon + version info) is re-embedded on every release build.
Get-ChildItem (Join-Path $root "src-tauri\target\release\build") -Directory -Filter "droplet-desktop-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
(Get-Item (Join-Path $root "src-tauri\build.rs")).LastWriteTime = Get-Date

Step "Tauri shell + NSIS installer"
$env:DROPLET_RELEASE_PUBKEY = $pub
$env:DROPLET_API = $Api
Push-Location $root
npx tauri build --bundles nsis
Check "tauri build"
Pop-Location

Step "Verify exe icon"
# Fail the build if Windows would show a blank or generic icon for the app exe.
Add-Type -AssemblyName System.Drawing
function Assert-DropletIcon($path) {
  $bmp = [System.Drawing.Icon]::ExtractAssociatedIcon($path).ToBitmap()
  $blue = 0
  for ($x = 0; $x -lt $bmp.Width; $x++) { for ($y = 0; $y -lt $bmp.Height; $y++) {
    $c = $bmp.GetPixel($x, $y); if ($c.A -gt 200 -and $c.B -gt 180 -and $c.R -lt 90) { $blue++ } } }
  if ($blue -lt ($bmp.Width * $bmp.Height * 0.25)) { throw "$(Split-Path $path -Leaf) has no DROPLET icon (blue pixels: $blue)" }
  Write-Host "Icon OK: $(Split-Path $path -Leaf) ($blue blue px of $($bmp.Width * $bmp.Height))"
}
# The app and the bundled local engine must both carry the DROPLET icon.
Assert-DropletIcon (Join-Path $root "src-tauri\target\release\droplet.exe")
Assert-DropletIcon (Join-Path $dist "droplet-daemon\droplet-daemon.exe")

$installer = Get-ChildItem (Join-Path $root "src-tauri\target\release\bundle\nsis\*.exe") | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "Installer: $($installer.FullName)"
Assert-DropletIcon $installer.FullName

if ($SkipRegister) {
  Write-Host "Skipping release registration."
} elseif ($RegisterUrl) {
  Step "Publish release to $RegisterUrl"
  if (-not $OpsToken) { throw "-OpsToken is required with -RegisterUrl (the server's DROPLET_OPS_TOKEN)" }
  $infoB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($info))
  $resp = Invoke-WebRequest -Method Put -Uri ($RegisterUrl.TrimEnd('/') + "/v1/ops/releases") `
    -Headers @{ Authorization = "Bearer $OpsToken"; "x-release-info" = $infoB64; "x-release-filename" = $installer.Name } `
    -ContentType "application/octet-stream" -InFile $installer.FullName -UseBasicParsing
  Write-Host "Published: $($resp.Content)"
} else {
  Step "Register release with the local cloud"
  npm --prefix (Join-Path $repo "apps\cloud-api") run register-release -- $info $installer.FullName
  Check "register-release"
}
Write-Host "`nDone. Build $buildId" -ForegroundColor Green
