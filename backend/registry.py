"""ทะเบียนโมเดล (Model Registry): ทุกเวอร์ชันที่เทรนออกมา พร้อมสถานะและประวัติ

สถานะ: candidate (ผู้สมัคร) → approved (อนุมัติ) → active (ใช้งานจริง) → archived (เลิกใช้)
กติกา: ต้อง "อนุมัติ" ก่อนจึงตั้งเป็น "ใช้งานจริง" ได้ และมีได้ตัวเดียวที่ active
ย้อนกลับ (rollback) ทำได้โดยตั้งเวอร์ชันเก่าที่เคยอนุมัติแล้วกลับเป็น active
เว็บระบบติดตาม (SUD) อ่านชื่อโมเดลที่ใช้งานจริงได้จาก GET /api/registry/active
"""
from __future__ import annotations

import json
import time
import uuid

import db

STATUSES = ("candidate", "approved", "active", "archived")


def _row(r: dict) -> dict:
    r = dict(r)
    for k in ("eval_json", "metrics_json"):
        try:
            r[k[:-5]] = json.loads(r.pop(k) or "{}")
        except ValueError:
            r[k[:-5]] = {}
    return r


def _event(version_id: str, event: str, detail: str = "", actor: str = "admin") -> None:
    db.execute("INSERT INTO model_events (ts,version_id,event,detail,actor) VALUES (?,?,?,?,?)",
               (time.time(), version_id, event, detail, actor))


def register(name: str, base_model: str = "", job_id: str = "", dataset_id: str = "", dataset_version: str = "",
             notes: str = "", metrics: dict | None = None, actor: str = "admin") -> dict:
    """ลงทะเบียนโมเดลเป็น candidate (เรียกอัตโนมัติหลังสร้างโมเดลเข้า Ollama สำเร็จ หรือกดเพิ่มเอง)"""
    existing = db.query_one("SELECT id FROM model_versions WHERE name=? AND status<>'archived'", (name,))
    if existing:
        return get(existing["id"])  # type: ignore[return-value]
    vid = uuid.uuid4().hex[:10]
    now = time.time()
    db.execute(
        "INSERT INTO model_versions (id,name,base_model,job_id,dataset_id,dataset_version,status,notes,eval_json,metrics_json,created_at,updated_at)"
        " VALUES (?,?,?,?,?,?, 'candidate', ?, '{}', ?, ?, ?)",
        (vid, name, base_model, job_id, dataset_id, dataset_version, notes, json.dumps(metrics or {}, ensure_ascii=False), now, now))
    _event(vid, "register", name, actor)
    db.audit("model.register", name, f"base={base_model} dataset={dataset_id}", actor)
    return get(vid)  # type: ignore[return-value]


def get(version_id: str) -> dict | None:
    r = db.query_one("SELECT * FROM model_versions WHERE id=?", (version_id,))
    return _row(r) if r else None


def list_all() -> list[dict]:
    order = "CASE status WHEN 'active' THEN 0 WHEN 'approved' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END, created_at DESC"
    return [_row(r) for r in db.query(f"SELECT * FROM model_versions ORDER BY {order}")]


def active() -> dict | None:
    r = db.query_one("SELECT * FROM model_versions WHERE status='active' LIMIT 1")
    return _row(r) if r else None


def events(version_id: str | None = None, limit: int = 100) -> list[dict]:
    if version_id:
        return db.query("SELECT * FROM model_events WHERE version_id=? ORDER BY id DESC LIMIT ?", (version_id, limit))
    return db.query("SELECT * FROM model_events ORDER BY id DESC LIMIT ?", (limit,))


