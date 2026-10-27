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


def loss_curve(job, max_points: int = 40) -> list[dict]:
    """จุดกราฟ loss (train/val) ย่อให้ไม่เกิน max_points ไว้วาดกราฟเล็กในการ์ด"""
    pts = [{"step": p.get("step"), "train": p.get("loss"), "val": p.get("val_loss")} for p in (job.loss_points or [])]
    if len(pts) > max_points:
        stride = len(pts) / max_points
        pts = [pts[int(i * stride)] for i in range(max_points - 1)] + [pts[-1]]
    return pts


def badges(card: dict, prompts_now: int) -> list[dict]:
    """ป้ายสรุปสุขภาพของรุ่น (tone: good/warn/bad/info) อ่านจบในหนึ่งแวบ โดยไม่ต้องรู้ศัพท์เทคนิค"""
    out: list[dict] = []
    j, ev, env = card.get("job"), card.get("eval") or {}, card.get("environment_now") or {}
    if j and j.get("final_train_loss") and j.get("final_val_loss"):
        ratio = j["final_val_loss"] / max(j["final_train_loss"], 1e-6)
        if ratio >= 3:
            out.append({"tone": "warn", "text": f"ช่องว่าง train/val กว้าง ({j['final_train_loss']:.2f} เทียบ {j['final_val_loss']:.2f}) เสี่ยงท่องจำ ลองเพิ่มความหลากหลายของข้อมูลหรือลดรอบ"})
        elif ratio >= 2:
            out.append({"tone": "info", "text": f"ช่องว่าง train/val พอสมควร ({ratio:.1f} เท่า) เฝ้าดูเมื่อเพิ่มข้อมูล"})
        else:
            out.append({"tone": "good", "text": "เทรนไม่ท่องจำเกินไป (train กับ val ใกล้กัน)"})
    if not ev or not ev.get("at"):
        out.append({"tone": "warn", "text": "ยังไม่เคยทดสอบ ควรรันทดสอบแบบมีคลังความรู้ก่อนอนุมัติ"})
    else:
        rf = ev.get("red_flag_recall")
        if rf is not None:
            out.append({"tone": "good" if rf >= 1 else "bad", "text": "จับเคสอันตราย (red flag) ครบ" if rf >= 1 else f"พลาดเคสอันตราย (จับได้ {round(rf * 100)}%) ห้ามอนุมัติ"})
        if not ev.get("use_kb"):
            out.append({"tone": "warn", "text": "ผลทดสอบนี้ไม่มีคลังความรู้ (วัดแค่ความจำโมเดล) ควรทดสอบแบบมี RAG ก่อนอนุมัติ"})
        n = ev.get("n_prompts") or ev.get("count")
        if n and prompts_now and n != prompts_now:
            out.append({"tone": "warn", "text": f"ชุดโจทย์เปลี่ยนไปจากตอนทดสอบ ({n} เป็น {prompts_now} ข้อ) ควรทดสอบใหม่ให้ตรงชุดปัจจุบัน"})
        then = ev.get("environment") or {}
        if ev.get("use_kb") and then and then.get("scope_hash") and then.get("scope_hash") != env.get("scope_hash"):
            out.append({"tone": "warn", "text": "ขอบเขต/system prompt/ค่าค้นเปลี่ยนไปหลังทดสอบ ควรทดสอบใหม่"})
        if ev.get("use_kb") and then and then.get("kb_last_update") and env.get("kb_last_update") and env["kb_last_update"] > then["kb_last_update"]:
            out.append({"tone": "info", "text": "มีการแก้คลังความรู้หลังทดสอบ ถ้าแก้เนื้อหาสำคัญควรทดสอบใหม่"})
    if not (card.get("version") or {}).get("notes"):
        out.append({"tone": "info", "text": "ยังไม่ได้บันทึกว่ารุ่นนี้แก้อะไรจากรุ่นก่อน"})
    return out


def headline(card: dict) -> str:
    """บรรทัดสรุปภาษาคนของการ์ด"""
    v, ev, j = card["version"], card.get("eval") or {}, card.get("job")
    parts = [v["name"]]
    if ev.get("pass_rate") is not None:
        parts.append(f"ผ่าน {round(ev['pass_rate'] * 100)}%" + (" (มีคลังความรู้)" if ev.get("use_kb") else " (ไม่มีคลังความรู้)"))
    else:
        parts.append("ยังไม่เคยทดสอบ")
    if j:
        parts.append(f"เทรน {j['num_train_epochs']:g} รอบ")
    if card["dataset"].get("id"):
        parts.append(f"ข้อมูล {card['dataset']['id']} v{card['dataset'].get('version') or '-'}")
    return " · ".join(parts)


def build(version_id: str) -> dict | None:
    v = registry.get(version_id)
    if not v:
        return None
    job = manager.get(v["job_id"]) if v.get("job_id") else None
    retrain = None
    if job:
        retrain = {k: getattr(job, k) for k in _RETRAIN_KEYS}
        retrain["output_name"] = next_name(v["name"])
    card = {
        "version": {k: v[k] for k in ("id", "name", "base_model", "status", "notes", "created_at", "updated_at")},
        "dataset": {"id": v.get("dataset_id") or (job.dataset if job else ""),
                    "version": v.get("dataset_version") or (str(job.dataset_version) if job and job.dataset_version else "")},
        "job": _job_part(job) if job else None,       # None = โมเดลที่เพิ่มเอง/นำเข้า ไม่มีประวัติเทรนในระบบนี้
        "eval": v.get("eval") or {},
        "environment_now": environment_snapshot(),
        "events": registry.events(version_id, 30),
        "retrain": retrain,
        "loss_curve": loss_curve(job) if job else [],
    }
    import store
    card["badges"] = badges(card, len(store.list_prompts()))
    card["headline"] = headline(card)
    return card
