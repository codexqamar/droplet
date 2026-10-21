"""Local listen server consumed by the Tauri UI over 127.0.0.1.

Only the shell that spawned us may talk to us: every request must carry the per-launch secret
(passed via env, never on argv) and a Host header of 127.0.0.1:<port>, which defeats both other
local processes guessing the port and browser DNS-rebinding attacks.
"""

from __future__ import annotations

import hmac
import logging
import os
import threading

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .cloud import AccountSuspended, UnlockFailed, CloudClient, CloudError, DeviceRevoked, Offline, TamperLockout, UpdateRequired
from .integrity import EXIT_TAMPER, IntegrityReport

log = logging.getLogger("droplet.daemon")


class LineIn(BaseModel):
    sku: str = Field(min_length=1, max_length=64)
    qty: int = Field(gt=0, le=1_000_000)


class OrderIn(BaseModel):
    lines: list[LineIn] = Field(min_length=1, max_length=500)
    poNumber: str | None = Field(default=None, max_length=64)  # noqa: N815 - wire format
    mode: str = Field(default="submit", pattern="^(submit|draft)$")


class QuoteIn(BaseModel):
    lines: list[LineIn] = Field(min_length=1, max_length=500)
    notes: str | None = Field(default=None, max_length=2000)


class UnlockIn(BaseModel):
    password: str = Field(min_length=1, max_length=512)
    totp: str | None = Field(default=None, pattern=r"^\d{6}$")


class EnrollIn(BaseModel):
    enrollment_code: str = Field(min_length=10)
    label: str = Field(min_length=1, max_length=120)


class ActivateIn(BaseModel):
    profile_id: str = Field(min_length=1, max_length=64)


def halt_for_tamper(reason: object) -> None:
    log.critical("integrity failure, halting: %s", reason)
    # Give the response a moment to flush, then hard-exit so no further local requests are served.
    threading.Timer(0.3, lambda: os._exit(EXIT_TAMPER)).start()


STATUS = {"ACCOUNT_SUSPENDED": 403, "TAMPER_DETECTED": 423, "ACCOUNT_SECURITY_LOCK": 423, "DEVICE_REVOKED": 403, "UPDATE_REQUIRED": 426, "OFFLINE": 503}


