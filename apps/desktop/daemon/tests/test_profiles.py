"""Desktop account profiles must mirror the web portal (accounts gone there disappear here)."""

from pathlib import Path

import pytest

from droplet_daemon.cloud import Offline
from droplet_daemon.profiles import ProfileManager


@pytest.fixture
def mgr(tmp_path: Path, monkeypatch):
    m = ProfileManager(tmp_path, "http://127.0.0.1:9")
    # Enroll two profiles without the network: give them device ids.
    m.active.device.set_device_id("dev-primary")
    second = m._open("second", "Branch office")  # noqa: SLF001 - test setup
    second.device.set_device_id("dev-second")
    m._profiles["second"] = second  # noqa: SLF001
    m._active_id = "second"  # noqa: SLF001
    m._save()  # noqa: SLF001
    return m


def _status(m: ProfileManager, pid: str, result):
    def fake():
        if isinstance(result, Exception):
            raise result
        return result
    m._profiles[pid].cloud.status = fake  # noqa: SLF001


def test_gone_profile_removed_and_active_falls_back(mgr):
    _status(mgr, "primary", {"state": "ACTIVE", "account": {"legalName": "Main Ltd", "code": "ACC-1", "status": "APPROVED"}})
    _status(mgr, "second", {"state": "GONE"})
    mgr.reconcile()
    ids = [p["id"] for p in mgr.list()]
    assert ids == ["primary"]
    assert mgr.active.id == "primary"
    assert mgr.list()[0]["legalName"] == "Main Ltd"


def test_gone_primary_is_reset_not_listed_as_enrolled(mgr):
    _status(mgr, "primary", {"state": "GONE"})
    _status(mgr, "second", {"state": "ACTIVE", "account": {"legalName": "Branch", "code": "ACC-2", "status": "APPROVED"}})
    mgr.reconcile()
    listed = {p["id"]: p for p in mgr.list()}
    assert listed["primary"]["enrolled"] is False
    assert mgr.active.id == "second"


def test_offline_keeps_everything(mgr):
    _status(mgr, "primary", Offline("down"))
    _status(mgr, "second", Offline("down"))
    mgr.reconcile()
    assert {p["id"] for p in mgr.list()} == {"primary", "second"}


def test_forget_unknown_profile_returns_false(mgr):
    assert mgr.forget("nope") is False
