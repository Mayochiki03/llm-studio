"""คีย์ API สำหรับระบบอื่น (เช่น เว็บระบบติดตาม SUD, แชทบอท LINE) ที่มาเรียก /api/v1/*

- สร้างคีย์ได้หลายอัน ตั้งชื่อแยกตามระบบที่ใช้ และปิด/ลบรายอันได้
- เก็บเฉพาะ sha256 ของคีย์ คีย์จริงแสดงครั้งเดียวตอนสร้าง (ลืมแล้วต้องสร้างใหม่)
- จำกัดอัตราเรียก 60 ครั้ง/นาที/คีย์ กันระบบลูกเรียกวนจน GPU ตัน
"""
from __future__ import annotations

import collections
import hashlib
import secrets
import time
import uuid

import db

PREFIX = "sk-llmstudio-"
RATE_PER_MIN = 60
_rate: dict[str, collections.deque] = {}


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def create(name: str) -> dict:
    """สร้างคีย์ใหม่ คืน {id, name, key} (key แสดงครั้งเดียว)"""
    name = name.strip()
    if not name:
        raise ValueError("ต้องตั้งชื่อคีย์ (เช่น ชื่อระบบที่จะใช้)")
    key = PREFIX + secrets.token_urlsafe(32)
    kid = uuid.uuid4().hex[:10]
    db.execute("INSERT INTO api_keys (id,name,key_hash,prefix,enabled,created_at) VALUES (?,?,?,?,1,?)",
               (kid, name[:80], _hash(key), key[:len(PREFIX) + 4], time.time()))
    db.audit("apikey.create", kid, name)
    return {"id": kid, "name": name, "key": key}


def list_all() -> list[dict]:
    return db.query("SELECT id,name,prefix,enabled,created_at,last_used_at,use_count FROM api_keys ORDER BY created_at DESC")


def set_enabled(kid: str, enabled: bool) -> bool:
    if not db.query_one("SELECT id FROM api_keys WHERE id=?", (kid,)):
        return False
    db.execute("UPDATE api_keys SET enabled=? WHERE id=?", (1 if enabled else 0, kid))
    db.audit("apikey.enable" if enabled else "apikey.disable", kid)
    return True


def delete(kid: str) -> bool:
    if not db.query_one("SELECT id FROM api_keys WHERE id=?", (kid,)):
        return False
    db.execute("DELETE FROM api_keys WHERE id=?", (kid,))
    db.audit("apikey.delete", kid)
    return True


def verify(key: str | None) -> dict | None:
    """ตรวจคีย์ คืนแถวของคีย์ถ้าถูกต้องและเปิดใช้อยู่ ไม่งั้น None (และอัปเดตเวลาใช้ล่าสุด)"""
    if not key or not key.startswith(PREFIX):
        return None
    row = db.query_one("SELECT * FROM api_keys WHERE key_hash=? AND enabled=1", (_hash(key),))
    if not row:
        return None
    db.execute("UPDATE api_keys SET last_used_at=?, use_count=use_count+1 WHERE id=?", (time.time(), row["id"]))
    return row


def allow_rate(kid: str) -> bool:
    """False = เรียกถี่เกินโควตาของคีย์นี้"""
    now = time.time()
    q = _rate.setdefault(kid, collections.deque())
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= RATE_PER_MIN:
        return False
    q.append(now)
    return True
