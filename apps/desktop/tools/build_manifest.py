"""CI step: hash the frozen bundle, write + sign manifest.json, stamp the release public key.

Usage (in the release pipeline, after PyInstaller and before code signing the installer):

    python -I tools/build_manifest.py stamp  --src daemon/droplet_daemon/integrity.py --pubkey $RELEASE_PUBKEY_B64
    pyinstaller ...                                                    # produces dist/droplet-daemon/
    python -I tools/build_manifest.py manifest --bundle dist/droplet-daemon \
        --build-id 2026.10.3+win-x64.8f2c1d --version 2026.10.3 --platform win-x64 \
        --signing-key-file /run/secrets/release_ed25519   # in production: an HSM/KMS sign call

Outputs manifest.json + manifest.sig in the bundle and prints the JSON line CI posts to the
cloud release registry (buildId, manifestRoot, manifestSig).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "daemon"))
from droplet_daemon.canonical import canonical_json  # noqa: E402
from droplet_daemon.integrity import MANIFEST_NAME, SIGNATURE_NAME, sha256_file  # noqa: E402

PLACEHOLDER = "__DROPLET_RELEASE_PUBKEY__"


def build_manifest(bundle: Path, build_id: str, version: str, platform: str) -> dict:
    files: dict[str, str] = {}
    for p in sorted(bundle.rglob("*")):
        if p.is_symlink():
            raise SystemExit(f"refusing to sign bundle containing symlink: {p}")
        if p.is_file() and p.name not in (MANIFEST_NAME, SIGNATURE_NAME):
            files[p.relative_to(bundle).as_posix()] = sha256_file(p)
    return {"v": 1, "buildId": build_id, "version": version, "platform": platform, "files": files}


def sign_manifest(bundle: Path, manifest: dict, key: Ed25519PrivateKey) -> dict:
    canonical = canonical_json(manifest).encode("utf-8")
    signature = base64.b64encode(key.sign(canonical)).decode()
    (bundle / MANIFEST_NAME).write_text(canonical.decode("utf-8"), "utf-8")
    (bundle / SIGNATURE_NAME).write_text(signature, "ascii")
    return {
        "buildId": manifest["buildId"],
        "version": manifest["version"],
        "platform": manifest["platform"],
        "manifestRoot": hashlib.sha256(canonical).hexdigest(),
        "manifestSig": signature,
        "fileCount": len(manifest["files"]),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("stamp")
    st.add_argument("--src", type=Path, required=True)
    st.add_argument("--pubkey", required=True)
    mf = sub.add_parser("manifest")
    mf.add_argument("--bundle", type=Path, required=True)
    mf.add_argument("--build-id", required=True)
    mf.add_argument("--version", required=True)
    mf.add_argument("--platform", required=True)
    mf.add_argument("--signing-key-file", type=Path, required=True, help="raw 32-byte Ed25519 seed, base64")
    args = ap.parse_args()

    if args.cmd == "stamp":
        if len(base64.b64decode(args.pubkey)) != 32:
            raise SystemExit("pubkey must be base64 of 32 raw bytes")
        text = args.src.read_text("utf-8")
        if PLACEHOLDER not in text:
            raise SystemExit("placeholder not found (already stamped?)")
        args.src.write_text(text.replace(PLACEHOLDER, args.pubkey), "utf-8")
        return

    key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(args.signing_key_file.read_text().strip()))
    manifest = build_manifest(args.bundle, args.build_id, args.version, args.platform)
    print(json.dumps(sign_manifest(args.bundle, manifest, key)))


if __name__ == "__main__":
    main()
