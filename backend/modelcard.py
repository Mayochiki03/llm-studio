"""การ์ดประจำโมเดล (0.8.3): รวมทุกอย่างที่ต้องรู้เพื่อ "ทำซ้ำ/เทียบ/ย้อนกลับ" โมเดลหนึ่งรุ่นไว้ในที่เดียว

ดึงจาก 3 แหล่งที่มีอยู่แล้ว ไม่สร้างที่เก็บใหม่: ทะเบียนโมเดล (registry), งานเทรนที่สร้างโมเดลนี้ (jobs), ผลทดสอบล่าสุด (evals)
และถ่ายภาพ "สภาพแวดล้อมตอนนี้" (คลังความรู้/ขอบเขต/system prompt) ไว้เทียบว่าตอนทดสอบกับตอนนี้ต่างกันไหม
retrain = ค่าที่ส่งเข้า POST /api/jobs ได้ทันที (ปุ่ม "เทรนใหม่ด้วยค่าเดิม") ชื่อผลลัพธ์ถูกเปลี่ยนเป็นชื่อใหม่กันเขียนทับ
"""
from __future__ import annotations

import hashlib
import json
import re

import config
import db
import guard
import registry
from jobs import manager

# ค่าที่ใช้เทรนซ้ำได้ (ตรงกับ CreateJobRequest) — ไม่รวม start_at/pii_ack/force ที่เป็นเรื่องเฉพาะครั้ง
_RETRAIN_KEYS = ("base_model", "dataset", "r", "lora_alpha", "max_seq_length", "num_train_epochs", "sample_size", "preset",
                 "params_b", "batch_size", "grad_accum", "learning_rate", "packing", "val_ratio", "system_prompt",
                 "template_mode", "max_minutes")


def next_name(name: str) -> str:
    """เสนอชื่อรุ่นถัดไป: faq-v5 → faq-v6, faq-v5.latest → faq-v6, ไม่มีเลขรุ่น → ต่อท้าย -v2"""
    base = re.sub(r":.*$", "", name or "model")
    base = re.sub(r"\.latest$", "", base)
    m = re.search(r"^(.*?)(\d+)$", base)
    if m:
        return f"{m.group(1)}{int(m.group(2)) + 1}"
    return f"{base}-v2"


def environment_snapshot() -> dict:
    """สภาพคลังความรู้/ขอบเขต ณ ตอนนี้ แบบสั้นพอเก็บ/เทียบได้ (ไม่เก็บเนื้อหาเอกสาร)"""
    d = db.query_one("SELECT COUNT(*) AS docs, SUM(enabled) AS enabled, MAX(updated_at) AS last FROM kb_docs") or {}
    s = config.get_settings()
    sc = guard.get_scope()
    blob = json.dumps({"scope": sc, "sp": s.get("default_system_prompt", ""), "min": s.get("kb_min_score"), "k": s.get("kb_top_k")},
                      ensure_ascii=False, sort_keys=True)
    return {"kb_docs": d.get("docs") or 0, "kb_enabled": d.get("enabled") or 0, "kb_last_update": d.get("last"),
            "kb_min_score": s.get("kb_min_score"), "kb_top_k": s.get("kb_top_k"),
            "system_prompt_chars": len(s.get("default_system_prompt", "") or ""),
            "scope_hash": hashlib.sha1(blob.encode("utf-8")).hexdigest()[:10]}


def _job_part(job) -> dict:
    pts = job.loss_points or []
    train = [p["loss"] for p in pts if isinstance(p.get("loss"), (int, float))]
    val = [p["val_loss"] for p in pts if isinstance(p.get("val_loss"), (int, float))]
    d = {k: getattr(job, k, None) for k in _RETRAIN_KEYS + ("id", "output_name", "status", "dataset_version", "started_at", "finished_at")}
    d["train_config"] = job.train_config
    d["final_train_loss"] = train[-1] if train else None
    d["final_val_loss"] = val[-1] if val else None
    d["best_val_loss"] = min(val) if val else None
    return d


def build(version_id: str) -> dict | None:
    v = registry.get(version_id)
    if not v:
        return None
    job = manager.get(v["job_id"]) if v.get("job_id") else None
    retrain = None
    if job:
        retrain = {k: getattr(job, k) for k in _RETRAIN_KEYS}
        retrain["output_name"] = next_name(v["name"])
    return {
        "version": {k: v[k] for k in ("id", "name", "base_model", "status", "notes", "created_at", "updated_at")},
        "dataset": {"id": v.get("dataset_id") or (job.dataset if job else ""),
                    "version": v.get("dataset_version") or (str(job.dataset_version) if job and job.dataset_version else "")},
        "job": _job_part(job) if job else None,       # None = โมเดลที่เพิ่มเอง/นำเข้า ไม่มีประวัติเทรนในระบบนี้
        "eval": v.get("eval") or {},
        "environment_now": environment_snapshot(),
        "events": registry.events(version_id, 30),
        "retrain": retrain,
    }
