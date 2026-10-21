"""Runtime integrity verification for the packaged daemon.

Build time (tools/build_manifest.py, in CI):
    every file in the bundle -> sha256 -> manifest.json, signed with the offline release key
    (Ed25519) -> manifest.sig. manifestRoot = sha256(canonical manifest) is registered with
    the cloud release registry.

Run time (here, and independently in the Tauri shell before it spawns us):
    1. verify manifest.sig against the release public key compiled into the build
    2. re-hash every listed file and compare
    3. flag any file present in the bundle that the manifest does not list (injected DLLs,
       sitecustomize.py, .pth files, swapped .pyc)
    Any finding is fatal: the daemon reports it (signed) and exits with EXIT_TAMPER.

This check alone cannot stop an attacker who also patches the checker. It is one layer:
the OS-verified code signature on the shell, the shell's own pre-launch check, and the
server-side manifestRoot comparison during attestation are the others.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .canonical import canonical_json

EXIT_TAMPER = 78  # EX_CONFIG; the shell maps this exit code to the fatal tamper screen

# Replaced at build time by tools/build_manifest.py --stamp. A dev build keeps the placeholder
# and runs in DEV_UNSIGNED mode, which the cloud rejects at attestation (unknown build).
RELEASE_PUBLIC_KEY_B64 = "__DROPLET_RELEASE_PUBKEY__"

MANIFEST_NAME = "manifest.json"
SIGNATURE_NAME = "manifest.sig"
# Files that legitimately change after install and are therefore not covered.
UNTRACKED = {MANIFEST_NAME, SIGNATURE_NAME}
CHUNK = 1024 * 1024


@dataclass(frozen=True)
class Mismatch:
    path: str
    expected: str  # sha256 hex, or "<absent>" for injected files
    actual: str  # sha256 hex, or "<missing>"

    def as_dict(self) -> dict[str, str]:
        return {"path": self.path, "expected": self.expected, "actual": self.actual}


@dataclass
class IntegrityReport:
    build_id: str
    version: str
    manifest_root: str
    signature_valid: bool
    mismatches: list[Mismatch] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.signature_valid and not self.mismatches


class IntegrityError(Exception):
    """Raised when the manifest itself is missing or unreadable."""


def bundle_root() -> Path:
    """Directory of the frozen bundle (PyInstaller onedir) or the source tree in dev."""
    if getattr(sys, "frozen", False):
        # PyInstaller onedir: the exe, _internal/ and manifest.json sit together.
        return Path(sys.executable).resolve().parent
    return Path(os.environ.get("DROPLET_BUNDLE_DIR", Path(__file__).resolve().parent.parent))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def _rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def walk_bundle(root: Path) -> list[Path]:
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d != "__pycache__" or getattr(sys, "frozen", False)]
        for name in filenames:
            p = Path(dirpath) / name
            if p.is_symlink():
                # Symlinks inside a signed bundle are never legitimate; treat as injected.
                files.append(p)
                continue
            if _rel(p, root) not in UNTRACKED:
                files.append(p)
    return files


def verify_bundle(root: Path | None = None, public_key_b64: str = RELEASE_PUBLIC_KEY_B64) -> IntegrityReport:
    root = root or bundle_root()
    manifest_path, sig_path = root / MANIFEST_NAME, root / SIGNATURE_NAME
    if not manifest_path.is_file() or not sig_path.is_file():
        raise IntegrityError("signed manifest missing from bundle")

    manifest = json.loads(manifest_path.read_text("utf-8"))
    canonical = canonical_json(manifest).encode("utf-8")
    report = IntegrityReport(
        build_id=str(manifest["buildId"]),
        version=str(manifest["version"]),
        manifest_root=hashlib.sha256(canonical).hexdigest(),
        signature_valid=_verify_signature(public_key_b64, canonical, sig_path.read_text("ascii").strip()),
    )

    expected: dict[str, str] = manifest["files"]
    seen: set[str] = set()
    for path in walk_bundle(root):
        rel = _rel(path, root)
        seen.add(rel)
        if path.is_symlink():
            report.mismatches.append(Mismatch(rel, expected.get(rel, "<absent>"), "<symlink>"))
            continue
        actual = sha256_file(path)
        want = expected.get(rel)
        if want is None:
            report.mismatches.append(Mismatch(rel, "<absent>", actual))
        elif actual != want:
            report.mismatches.append(Mismatch(rel, want, actual))
    for rel in sorted(set(expected) - seen):
        report.mismatches.append(Mismatch(rel, expected[rel], "<missing>"))
    return report


def _verify_signature(public_key_b64: str, message: bytes, signature_b64: str) -> bool:
    if public_key_b64.startswith("__"):
        return False  # unstamped dev build
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64)).verify(
            base64.b64decode(signature_b64), message
        )
        return True
    except (InvalidSignature, ValueError):
        return False
