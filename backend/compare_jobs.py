"""งานเปรียบเทียบโมเดลเบื้องหลัง (0.8.4): กดแล้วได้เลขงานทันที รันต่อที่ backend แม้เปลี่ยนหน้า/ปิดเบราว์เซอร์ ผลเก็บลงไฟล์ย้อนดูได้

สถานะ: running → done | error | cancelled | interrupted (backend ถูกปิดกลางทาง: เหลือ "ผลบางส่วน" ที่ทำเสร็จก่อนหน้า)
ความคืบหน้า: progress = {model, model_index, models_total, done, total}
"""
from __future__ import annotations

import asyncio
import time
import uuid

import store

MAX_KEPT = 40                       # เก็บประวัติเปรียบเทียบล่าสุดกี่งาน
_live: dict[str, dict] = {}         # งานที่กำลังรันในโปรเซสนี้ (เก็บ cancel flag)


def _all() -> list[dict]:
    return store._load(store.COMPARES_FILE, [])


def _write(jobs: list[dict]) -> None:
    store._save(store.COMPARES_FILE, jobs[-MAX_KEPT:])


def _persist(job: dict) -> None:
    jobs = [j for j in _all() if j["id"] != job["id"]] + [job]
    _write(jobs)


def _fix_status(job: dict) -> dict:
    """งานที่ไฟล์บอกว่ากำลังรันแต่ไม่มีในโปรเซสนี้ = backend ถูกปิดไปก่อน → interrupted"""
    if job.get("status") == "running" and job["id"] not in _live:
        return {**job, "status": "interrupted"}
    return job


def list_jobs() -> list[dict]:
    """รายการย่อ (ไม่รวมผลเต็ม) ใหม่สุดก่อน"""
    out = []
    for j in reversed(_all()):
        j = _fix_status(j)
        out.append({k: j.get(k) for k in ("id", "status", "created_at", "finished_at", "models", "use_kb", "progress", "error", "n_prompts")}
                   | {"summaries": (j.get("result") or {}).get("summaries")})
    return out


def get(job_id: str) -> dict | None:
    for j in _all():
        if j["id"] == job_id:
            return _fix_status(j)
    return None


def cancel(job_id: str) -> bool:
    live = _live.get(job_id)
    if not live:
        return False
    live["cancel"] = True
    return True


async def _run(job: dict, runner, builder) -> None:
    """รันทีละโมเดล (กัน VRAM ไม่พอ) อัปเดตความคืบหน้าลงไฟล์ทุกข้อ"""
    live = _live[job["id"]]
    runs: dict[str, dict] = {}
    models, ids = job["models"], job["prompt_ids"]
    try:
        for mi, m in enumerate(models):
            def progress(done: int, total: int, _m=m, _mi=mi):
                job["progress"] = {"model": _m, "model_index": _mi, "models_total": len(models), "done": done, "total": total}
                _persist(job)
            runs[m] = await runner(m, ids, job["use_kb"], progress, lambda: live["cancel"])
            if live["cancel"]:
                break
        job["result"] = builder(models, ids, runs, job["use_kb"])
        job["status"] = "cancelled" if live["cancel"] else "done"
    except Exception as e:  # noqa: BLE001 - เก็บสาเหตุให้ผู้ใช้เห็น ไม่ให้งานค้างสถานะ running
        job["status"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"
        if runs:
            job["result"] = builder(list(runs), ids, runs, job["use_kb"])  # ผลบางส่วน
    finally:
        job["finished_at"] = time.time()
        _persist(job)
        _live.pop(job["id"], None)


def start(models: list[str], prompt_ids: list[str], use_kb: bool, runner, builder) -> dict:
    """สร้างงานแล้วปล่อยรันเบื้องหลัง runner(model, ids, use_kb, progress, cancelled) -> run; builder(models, ids, runs, use_kb) -> result"""
    job = {"id": uuid.uuid4().hex[:10], "status": "running", "created_at": time.time(), "finished_at": None, "models": models,
           "prompt_ids": prompt_ids, "n_prompts": len(prompt_ids), "use_kb": use_kb,
           "progress": {"model": models[0], "model_index": 0, "models_total": len(models), "done": 0, "total": len(prompt_ids)},
           "error": None, "result": None}
    _live[job["id"]] = {"cancel": False}
    _persist(job)
    asyncio.get_running_loop().create_task(_run(job, runner, builder))
    return job
