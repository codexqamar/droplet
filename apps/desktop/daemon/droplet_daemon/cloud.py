"""Client for the DROPLET cloud API: enrollment, attestation handshake, explicit sync."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import httpx

from .device import DeviceIdentity
from .integrity import IntegrityReport
from .store import Store

log = logging.getLogger("droplet.cloud")


class CloudError(Exception):
    code = "CLOUD_ERROR"


class TamperLockout(CloudError):
    """Cloud confirmed tamper (423 TAMPER_DETECTED) - the daemon must halt."""

    code = "TAMPER_DETECTED"


class AccountLocked(CloudError):
    """Account is in a security lock state; sync is unavailable until recovery completes."""

    code = "ACCOUNT_SECURITY_LOCK"


class DeviceRevoked(CloudError):
    """This install's certificate was revoked (e.g. after a tamper incident). Must re-enroll."""

    code = "DEVICE_REVOKED"


class AccountSuspended(CloudError):
    """The trade account exists but is suspended on the web portal; no sync until reactivated."""

    code = "ACCOUNT_SUSPENDED"


class UnlockFailed(CloudError):
    code = "UNLOCK_FAILED"

    def __init__(self, reason: str, status: int) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


class UpdateRequired(CloudError):
    code = "UPDATE_REQUIRED"


class Offline(CloudError):
    code = "OFFLINE"


class EnrollmentFailed(CloudError):
    code = "ENROLLMENT_FAILED"


@dataclass
class SyncSummary:
    pulled: int
    pushed: list[dict]


def _detail(r: httpx.Response) -> str:
    try:
        body = r.json()
        return str(body.get("error") or body)
    except ValueError:
        return r.text[:200]


