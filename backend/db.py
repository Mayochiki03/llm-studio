"""ฐานข้อมูล SQLite ของ LLM Studio (ไฟล์เดียว: studio_data/studio.db)

เก็บของที่ต้องค้นหา/มีความสัมพันธ์ ได้แก่ คลังความรู้, ประวัติเวอร์ชันเอกสาร,
ทะเบียนโมเดล, เวอร์ชัน dataset และ audit log
(ส่วนที่เป็นรายการเล็กๆ เดิมเช่น catalog/eval ยังเป็น JSON ตามเดิม ไม่ได้ย้าย)

ใช้ sqlite3 ของ Python อย่างเดียว ไม่ต้องติดตั้งอะไรเพิ่ม และไฟล์ย้าย/สำรองได้ง่าย
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterable, Iterator

import config

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS kb_docs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',          -- text | qa | file
    category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',            -- JSON list
    enabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    source_name TEXT NOT NULL DEFAULT '',
    raw_text TEXT NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    emb BLOB,
    emb_model TEXT,
    emb_dim INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);
CREATE TABLE IF NOT EXISTS kb_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    ts REAL NOT NULL,
    action TEXT NOT NULL,                       -- create | update | delete | toggle
    title TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'admin'
);
CREATE INDEX IF NOT EXISTS idx_kb_history_doc ON kb_history(doc_id);
CREATE TABLE IF NOT EXISTS model_versions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,                         -- ชื่อโมเดลใน Ollama
    base_model TEXT NOT NULL DEFAULT '',
    job_id TEXT NOT NULL DEFAULT '',
    dataset_id TEXT NOT NULL DEFAULT '',
    dataset_version TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'candidate',   -- candidate | approved | active | archived
    notes TEXT NOT NULL DEFAULT '',
    eval_json TEXT NOT NULL DEFAULT '{}',
    metrics_json TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    approved_by TEXT NOT NULL DEFAULT '',
    approved_at REAL,
    activated_at REAL
);
CREATE TABLE IF NOT EXISTS model_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    version_id TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT 'admin'
);
CREATE TABLE IF NOT EXISTS dataset_versions (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    file TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    pii_json TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dataset_versions_ds ON dataset_versions(dataset_id);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    actor TEXT NOT NULL DEFAULT 'admin',
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,              -- sha256 ของคีย์ (ไม่เก็บคีย์จริง)
    prefix TEXT NOT NULL,                       -- ตัวอักษรหน้าๆ ไว้ให้ผู้ใช้แยกออกว่าคีย์ไหน
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL,
    last_used_at REAL,
    use_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kb_tests (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    expect_doc_ids TEXT NOT NULL DEFAULT '[]',  -- JSON list ของเอกสารที่ควรถูกดึงมา
    note TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
"""


def get_conn() -> sqlite3.Connection:
    """เปิดการเชื่อมต่อครั้งแรก (ใช้ร่วมกันทั้งโปรเซส) พร้อมสร้างตารางถ้ายังไม่มี"""
    global _conn
    with _lock:
        if _conn is None:
            config.DB_FILE.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(config.DB_FILE), check_same_thread=False, timeout=30)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")  # อ่านพร้อมเขียนได้ ไม่ล็อกกันง่าย
            conn.execute("PRAGMA foreign_keys=ON")
            conn.executescript(SCHEMA)
            conn.commit()
            _conn = conn
        return _conn


def close() -> None:
    """ปิดการเชื่อมต่อ (ใช้ก่อนกู้คืนข้อมูลสำรอง หรือในชุดทดสอบ)"""
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            finally:
                _conn = None


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """ทำหลายคำสั่งเป็นธุรกรรมเดียว: สำเร็จครบถึงบันทึก ถ้าพังกลางทางย้อนทั้งหมด"""
    with _lock:
        conn = get_conn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def query(sql: str, params: Iterable[Any] = ()) -> list[dict]:
    """SELECT แล้วคืนเป็น list ของ dict"""
    with _lock:
        cur = get_conn().execute(sql, tuple(params))
        return [dict(r) for r in cur.fetchall()]


def query_one(sql: str, params: Iterable[Any] = ()) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    """INSERT/UPDATE/DELETE แล้วคืน lastrowid"""
    with tx() as conn:
        cur = conn.execute(sql, tuple(params))
        return cur.lastrowid or 0


def audit(action: str, target: str = "", detail: str | dict = "", actor: str = "admin") -> None:
    """บันทึกเหตุการณ์สำคัญลง audit log (เปลี่ยนโมเดลใช้งาน, ลบความรู้, เริ่มเทรน ฯลฯ)
    ไม่ throw error ออกไป — การบันทึก log พังต้องไม่ทำให้งานหลักล้มเหลว"""
    try:
        if not isinstance(detail, str):
            detail = json.dumps(detail, ensure_ascii=False)
        execute(
            "INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (?,?,?,?,?)",
            (time.time(), actor, action, target, detail[:2000]),
        )
    except Exception:
        pass