def create_app(*, profiles, report: IntegrityReport, launch_secret: str, port: int) -> FastAPI:
    app = FastAPI(title="droplet-daemon", docs_url=None, redoc_url=None, openapi_url=None)
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    def guard(request: Request, x_droplet_launch: str = Header(default="")) -> None:
        if request.headers.get("host") not in allowed_hosts:
            raise HTTPException(403, "bad host")
        if not hmac.compare_digest(x_droplet_launch.encode(), launch_secret.encode()):
            raise HTTPException(401, "bad launch secret")

    @app.exception_handler(CloudError)
    def cloud_error(_req: Request, exc: CloudError) -> JSONResponse:
        if isinstance(exc, TamperLockout):
            halt_for_tamper(exc)
        if isinstance(exc, DeviceRevoked):
            # The web portal no longer recognises this account on this computer: drop the
            # profile (the primary one is reset so a clean enrollment gets a new identity).
            profiles.forget(profiles.active.id)
        return JSONResponse({"error": exc.code, "detail": str(exc)}, status_code=STATUS.get(exc.code, 502))

    deps = [Depends(guard)]

    def unlocked() -> None:
        # Enforced here, not just in the UI: a locked app serves no trade data or actions.
        if profiles.locked:
            raise HTTPException(423, "APP_LOCKED")

    trade = [Depends(guard), Depends(unlocked)]

    @app.post("/v1/lock", dependencies=deps)
    def lock() -> dict:
        profiles.set_locked(True)
        return {"locked": True}

    @app.post("/v1/unlock", dependencies=deps)
    def unlock(body: UnlockIn) -> dict:
        p = profiles.active
        if not p.device.enrolled:
            profiles.set_locked(False)  # nothing to protect: no account on this computer
            return {"ok": True}
        try:
            result = p.cloud.unlock(body.password, body.totp)
        except UnlockFailed as e:
            raise HTTPException(e.status if e.status in (401, 403, 429) else 502, e.reason) from None
        if result.get("ok"):
            profiles.set_locked(False)
        return result

    @app.get("/v1/state", dependencies=deps)
    def state() -> dict:
        # Accounts shown on desktop mirror the web portal: dead profiles are dropped here.
        profiles.reconcile()
        p = profiles.active
        return {
            "enrolled": p.device.enrolled,
            "deviceId": p.device.state.device_id,
            "activeProfileId": p.id,
            "accounts": profiles.list(),
            "build": report.build_id,
            "version": report.version,
            "integrity": "ok" if report.ok else "failed",
            "lastSyncAt": p.store.get("last_sync_at"),
            "locked": profiles.locked,
            "owner": ((p.store.get("snapshot") or {}).get("account") or {}).get("user"),
        }

    @app.post("/v1/enroll", dependencies=deps)
    def enroll(body: EnrollIn) -> dict:
        device_id = profiles.enroll_active(body.enrollment_code, body.label, report)
        return {"deviceId": device_id}

    @app.post("/v1/accounts", dependencies=trade)
    def add_account(body: EnrollIn) -> dict:
        return {"deviceId": profiles.add(body.enrollment_code, body.label, report)}

    @app.post("/v1/accounts/activate", dependencies=trade)
    def activate_account(body: ActivateIn) -> dict:
        try:
            profiles.activate(body.profile_id)
        except KeyError:
            raise HTTPException(404, "ACCOUNT_PROFILE_NOT_FOUND") from None
        return {"ok": True}

    @app.delete("/v1/accounts/{profile_id}", dependencies=trade)
    def remove_account(profile_id: str) -> dict:
        if not profiles.forget(profile_id):
            raise HTTPException(404, "ACCOUNT_PROFILE_NOT_FOUND")
        return {"ok": True}

    @app.post("/v1/sync", dependencies=trade)
    def sync() -> dict:
        p = profiles.active
        summary = p.cloud.sync(report)
        return {"pulled": summary.pulled, "pushed": summary.pushed, "lastSyncAt": p.store.get("last_sync_at")}

    @app.get("/v1/dashboard", dependencies=trade)
    def dashboard() -> dict:
        store = profiles.active.store
        snapshot = store.get("snapshot")
        if not snapshot:
            raise HTTPException(409, "NOT_SYNCED")
        return {**snapshot, "catalogue": store.catalogue(), "lastSyncAt": store.get("last_sync_at")}

    @app.get("/v1/sku/{sku}", dependencies=trade)
    def sku(sku: str) -> dict:
        store = profiles.active.store
        item = store.lookup_sku(sku)
        if not item:
            raise HTTPException(404, "unknown sku")
        return item

    @app.post("/v1/orders", dependencies=trade)
    def place_order(body: OrderIn) -> dict:
        p = profiles.active
        store, cloud = p.store, p.cloud
        unknown = [line.sku for line in body.lines if not store.lookup_sku(line.sku)]
        if unknown:
            raise HTTPException(422, f"unknown sku: {', '.join(unknown)}")
        if body.mode == "draft":
            raise HTTPException(400, "drafts are kept in the quick-order grid on desktop")
        ref = store.queue_order([line.model_dump() for line in body.lines], body.poNumber)
        try:
            cloud.sync(report)
        except Offline:
            return {"queued": True, "status": "QUEUED", "number": None}
        except UpdateRequired:
            raise
        d = store.draft(ref) or {}
        if d.get("state") == "REJECTED":
            raise HTTPException(422, d.get("server_status") or "rejected")
        return {"queued": False, "status": d.get("server_status"), "number": d.get("server_number")}

    @app.post("/v1/quotes", dependencies=trade)
    def request_quote(body: QuoteIn) -> dict:
        return profiles.active.cloud.request_quote(report, [line.model_dump() for line in body.lines], body.notes)

    return app
