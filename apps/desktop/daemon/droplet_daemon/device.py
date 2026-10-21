"""Device identity: Ed25519 keypair protected by the OS + a per-install machine hash.

Windows: the 32-byte seed is stored in %LOCALAPPDATA%/com.droplet.desktop/device.key wrapped with DPAPI
(user scope, fixed entropy), the same format the Rust shell reads for its tamper report.
Other platforms: OS keyring. The private key never touches disk in plaintext and is never sent anywhere. A clean reinstall
wipes the install salt and key, so it produces a new machineHash + keypair and therefore a new
Device row in the cloud; that is what lets recovery tell a clean install from the quarantined one.

Hardening for production: on Windows use a TPM-backed CNG key (Microsoft Platform Crypto
Provider), on macOS a Secure Enclave key with an ACL bound to the signed app's designated
requirement. Generic `keyring` storage is readable by any process running as the same user.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import secrets
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

from .canonical import canonical_json

SERVICE = "droplet-desktop"
DPAPI_ENTROPY = b"droplet-device-key-v1"  # must match attest.rs


def _dpapi(data: bytes, protect: bool) -> bytes:
    import ctypes  # noqa: PLC0415
    from ctypes import wintypes  # noqa: PLC0415

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    def blob(b: bytes) -> Blob:
        buf = ctypes.create_string_buffer(b, len(b))
        return Blob(len(b), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))

    crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
    src, ent, out = blob(data), blob(DPAPI_ENTROPY), Blob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(src), None, ctypes.byref(ent), None, None, 0x1, ctypes.byref(out))  # CRYPTPROTECT_UI_FORBIDDEN
    if not ok:
        raise OSError(ctypes.GetLastError(), "DPAPI call failed")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def _load_seed(key_file: Path, key_name: str) -> bytes | None:
    if platform.system() == "Windows":
        return _dpapi(key_file.read_bytes(), protect=False) if key_file.exists() else None
    import keyring  # noqa: PLC0415

    stored = keyring.get_password(SERVICE, key_name)
    return base64.b64decode(stored) if stored else None


def _store_seed(key_file: Path, key_name: str, seed: bytes) -> None:
    if platform.system() == "Windows":
        key_file.write_bytes(_dpapi(seed, protect=True))
        return
    import keyring  # noqa: PLC0415

    keyring.set_password(SERVICE, key_name, base64.b64encode(seed).decode())


def data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local/share")
    # Kept apart from the install directory (%LOCALAPPDATA%\DROPLET) so reinstalls never touch it.
    d = Path(base) / "com.droplet.desktop"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _machine_id() -> str:
    system = platform.system()
    try:
        if system == "Windows":
            import winreg  # noqa: PLC0415

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography") as k:
                return str(winreg.QueryValueEx(k, "MachineGuid")[0])
        if system == "Darwin":
            out = subprocess.run(
                ["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], capture_output=True, text=True, check=True
            ).stdout
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    return line.split('"')[-2]
        return Path("/etc/machine-id").read_text().strip()
    except Exception:  # noqa: BLE001 - fall back to a stable per-user id
        return str(uuid.getnode())


@dataclass
class DeviceState:
    device_id: str | None
    install_salt: str


class DeviceIdentity:
    def __init__(self, state_file: Path | None = None) -> None:
        self._state_file = state_file or data_dir() / "device.json"
        if self._state_file.exists():
            raw = json.loads(self._state_file.read_text("utf-8"))
            self.state = DeviceState(raw.get("device_id"), raw["install_salt"])
        else:
            self.state = DeviceState(None, secrets.token_hex(32))
            self._save()

    def _save(self) -> None:
        self._state_file.write_text(json.dumps(self.state.__dict__), "utf-8")

    @property
    def key_name(self) -> str:
        return f"device-key:{self.state.install_salt[:16]}"

    @property
    def machine_hash(self) -> str:
        return hashlib.sha256(f"{_machine_id()}|{self.state.install_salt}".encode()).hexdigest()

    @property
    def key_file(self) -> Path:
        return self._state_file.with_name("device.key")

    def _private_key(self, create: bool = False) -> Ed25519PrivateKey:
        seed = _load_seed(self.key_file, self.key_name)
        if seed:
            return Ed25519PrivateKey.from_private_bytes(seed)
        if not create:
            raise RuntimeError("device key missing - device must re-enroll")
        key = Ed25519PrivateKey.generate()
        _store_seed(self.key_file, self.key_name, key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()))
        return key

    @property
    def enrolled(self) -> bool:
        return bool(self.state.device_id)

    def public_key_b64(self, create: bool = False) -> str:
        pub = self._private_key(create).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        return base64.b64encode(pub).decode()

    def sign(self, payload: dict) -> dict:
        """Returns the wire envelope {payload, signature} over canonical JSON."""
        sig = self._private_key().sign(canonical_json(payload).encode("utf-8"))
        return {"payload": payload, "signature": base64.b64encode(sig).decode()}

    def reset(self) -> None:
        """Drop this install's identity: new salt (so a new machineHash), no key, not enrolled."""
        self.key_file.unlink(missing_ok=True)
        self.state = DeviceState(None, secrets.token_hex(32))
        self._save()

    def set_device_id(self, device_id: str) -> None:
        self.state.device_id = device_id
        self._save()

    @staticmethod
    def now() -> int:
        return int(time.time())
