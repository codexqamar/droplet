# DROPLET desktop release build (Windows).
#
#   1. release signing key (dev: generated into .keys/; production: DROPLET_RELEASE_KEY from a
#      secret store / KMS, or -ReleaseKeyFile on removable or mounted storage; never in the repo)
#   2. stage the daemon source and stamp the release public key into the staged copy
#   3. PyInstaller onedir bundle
#   4. hash + sign the bundle manifest
#   5. build the desktop UI (apps/web in desktop mode)
#   6. tauri build -> NSIS installer (shell embeds the release public key)
#   7. register the build + installer with the cloud release registry
#
# Windows code signing (Authenticode, so SmartScreen trusts the installer):
#   -SignThumbprint <sha1>    certificate in the Windows store (EV/OV token or HSM-backed cert)
#   -SignCommand "<cmd> %1"   any signer, e.g. Azure Trusted Signing:
#        "trusted-signing-cli -e https://weu.codesigning.azure.net -a <acct> -c <profile> %1"
#   (or env DROPLET_SIGN_THUMBPRINT / DROPLET_SIGN_COMMAND). The app, the local engine, the
#   installer and the uninstaller are all signed; -Production refuses to build without it.
#
# Usage:  npm run build            (from apps/desktop)
#         npm run build -- -Production -Api https://portal.example.com -RegisterUrl https://portal.example.com -OpsToken <token>
param(
  # Cloud API the desktop app talks to (baked into the build). For production use your portal
  # address, e.g. -Api https://portal.example.com
  [string]$Api = "http://localhost:8080",
  # Publish to a deployed install instead of the local dev database:
  #   -RegisterUrl https://portal.example.com -OpsToken <DROPLET_OPS_TOKEN>
  [string]$RegisterUrl = "",
  [string]$OpsToken = "",
  # Release signing key outside the repo and build machine (e.g. a mounted secret or encrypted
  # USB). DROPLET_RELEASE_KEY (base64 seed from a secret store) takes priority over a file.
  [string]$ReleaseKeyFile = $env:DROPLET_RELEASE_KEY_FILE,
  [string]$SignThumbprint = $env:DROPLET_SIGN_THUMBPRINT,
  [string]$SignCommand = $env:DROPLET_SIGN_COMMAND,
  [string]$TimestampUrl = "http://timestamp.digicert.com",
  # Production release: requires a code-signing method and a release key that is not the dev key.
  [switch]$Production,
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
# Where the Ed25519 release key comes from, most to least preferred.
if ($env:DROPLET_RELEASE_KEY) {
  $keyArgs = @("--signing-key-env", "DROPLET_RELEASE_KEY")
  Write-Host "Release key: DROPLET_RELEASE_KEY (secret store; not written to disk)"
} elseif ($ReleaseKeyFile) {
  if (-not (Test-Path $ReleaseKeyFile)) { throw "Release key file not found: $ReleaseKeyFile" }
  $keyArgs = @("--signing-key-file", $ReleaseKeyFile)
  Write-Host "Release key: $ReleaseKeyFile"
} else {
  if ($Production) { throw "-Production needs DROPLET_RELEASE_KEY or -ReleaseKeyFile; the dev key in .keys/ is for local builds only." }
  New-Item -ItemType Directory -Force $keys | Out-Null
  $seedFile = Join-Path $keys "release_ed25519.seed"
  if (-not (Test-Path $seedFile)) {
    & $py -I -c "import base64,os,sys; open(sys.argv[1],'w').write(base64.b64encode(os.urandom(32)).decode())" $seedFile
    Check "key generation"
    Write-Host "Generated dev release key at $seedFile"
  }
  $keyArgs = @("--signing-key-file", $seedFile)
  Write-Warning "Using the development release key in .keys/. For customer releases keep the key off this machine (DROPLET_RELEASE_KEY or -ReleaseKeyFile)."
}
$pubScript = "import base64,os,sys; from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as K; from cryptography.hazmat.primitives.serialization import Encoding as E, PublicFormat as P; s=os.environ[sys.argv[2]] if sys.argv[1]=='--signing-key-env' else open(sys.argv[2]).read(); k=K.from_private_bytes(base64.b64decode(s.strip())); print(base64.b64encode(k.public_key().public_bytes(E.Raw,P.Raw)).decode())"
$pub = & $py -I -c $pubScript @keyArgs
Check "public key derivation"
$pub = $pub.Trim()

Step "Code signing"
function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  $found = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match "\\x64\\" } | Sort-Object FullName -Descending | Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}
$signing = $null
if ($SignCommand) {
  $signing = "command"
  Write-Host "Code signing: custom command"
} elseif ($SignThumbprint) {
  $signTool = Find-SignTool
  if (-not $signTool) { throw "signtool.exe not found. Install the Windows 10/11 SDK (Signing Tools for Desktop Apps)." }
  $signing = "thumbprint"
  Write-Host "Code signing: certificate $SignThumbprint via $signTool"
} elseif ($Production) {
  throw "-Production needs a code-signing certificate (-SignThumbprint or -SignCommand). Unsigned installers trigger SmartScreen warnings."
} else {
  Write-Warning "No code-signing certificate configured: the installer will be unsigned (SmartScreen will warn). See the header of this script."
}
function Sign-File($path) {
  if ($signing -eq "command") {
    $line = $SignCommand.Replace("%1", "`"$path`"")
    cmd /c $line
    Check "sign $(Split-Path $path -Leaf)"
  } elseif ($signing -eq "thumbprint") {
    & $signTool sign /sha1 $SignThumbprint /fd sha256 /tr $TimestampUrl /td sha256 /d "DROPLET" $path
    Check "sign $(Split-Path $path -Leaf)"
  }
}

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
# Sign the engine before the manifest is hashed: the signature becomes part of the signed file set.
if ($signing) { Sign-File (Join-Path $dist "droplet-daemon\droplet-daemon.exe") }

Step "Sign bundle manifest"
$info = Join-Path $build "manifest-info.json"
& $py -I (Join-Path $root "tools\build_manifest.py") manifest --bundle (Join-Path $dist "droplet-daemon") `
  --build-id $buildId --version $version --platform win-x64 @keyArgs | Out-File -Encoding ascii $info
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
# Tauri signs the app exe, the NSIS installer and its uninstaller with the same method.
$tauriArgs = @("tauri", "build", "--bundles", "nsis")
if ($signing -eq "thumbprint") {
  $cfg = @{ bundle = @{ windows = @{ certificateThumbprint = $SignThumbprint; digestAlgorithm = "sha256"; timestampUrl = $TimestampUrl } } } | ConvertTo-Json -Depth 5 -Compress
  $cfgFile = Join-Path $build "tauri.sign.json"
  $cfg | Out-File -Encoding ascii $cfgFile
  $tauriArgs += @("--config", $cfgFile)
} elseif ($signing -eq "command") {
  $cfg = @{ bundle = @{ windows = @{ signCommand = $SignCommand } } } | ConvertTo-Json -Depth 5 -Compress
  $cfgFile = Join-Path $build "tauri.sign.json"
  $cfg | Out-File -Encoding ascii $cfgFile
  $tauriArgs += @("--config", $cfgFile)
}
Push-Location $root
npx @tauriArgs
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

if ($signing) {
  Step "Verify signatures"
  foreach ($f in @((Join-Path $root "src-tauri\target\release\droplet.exe"), (Join-Path $dist "droplet-daemon\droplet-daemon.exe"), $installer.FullName)) {
    $sig = Get-AuthenticodeSignature $f
    if ($sig.Status -ne "Valid") { throw "$(Split-Path $f -Leaf) is not validly signed: $($sig.Status) $($sig.StatusMessage)" }
    Write-Host "Signed OK: $(Split-Path $f -Leaf) ($($sig.SignerCertificate.Subject))"
  }
}

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