class CloudClient:
    def __init__(self, base_url: str, device: DeviceIdentity, store: Store) -> None:
        self._http = httpx.Client(base_url=base_url, timeout=20.0, verify=True)
        self._device = device
        self._store = store
        self._sync_token: str | None = None

    def _call(self, method: str, url: str, **kw) -> httpx.Response:
        try:
            return self._http.request(method, url, **kw)
        except httpx.TransportError as e:
            raise Offline(str(e)) from e

    # ── enrollment ──
    def enroll(self, enrollment_code: str, label: str, report: IntegrityReport) -> str:
        payload = {
            "v": 1,
            "kind": "enroll",
            "enrollmentCode": enrollment_code.strip(),
            "publicKey": self._device.public_key_b64(create=True),
            "machineHash": self._device.machine_hash,
            "buildId": report.build_id,
            "manifestRoot": report.manifest_root,
            "label": label,
            "ts": self._device.now(),
        }
        r = self._call("POST", "/v1/devices/enroll", json=self._device.sign(payload))
        if r.status_code >= 400:
            raise EnrollmentFailed(_detail(r))
        device_id = r.json()["deviceId"]
        self._device.set_device_id(device_id)
        return device_id

    # ── attestation handshake ──
    def attest(self, report: IntegrityReport, reporter: str = "daemon") -> str:
        """challenge -> signed report -> sync token. Raises on lock/tamper/revocation."""
        device_id = self._device.state.device_id
        if not device_id:
            raise DeviceRevoked("device not enrolled")
        r = self._call("POST", f"/v1/devices/{device_id}/challenge")
        if r.status_code == 404:
            raise DeviceRevoked("unknown device")
        r.raise_for_status()
        payload = {
            "v": 1,
            "kind": "attest",
            "deviceId": device_id,
            "nonce": r.json()["nonce"],
            "buildId": report.build_id,
            "manifestRoot": report.manifest_root,
            "machineHash": self._device.machine_hash,
            "reporter": reporter,
            "mismatches": [m.as_dict() for m in report.mismatches],
            "ts": self._device.now(),
        }
        r = self._call("POST", "/v1/attest", json=self._device.sign(payload))
        self._raise_for_status(r)
        self._sync_token = r.json()["syncToken"]
        return self._sync_token

    @staticmethod
    def _raise_for_status(r: httpx.Response) -> None:
        if r.status_code < 400:
            return
        detail = _detail(r)
        if r.status_code == 423:
            raise TamperLockout(detail) if detail == "TAMPER_DETECTED" else AccountLocked(detail)
        if r.status_code == 426:
            raise UpdateRequired(detail)
        if r.status_code == 403 and detail == "ACCOUNT_SUSPENDED":
            raise AccountSuspended(detail)
        if r.status_code == 403 and detail == "DEVICE_REVOKED":
            raise DeviceRevoked(detail)
        if r.status_code in (401, 403):
            raise AccountLocked(detail)
        r.raise_for_status()

    # ── explicit sync ──
    def sync(self, report: IntegrityReport) -> SyncSummary:
        """Session-scoped reconciliation: re-attest, pull catalogue deltas, push queued orders,
        then refresh the account snapshot (orders, credit, statement)."""
        self.attest(report)
        headers = {"Authorization": f"Bearer {self._sync_token}"}

        pulled, cursor, has_more = 0, self._store.cursor("catalogue"), True
        while has_more:
            r = self._call("POST", "/v1/sync/pull", json={"stream": "catalogue", "since": cursor}, headers=headers)
            self._raise_for_status(r)
            body = r.json()
            # Rows and cursor commit atomically, so an interrupted sync resumes cleanly.
            self._store.apply_catalogue(body["rows"], body["nextCursor"])
            cursor, has_more = body["nextCursor"], body["hasMore"]
            pulled += len(body["rows"])

        pushed: list[dict] = []
        queued = self._store.queued()
        if queued:
            orders = []
            for d in queued:
                o = {"clientRef": d["client_ref"], "submit": True, "lines": d["lines"]}
                if d["po_number"]:
                    o["poNumber"] = d["po_number"]
                orders.append(o)
            r = self._call("POST", "/v1/sync/push", json={"orders": orders}, headers=headers)
            self._raise_for_status(r)
            for result in r.json()["results"]:
                self._store.record_push_result(result)
                pushed.append(result)

        r = self._call("GET", "/v1/sync/snapshot", headers=headers)
        self._raise_for_status(r)
        self._store.put("snapshot", r.json())
        self._store.put("last_sync_at", int(time.time() * 1000))
        return SyncSummary(pulled=pulled, pushed=pushed)

    def unlock(self, password: str, totp: str | None) -> dict:
        """App-lock check against the cloud: device owner's password, then authenticator code.
        Signed with the device key and a fresh nonce. Returns {"mfaRequired": True} or {"ok": True}."""
        device_id = self._device.state.device_id
        if not device_id:
            raise DeviceRevoked("device not enrolled")
        r = self._call("POST", f"/v1/devices/{device_id}/challenge")
        if r.status_code == 404:
            raise DeviceRevoked("unknown device")
        r.raise_for_status()
        payload = {"v": 1, "kind": "unlock", "deviceId": device_id, "nonce": r.json()["nonce"], "ts": self._device.now(), "password": password}
        if totp:
            payload["totp"] = totp
        r = self._call("POST", "/v1/devices/unlock", json=self._device.sign(payload))
        if r.status_code >= 400:
            detail = _detail(r)
            if r.status_code == 403 and detail == "DEVICE_REVOKED":
                raise DeviceRevoked(detail)
            raise UnlockFailed(detail, r.status_code)
        return r.json()

    def status(self) -> dict:
        """Asks the cloud whether this install's account still exists (signed, short timeout).
        Returns {"state": ACTIVE|SUSPENDED|LOCKED|GONE, "account": {...}}; raises Offline."""
        device_id = self._device.state.device_id
        if not device_id:
            return {"state": "GONE"}
        payload = {"v": 1, "kind": "status", "deviceId": device_id, "ts": self._device.now()}
        try:
            signed = self._device.sign(payload)
        except RuntimeError:
            return {"state": "GONE"}  # key missing: this profile can never authenticate again
        r = self._call("POST", "/v1/devices/status", json=signed, timeout=6.0)
        if r.status_code == 401:
            return {"state": "GONE"}
        r.raise_for_status()
        return r.json()

    def request_quote(self, report: IntegrityReport, lines: list[dict], notes: str | None) -> dict:
        self.attest(report)
        r = self._call(
            "POST",
            "/v1/sync/quotes",
            json={"lines": lines, "notes": notes},
            headers={"Authorization": f"Bearer {self._sync_token}"},
        )
        self._raise_for_status(r)
        return r.json()
