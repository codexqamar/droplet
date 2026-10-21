"""Isolated local account profiles and active-account selection."""

from __future__ import annotations

import json
import os
import shutil
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path

from .cloud import CloudClient, Offline
from .device import DeviceIdentity
from .store import Store


@dataclass
class Profile:
    id: str
    label: str
    root: Path
    device: DeviceIdentity
    store: Store
    cloud: CloudClient


class ProfileManager:
    def __init__(self, root: Path, api: str) -> None:
        self._root = root
        self._api = api
        self._registry = root / "profiles.json"
        self._lock = threading.RLock()
        raw = self._read_registry()
        self._active_id = raw["active"]
        # App lock survives restarts: closing and reopening DROPLET does not unlock it.
        self._locked = bool(raw.get("locked", False))
        self._profiles = {p["id"]: self._open(p["id"], p.get("label", "This computer")) for p in raw["profiles"]}

    def _read_registry(self) -> dict:
        if self._registry.exists():
            return json.loads(self._registry.read_text("utf-8"))
        # The original single-account files remain the primary profile, so upgrades preserve
        # identity, cached orders and offline data without migration risk.
        raw = {"active": "primary", "profiles": [{"id": "primary", "label": "This computer"}]}
        self._write_registry(raw)
        return raw

    def _write_registry(self, raw: dict) -> None:
        tmp = self._registry.with_suffix(".tmp")
        tmp.write_text(json.dumps(raw, indent=2), "utf-8")
        os.replace(tmp, self._registry)

    def _profile_root(self, profile_id: str) -> Path:
        path = self._root if profile_id == "primary" else self._root / "profiles" / profile_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _open(self, profile_id: str, label: str) -> Profile:
        root = self._profile_root(profile_id)
        device = DeviceIdentity(root / "device.json")
        store = Store(root / "cache.db")
        return Profile(profile_id, label, root, device, store, CloudClient(self._api, device, store))

    @property
    def active(self) -> Profile:
        with self._lock:
            return self._profiles[self._active_id]

    def _save(self) -> None:
        self._write_registry({
            "active": self._active_id,
            "locked": self._locked,
            "profiles": [{"id": p.id, "label": p.label} for p in self._profiles.values()],
        })

    def list(self) -> list[dict]:
        with self._lock:
            result = []
            for p in self._profiles.values():
                snapshot = p.store.get("snapshot", {}) or {}
                account = {**(snapshot.get("account") or {}), **(p.store.get("profile_account", {}) or {})}
                result.append({
                    "id": p.id,
                    "active": p.id == self._active_id,
                    "enrolled": p.device.enrolled,
                    "deviceId": p.device.state.device_id,
                    "label": p.label,
                    "legalName": account.get("legalName"),
                    "code": account.get("code"),
                    "status": account.get("status"),
                })
            return result

    def enroll_active(self, enrollment_code: str, label: str, report) -> str:
        with self._lock:
            p = self.active
            device_id = p.cloud.enroll(enrollment_code, label, report)
            p.cloud.sync(report)
            p.label = label
            self._save()
            return device_id

    def add(self, enrollment_code: str, label: str, report) -> str:
        with self._lock:
            profile_id = uuid.uuid4().hex
            p = self._open(profile_id, label)
            try:
                device_id = p.cloud.enroll(enrollment_code, label, report)
                p.cloud.sync(report)
            except Exception:
                p.store.close()
                shutil.rmtree(p.root, ignore_errors=True)
                raise
            self._profiles[profile_id] = p
            self._active_id = profile_id
            self._save()
            return device_id

    @property
    def locked(self) -> bool:
        return self._locked

    def set_locked(self, locked: bool) -> None:
        with self._lock:
            self._locked = locked
            self._save()

    def forget(self, profile_id: str) -> bool:
        """Removes a profile from this computer. The primary profile is reset (identity + cache
        wiped) rather than deleted, so the next enrollment starts clean."""
        with self._lock:
            p = self._profiles.get(profile_id)
            if not p:
                return False
            if profile_id == "primary":
                p.device.reset()
                p.store.reset()
            else:
                p.store.close()
                p.device.reset()
                del self._profiles[profile_id]
                shutil.rmtree(p.root, ignore_errors=True)
            if self._active_id not in self._profiles or not self._profiles[self._active_id].device.enrolled:
                live = [x.id for x in self._profiles.values() if x.device.enrolled]
                self._active_id = live[0] if live else "primary"
            self._save()
            return True

    def reconcile(self) -> None:
        """Mirrors the web portal: profiles whose account or device no longer exists are removed,
        names are refreshed. Offline leaves everything as is (the cached data stays usable)."""
        with self._lock:
            for p in list(self._profiles.values()):
                if not p.device.enrolled:
                    if p.id != "primary":
                        self.forget(p.id)
                    continue
                try:
                    status = p.cloud.status()
                except Offline:
                    return
                except Exception:  # noqa: BLE001 - a flaky check must never block startup
                    continue
                if status.get("state") == "GONE":
                    self.forget(p.id)
                    continue
                account = status.get("account") or {}
                if account.get("legalName"):
                    p.store.put("profile_account", account)
            self._save()

    def activate(self, profile_id: str) -> None:
        with self._lock:
            if profile_id not in self._profiles or not self._profiles[profile_id].device.enrolled:
                raise KeyError(profile_id)
            self._active_id = profile_id
            self._save()