def attach_eval(version_id: str, summary: dict) -> dict | None:
    """แนบผลทดสอบล่าสุด (เช่น pass rate, red flag recall) เข้ากับเวอร์ชัน เพื่อใช้ตัดสินใจอนุมัติ"""
    v = get(version_id)
    if not v:
        return None
    db.execute("UPDATE model_versions SET eval_json=?, updated_at=? WHERE id=?",
               (json.dumps(summary, ensure_ascii=False), time.time(), version_id))
    _event(version_id, "eval", json.dumps({k: summary.get(k) for k in ("pass_rate", "red_flag_recall")}, ensure_ascii=False))
    return get(version_id)


def set_notes(version_id: str, notes: str) -> dict | None:
    db.execute("UPDATE model_versions SET notes=?, updated_at=? WHERE id=?", (notes, time.time(), version_id))
    return get(version_id)


def approve(version_id: str, actor: str = "admin") -> dict:
    v = get(version_id)
    if not v:
        raise ValueError("ไม่พบเวอร์ชันนี้")
    if v["status"] not in ("candidate", "archived"):
        raise ValueError("อนุมัติได้เฉพาะเวอร์ชันที่เป็นผู้สมัครหรือเลิกใช้แล้ว")
    now = time.time()
    db.execute("UPDATE model_versions SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?",
               (actor, now, now, version_id))
    _event(version_id, "approve", "", actor)
    db.audit("model.approve", v["name"], "", actor)
    return get(version_id)  # type: ignore[return-value]


def activate(version_id: str, actor: str = "admin") -> dict:
    """ตั้งเป็นโมเดลที่ใช้งานจริง (ต้องอนุมัติแล้ว หรือเคยเป็น active มาก่อนแล้วถูกเก็บเข้า archived)"""
    v = get(version_id)
    if not v:
        raise ValueError("ไม่พบเวอร์ชันนี้")
    if v["status"] == "candidate":
        raise ValueError("ต้องอนุมัติเวอร์ชันนี้ก่อนจึงจะตั้งเป็นโมเดลใช้งานจริงได้")
    if v["status"] == "archived" and not v.get("approved_at"):
        raise ValueError("เวอร์ชันนี้ไม่เคยได้รับการอนุมัติ")
    now = time.time()
    with db.tx() as conn:
        conn.execute("UPDATE model_versions SET status='archived', updated_at=? WHERE status='active'", (now,))
        conn.execute("UPDATE model_versions SET status='active', activated_at=?, updated_at=? WHERE id=?", (now, now, version_id))
    _event(version_id, "activate", "", actor)
    db.audit("model.activate", v["name"], "", actor)
    return get(version_id)  # type: ignore[return-value]


def archive(version_id: str, actor: str = "admin") -> dict:
    v = get(version_id)
    if not v:
        raise ValueError("ไม่พบเวอร์ชันนี้")
    if v["status"] == "active":
        raise ValueError("ยกเลิกโมเดลที่กำลังใช้งานอยู่ไม่ได้ ให้ตั้งเวอร์ชันอื่นเป็น active แทนก่อน")
    db.execute("UPDATE model_versions SET status='archived', updated_at=? WHERE id=?", (time.time(), version_id))
    _event(version_id, "archive", "", actor)
    return get(version_id)  # type: ignore[return-value]


def rollback(actor: str = "admin") -> dict:
    """ย้อนกลับไปเวอร์ชันที่เคยใช้งานก่อนหน้า (ตัวล่าสุดที่เคย active แล้วถูกเก็บเข้า archived)"""
    prev = db.query_one(
        "SELECT * FROM model_versions WHERE status='archived' AND activated_at IS NOT NULL ORDER BY activated_at DESC LIMIT 1")
    if not prev:
        raise ValueError("ยังไม่มีเวอร์ชันก่อนหน้าให้ย้อนกลับ")
    out = activate(prev["id"], actor)
    _event(prev["id"], "rollback", "", actor)
    return out


def delete(version_id: str) -> bool:
    v = get(version_id)
    if not v or v["status"] == "active":
        return False
    db.execute("DELETE FROM model_versions WHERE id=?", (version_id,))
    db.audit("model.delete", v["name"])
    return True
