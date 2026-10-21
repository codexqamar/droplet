"""Local SQLite cache: catalogue (with this account's price breaks), drafts, sync cursors and the
last account snapshot (orders, credit, statement) for offline viewing.

WAL mode, single writer. Everything the UI touches on the hot path (SKU lookup, search,
draft edits, the dashboard) is served from here; the network is only involved during sync.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, uom TEXT NOT NULL,
  pack_size INTEGER NOT NULL, list_minor INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0,
  breaks_json TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  client_ref TEXT PRIMARY KEY, po_number TEXT, state TEXT NOT NULL DEFAULT 'LOCAL',
  server_number TEXT, server_status TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS draft_lines (
  client_ref TEXT NOT NULL REFERENCES drafts(client_ref) ON DELETE CASCADE,
  sku TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (client_ref, sku)
);
CREATE TABLE IF NOT EXISTS sync_cursors (stream TEXT PRIMARY KEY, cursor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


class Store:
    def __init__(self, path: Path) -> None:
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._conn.executescript(SCHEMA)

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def query(self, sql: str, args: tuple = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, args).fetchall()]

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ── key/value (account snapshot, sync metadata) ──
    def put(self, key: str, value: object) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value)),
            )

    def get(self, key: str, default: object = None) -> object:
        rows = self.query("SELECT value FROM kv WHERE key = ?", (key,))
        return json.loads(rows[0]["value"]) if rows else default

    # ── catalogue ──
    @staticmethod
    def _item(row: dict) -> dict:
        return {
            "sku": row["sku"],
            "name": row["name"],
            "uom": row["uom"],
            "packSize": row["pack_size"],
            "listMinor": row["list_minor"],
            "stock": row["stock"],
            "breaks": json.loads(row["breaks_json"]),
        }

    def catalogue(self) -> list[dict]:
        return [self._item(r) for r in self.query("SELECT * FROM products WHERE active = 1 ORDER BY sku")]

    def lookup_sku(self, sku: str) -> dict | None:
        rows = self.query("SELECT * FROM products WHERE sku = ? AND active = 1", (sku.upper(),))
        return self._item(rows[0]) if rows else None

    def apply_catalogue(self, rows: list[dict], cursor: str) -> None:
        with self.tx() as c:
            c.executemany(
                """INSERT INTO products (id, sku, name, uom, pack_size, list_minor, stock, breaks_json, active)
                   VALUES (:id, :sku, :name, :uom, :packSize, :listMinor, :stock, :breaks, :active)
                   ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, name=excluded.name, uom=excluded.uom,
                     pack_size=excluded.pack_size, list_minor=excluded.list_minor, stock=excluded.stock,
                     breaks_json=excluded.breaks_json, active=excluded.active""",
                [
                    {
                        **r,
                        "listMinor": int(r["listMinor"]),
                        "stock": int(r.get("stock", 0)),
                        "breaks": json.dumps(r.get("breaks", [])),
                        "active": int(bool(r["active"])),
                    }
                    for r in rows
                ],
            )
            c.execute(
                "INSERT INTO sync_cursors(stream, cursor) VALUES ('catalogue', ?) "
                "ON CONFLICT(stream) DO UPDATE SET cursor=excluded.cursor",
                (cursor,),
            )

    def cursor(self, stream: str) -> str:
        rows = self.query("SELECT cursor FROM sync_cursors WHERE stream = ?", (stream,))
        return rows[0]["cursor"] if rows else "0"

    # ── drafts ──
    def queue_order(self, lines: list[dict], po_number: str | None) -> str:
        """Creates a draft already marked for submission; it is pushed on the next sync."""
        ref = str(uuid.uuid4())
        with self.tx() as c:
            c.execute("INSERT INTO drafts(client_ref, po_number, state) VALUES (?, ?, 'QUEUED')", (ref, po_number))
            c.executemany(
                "INSERT INTO draft_lines(client_ref, sku, qty) VALUES (?, ?, ?)",
                [(ref, line["sku"].upper(), int(line["qty"])) for line in lines],
            )
        return ref

    def draft(self, client_ref: str) -> dict | None:
        rows = self.query("SELECT * FROM drafts WHERE client_ref = ?", (client_ref,))
        return rows[0] if rows else None

    def queued(self) -> list[dict]:
        drafts = self.query("SELECT * FROM drafts WHERE state = 'QUEUED' ORDER BY updated_at")
        for d in drafts:
            d["lines"] = self.query("SELECT sku, qty FROM draft_lines WHERE client_ref = ?", (d["client_ref"],))
        return [d for d in drafts if d["lines"]]

    def record_push_result(self, result: dict) -> None:
        with self.tx() as c:
            if "error" in result:
                c.execute(
                    "UPDATE drafts SET state = 'REJECTED', server_status = ? WHERE client_ref = ?",
                    (result["error"], result["clientRef"]),
                )
            else:
                c.execute(
                    "UPDATE drafts SET state = 'SYNCED', server_number = ?, server_status = ? WHERE client_ref = ?",
                    (result["number"], result["status"], result["clientRef"]),
                )

    def reset(self) -> None:
        """Wipes cached account data (used when the device is revoked and must re-enroll)."""
        with self.tx() as c:
            for table in ("draft_lines", "drafts", "products", "sync_cursors", "kv"):
                c.execute(f"DELETE FROM {table}")  # noqa: S608 - fixed table names
