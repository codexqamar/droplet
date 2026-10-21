"""Canonical JSON shared by every signer/verifier in DROPLET.

Must stay byte-identical with `canonicalJson()` in apps/cloud-api/src/lib/crypto.ts and
`serde_json::to_string` over a BTreeMap in the Tauri shell: sorted keys, compact separators,
raw UTF-8 (no ASCII escaping), integers only (floats are banned from signed payloads).
"""

from __future__ import annotations

import json
from typing import Any


def _reject_floats(value: Any) -> None:
    if isinstance(value, float):
        raise TypeError("floats are not allowed in signed payloads")
    if isinstance(value, dict):
        for v in value.values():
            _reject_floats(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            _reject_floats(v)


def canonical_json(value: Any) -> str:
    _reject_floats(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
