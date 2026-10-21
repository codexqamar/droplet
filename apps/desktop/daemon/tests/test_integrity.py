import base64
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from build_manifest import build_manifest, sign_manifest  # noqa: E402

from droplet_daemon.canonical import canonical_json
from droplet_daemon.integrity import IntegrityError, verify_bundle


@pytest.fixture
def signed_bundle(tmp_path: Path):
    bundle = tmp_path / "bundle"
    (bundle / "_internal" / "lib").mkdir(parents=True)
    (bundle / "droplet-daemon.exe").write_bytes(b"MZ\x90\x00 fake exe")
    (bundle / "_internal" / "base_library.zip").write_bytes(b"PK fake zip")
    (bundle / "_internal" / "lib" / "app.pyc").write_bytes(b"\x6f\x0d\x0d\x0a bytecode")
    key = Ed25519PrivateKey.generate()
    pub = base64.b64encode(key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
    info = sign_manifest(bundle, build_manifest(bundle, "test+win-x64.1", "0.0.1", "win-x64"), key)
    return bundle, pub, info


def test_clean_bundle_passes(signed_bundle):
    bundle, pub, info = signed_bundle
    report = verify_bundle(bundle, pub)
    assert report.ok
    assert report.manifest_root == info["manifestRoot"]


def test_modified_bytecode_detected(signed_bundle):
    bundle, pub, _ = signed_bundle
    (bundle / "_internal" / "lib" / "app.pyc").write_bytes(b"patched")
    report = verify_bundle(bundle, pub)
    assert not report.ok
    assert [m.path for m in report.mismatches] == ["_internal/lib/app.pyc"]


def test_injected_file_detected(signed_bundle):
    bundle, pub, _ = signed_bundle
    (bundle / "_internal" / "sitecustomize.py").write_text("import evil")
    report = verify_bundle(bundle, pub)
    assert report.mismatches[0].expected == "<absent>"


def test_deleted_file_detected(signed_bundle):
    bundle, pub, _ = signed_bundle
    (bundle / "_internal" / "base_library.zip").unlink()
    report = verify_bundle(bundle, pub)
    assert report.mismatches[0].actual == "<missing>"


def test_rewritten_manifest_fails_signature(signed_bundle):
    bundle, pub, _ = signed_bundle
    (bundle / "droplet-daemon.exe").write_bytes(b"evil")
    # Attacker regenerates the manifest with their own key: hashes match, signature does not.
    attacker = Ed25519PrivateKey.generate()
    sign_manifest(bundle, build_manifest(bundle, "test+win-x64.1", "0.0.1", "win-x64"), attacker)
    report = verify_bundle(bundle, pub)
    assert not report.mismatches
    assert not report.signature_valid
    assert not report.ok


def test_missing_manifest_raises(tmp_path):
    with pytest.raises(IntegrityError):
        verify_bundle(tmp_path, "x")


def test_canonical_json_matches_cloud_format():
    # Same bytes the TypeScript canonicalJson() produces for this object.
    assert canonical_json({"b": [2, {"z": 1, "a": "é"}], "a": None}) == '{"a":null,"b":[2,{"a":"é","z":1}]}'
    with pytest.raises(TypeError):
        canonical_json({"price": 1.5})
