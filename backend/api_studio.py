"""endpoint ชุดใหม่ของ LLM Studio (แยกจาก main.py เพื่อไม่ให้ไฟล์เดียวยาวเกินอ่าน)

กลุ่มที่มี: ตั้งค่า, ล็อกอิน, ฮาร์ดแวร์/Preflight, คิวงาน, คลังความรู้, Playground (สตรีม),
ชุดข้อมูล (เวอร์ชัน/PII), ทะเบียนโมเดล, ชุดทดสอบเปรียบเทียบ, ระบบ (ดิสก์/สำรอง/audit)
ทุกอย่างอยู่ใต้ /api และ main.py include router นี้เข้าไป
"""
from __future__ import annotations

import asyncio
import json
import re
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

import abuse
import apikeys
import auth
import compare_jobs
import config
import datasets_mgr
import db
import evalreport
import evalx
import guard
import hardware
import kb
import kbtests
import logs
import modelcard
import ollama_client
import preflight
import registry
import store
import sysops
from jobs import guess_params_b, manager

router = APIRouter()

MAX_UPLOAD_BYTES = 25 * 1024 * 1024


# ====================================================================== ตั้งค่า
# คีย์ที่หน้าเว็บแก้ได้ (ไม่รวม auth/ธงภายใน) พร้อมชนิดข้อมูลที่ยอมรับ
_EDITABLE: dict[str, type | tuple] = {
    "ollama_url": str, "embed_model": str, "network_mode": str, "unload_before_train": bool,
    "reload_after_train": bool, "keep_alive": str, "default_system_prompt": str,
    "kb_chunk_size": int, "kb_chunk_overlap": int, "kb_top_k": int, "kb_min_score": (int, float),
    "max_train_minutes": int, "cors_origins": list, "auto_backup": bool, "backup_keep": int, "kb_pii_block": bool,
}


@router.get("/settings")
def get_settings():
    return config.public_settings()


@router.put("/settings")
def put_settings(patch: dict[str, Any]):
    clean: dict[str, Any] = {}
    for k, v in patch.items():
        if k not in _EDITABLE:
            continue
        want = _EDITABLE[k]
        if isinstance(v, bool) and want is not bool and bool not in (want if isinstance(want, tuple) else (want,)):
            raise HTTPException(400, f"ค่าของ {k} ไม่ถูกต้อง")
        if not isinstance(v, want):  # type: ignore[arg-type]
            raise HTTPException(400, f"ค่าของ {k} ไม่ถูกต้อง")
        clean[k] = v
    if clean.get("network_mode") not in (None, "safe", "fast"):
        raise HTTPException(400, 'network_mode ต้องเป็น "safe" หรือ "fast"')
    if "ollama_url" in clean:
        clean["ollama_url"] = clean["ollama_url"].strip().rstrip("/")
    config.save_settings(clean)
    db.audit("settings.update", "", ",".join(clean.keys()))
    return config.public_settings()


# ====================================================================== ล็อกอิน
class PasswordBody(BaseModel):
    password: str


@router.get("/auth/status")
def auth_status():
    return {"enabled": auth.is_enabled()}


@router.post("/auth/login")
def auth_login(body: PasswordBody):
    if not auth.is_enabled():
        return {"ok": True, "token": ""}
    if not auth.verify_password(body.password):
        db.audit("auth.fail", "", "รหัสผ่านไม่ถูกต้อง")
        raise HTTPException(401, "รหัสผ่านไม่ถูกต้อง")
    return {"ok": True, "token": auth.issue_token()}


@router.post("/auth/set-password")
def auth_set_password(body: PasswordBody):
    """ตั้ง/เปลี่ยนรหัสผ่านและเปิดการล็อกอิน (ถ้าเปิดอยู่แล้ว middleware บังคับให้ล็อกอินก่อนถึงมาถึงตรงนี้)"""
    try:
        auth.set_password(body.password)
    except ValueError as e:
        raise HTTPException(400, str(e))
    db.audit("auth.set_password")
    return {"ok": True, "token": auth.issue_token()}


@router.post("/auth/disable")
def auth_disable():
    auth.disable()
    db.audit("auth.disable")
    return {"ok": True}


# ====================================================================== ฮาร์ดแวร์ / Preflight
def _params_from_catalog(base_model: str) -> float:
    """ขนาดโมเดลจากแคตตาล็อก ('14B' → 14) ถ้าไม่มีให้เดาจากชื่อ"""
    for m in store.list_models():
        if m["id"] == base_model:
            digits = "".join(c for c in str(m.get("params", "")) if c.isdigit() or c == ".")
            try:
                return float(digits)
            except ValueError:
                break
    return guess_params_b(base_model)


@router.get("/system/hardware")
async def system_hardware():
    hw = hardware.probe_all()
    hw["ollama_up"] = await ollama_client.is_up()
    hw["ollama_running"] = [
        {"name": m.get("name"), "size_gb": round((m.get("size_vram") or m.get("size") or 0) / 1e9, 1)}
        for m in await ollama_client.running_models()]
    return hw


@router.get("/system/gpu-live")
def system_gpu_live():
    """ค่าเครื่องแบบเบา (nvidia-smi + psutil ไม่ถาม Ollama) ให้หน้างานเทรนดึงทุก 3 วินาที
    คืน gpu (null ถ้าไม่มีการ์ด/อ่านไม่ได้), CPU %, RAM, และตัวนับไบต์เครือข่ายรวมทั้งเครื่อง (หน้าเว็บคำนวณเป็นความเร็วเอง)
    เป็นตัวเลขภาพรวมของเครื่อง ไม่ได้แยกตามโปรเซส และไม่มีข้อมูลผู้ใช้/ข้อความใดๆ"""
    gpus = hardware.probe_gpus()
    out: dict = {"gpu": gpus[0] if gpus else None, "ts": time.time(), "cpu_pct": None,
                 "ram_used_gb": None, "ram_total_gb": None, "net_rx": None, "net_tx": None}
    ps = hardware.psutil
    if ps is not None:
        try:
            out["cpu_pct"] = ps.cpu_percent(interval=None)
            vm = ps.virtual_memory()
            out["ram_used_gb"] = round((vm.total - vm.available) / 1e9, 1)
            out["ram_total_gb"] = round(vm.total / 1e9, 1)
            nc = ps.net_io_counters()
            out["net_rx"], out["net_tx"] = nc.bytes_recv, nc.bytes_sent
        except Exception:
            pass
    return out


class PreflightBody(BaseModel):
    base_model: str
    max_seq_length: int = 512
    batch_size: int = 0
    params_b: float = 0
    export_after: bool = True


def _preflight(body: PreflightBody) -> dict:
    hw = hardware.probe_all()
    params_b = body.params_b or _params_from_catalog(body.base_model)
    gpu = hw.get("gpu")
    rec = hardware.recommend_training(gpu["vram_total_gb"] if gpu else 0.0, params_b, body.max_seq_length,
                                      is_linux=not config.IS_WINDOWS, cpu_threads=hw["cpu"]["threads"])
    batch = body.batch_size or rec["batch_size"]
    res = preflight.evaluate(params_b, batch, body.max_seq_length, hw, body.export_after)
    res["recommended"] = rec
    res["params_b"] = params_b
    res["batch_used"] = batch
    return res


@router.post("/preflight")
def run_preflight(body: PreflightBody):
    return _preflight(body)


# ====================================================================== คิวงาน
@router.get("/queue")
def get_queue():
    return manager.queue_info()


@router.post("/jobs/{job_id}/prioritize")
def prioritize_job(job_id: str):
    job = manager.get(job_id)
    if not job or job.status not in ("queued", "scheduled"):
        raise HTTPException(400, "ดันได้เฉพาะงานที่รออยู่ในคิว")
    manager.prioritize(job)
    return manager.queue_info()


# ====================================================================== คลังความรู้
class DocBody(BaseModel):
    title: str
    text: str
    kind: str = "text"
    category: str = ""
    tags: list[str] = []
    pii_ack: bool = False     # ยืนยันว่ารับทราบผลตรวจข้อมูลระบุตัวตนแล้ว


class QABody(BaseModel):
    question: str
    answer: str
    category: str = ""
    tags: list[str] = []
    pii_ack: bool = False


class DocPatch(BaseModel):
    title: str | None = None
    text: str | None = None
    context: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    enabled: bool | None = None
    pii_ack: bool = False


class ChunkPreviewBody(BaseModel):
    text: str
    size: int | None = None
    overlap: int | None = None


class SearchBody(BaseModel):
    query: str
    top_k: int | None = None
    category: str = ""


def _pii_findings(*texts: str | None) -> list[dict]:
    """สแกนข้อความหาข้อมูลระบุตัวตน (คืนเฉพาะชนิดที่บล็อก: เลขบัตร/HN/เบอร์/อีเมล; sample ถูกปิดบังแล้ว)"""
    out: list[dict] = []
    for t in texts:
        if t:
            out += [f for f in datasets_mgr.scan_text(t) if f["type"] in datasets_mgr.BLOCKING_TYPES]
    return out


def _pii_gate(ack: bool, *texts: str | None) -> None:
    """ถ้าเปิดบล็อกไว้และพบข้อมูลระบุตัวตนโดยผู้ใช้ยังไม่ยืนยัน ตอบ 409 พร้อมรายละเอียดให้หน้าเว็บถามยืนยัน"""
    if ack or not config.get_settings().get("kb_pii_block", True):
        return
    found = _pii_findings(*texts)
    if found:
        by_type: dict[str, int] = {}
        for f in found:
            by_type[f["type"]] = by_type.get(f["type"], 0) + 1
        raise HTTPException(409, {"code": "pii", "by_type": by_type, "samples": found[:5],
                                  "message": "พบข้อมูลที่ระบุตัวตนได้ในเนื้อหา (เลขบัตร/HN/เบอร์โทร/อีเมล) "
                                             "ข้อมูลในคลังความรู้ถูกส่งเข้า prompt ของโมเดล ตรวจและเอาออกก่อน หรือกดยืนยันถ้าเป็นข้อมูลสมมติ"})


async def _embed_quietly() -> dict:
    """สร้างเวกเตอร์หลังเพิ่ม/แก้ความรู้ ถ้า Ollama ไม่พร้อมก็ไม่ล้ม ส่งข้อความบอกสาเหตุกลับไปแทน"""
    try:
        return await kb.embed_pending()
    except Exception as e:  # noqa: BLE001
        return {"embedded_now": 0, "remaining": -1, "error": str(e)}


async def _doc_and_embed(doc_id: str) -> dict:
    """สร้างเวกเตอร์แล้วอ่านเอกสารใหม่ เพื่อให้ตัวเลข embedded ในคำตอบเป็นค่าหลังสร้างเสร็จ ไม่ใช่ก่อนสร้าง"""
    embed = await _embed_quietly()
    return {"doc": kb.get_doc(doc_id), "embed": embed}


@router.get("/kb/stats")
def kb_stats():
    return kb.stats()


@router.get("/kb/categories")
def kb_categories():
    return kb.categories()


@router.get("/kb/docs")
def kb_list(q: str = "", category: str = "", tag: str = "", kind: str = ""):
    return kb.list_docs(q, category, tag, kind)


@router.get("/kb/docs/{doc_id}")
def kb_get(doc_id: str):
    d = kb.get_doc(doc_id)
    if not d:
        raise HTTPException(404, "ไม่พบเอกสารนี้")
    return d


@router.post("/kb/docs")
async def kb_add(body: DocBody):
    _pii_gate(body.pii_ack, body.title, body.text)
    try:
        d = kb.add_doc(body.title, body.text, body.kind, body.category, body.tags)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return await _doc_and_embed(d["id"])


@router.post("/kb/qa")
async def kb_add_qa(body: QABody):
    _pii_gate(body.pii_ack, body.question, body.answer)
    if not body.question.strip() or not body.answer.strip():
        raise HTTPException(400, "ต้องกรอกทั้งคำถามและคำตอบ")
    d = kb.add_doc(body.question.strip()[:80], kb.qa_text(body.question, body.answer), "qa", body.category, body.tags)
    return await _doc_and_embed(d["id"])


@router.put("/kb/docs/{doc_id}")
async def kb_update(doc_id: str, body: DocPatch):
    _pii_gate(body.pii_ack, body.title, body.text)
    try:
        d = kb.update_doc(doc_id, body.title, body.text, body.category, body.tags, body.enabled)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not d:
        raise HTTPException(404, "ไม่พบเอกสารนี้")
    return await _doc_and_embed(doc_id)


@router.delete("/kb/docs/{doc_id}")
def kb_delete(doc_id: str):
    if not kb.delete_doc(doc_id):
        raise HTTPException(404, "ไม่พบเอกสารนี้")
    return {"ok": True}


@router.get("/kb/docs/{doc_id}/history")
def kb_doc_history(doc_id: str):
    return kb.history(doc_id)


@router.post("/kb/docs/{doc_id}/restore/{history_id}")
async def kb_restore(doc_id: str, history_id: int):
    d = kb.restore_version(doc_id, history_id)
    if not d:
        raise HTTPException(400, "ย้อนกลับไปรายการนี้ไม่ได้")
    return await _doc_and_embed(doc_id)


@router.get("/kb/history")
def kb_all_history(limit: int = 100):
    return kb.history(None, limit)


@router.post("/kb/preview-chunks")
def kb_preview(body: ChunkPreviewBody):
    chunks = kb.preview_chunks(body.text, body.size, body.overlap)
    return {"count": len(chunks), "chunks": chunks[:50]}


@router.post("/kb/upload")
async def kb_upload(files: list[UploadFile] = File(...), category: str = Form(""), tags: str = Form(""), pii_ack: bool = Form(False)):
    """อัปโหลดไฟล์ (txt, md, csv, pdf, docx) หลายไฟล์ในครั้งเดียว คืนผลรายไฟล์ ไฟล์ไหนอ่านไม่ได้ก็ไม่ทำให้ไฟล์อื่นล้ม"""
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    results = []
    added = 0
    for f in files:
        data = await f.read()
        if len(data) > MAX_UPLOAD_BYTES:
            results.append({"file": f.filename, "ok": False, "error": "ไฟล์ใหญ่เกิน 25 MB"})
            continue
        try:
            items = kb.extract_from_file(f.filename or "file.txt", data)
            if not items:
                results.append({"file": f.filename, "ok": False, "error": "ไม่พบเนื้อหาในไฟล์"})
                continue
            if not pii_ack and config.get_settings().get("kb_pii_block", True) and any(_pii_findings(it["title"], it["text"]) for it in items):
                results.append({"file": f.filename, "ok": False, "pii": True,
                                "error": "พบข้อมูลระบุตัวตน (เลขบัตร/HN/เบอร์/อีเมล) ไม่ได้เพิ่ม ตรวจไฟล์ หรือยืนยันเพื่อเพิ่มต่อ"})
                continue
            for it in items:
                kb.add_doc(it["title"], it["text"], it["kind"], category, tag_list, f.filename or "")
                added += 1
            results.append({"file": f.filename, "ok": True, "docs": len(items)})
        except ValueError as e:
            results.append({"file": f.filename, "ok": False, "error": str(e)})
    embed = await _embed_quietly() if added else {}
    return {"added": added, "files": results, "embed": embed}


@router.post("/kb/embed")
async def kb_embed():
    """สร้างเวกเตอร์ใหม่ให้ชิ้นที่ยังไม่มี (กดเองได้เมื่อเปลี่ยนโมเดลสร้างเวกเตอร์ในตั้งค่า)"""
    return await kb.embed_pending()


@router.post("/kb/search")
async def kb_search(body: SearchBody):
    return await kb.search(body.query, body.top_k, None, body.category)


@router.get("/kb/export")
def kb_export():
    return PlainTextResponse(kb.export_jsonl(), media_type="application/x-ndjson",
                             headers={"Content-Disposition": 'attachment; filename="knowledge-base.jsonl"'})


class ImportBody(BaseModel):
    text: str


@router.post("/kb/import")
async def kb_import(body: ImportBody):
    res = kb.import_jsonl(body.text)
    res["embed"] = await _embed_quietly()
    return res


# ====================================================================== Playground (สตรีม)
class PlayBody(BaseModel):
    model: str
    message: str
    history: list[dict] = []
    use_kb: bool = True
    top_k: int | None = None
    system_prompt: str | None = None
    temperature: float | None = None
    apply_scope: bool = True   # ใช้ขอบเขตการตอบ (กฎตอบตายตัว/ต้องมีเอกสาร) เหมือนที่ระบบอื่นเจอผ่าน API


@router.post("/playground/chat")
async def playground_chat(body: PlayBody):
    """ถาม-ตอบกับโมเดลแบบสตรีม (NDJSON): บรรทัดแรกเป็นแหล่งความรู้ที่ดึงมา ตามด้วยข้อความทีละช่วง และสถิติตอนจบ
    แยก 3 ชนิด: {"type":"sources"} / {"type":"delta"} / {"type":"done"|"error"}"""
    s = config.get_settings()
    system = body.system_prompt if body.system_prompt is not None else s["default_system_prompt"]
    hits: list[dict] = []
    search_info: dict = {}
    # ด่านขอบเขต (guard.py): กฎตอบตายตัวมาก่อน ไม่เรียกโมเดล
    decision = guard.check_rules(body.message) if body.apply_scope else None
    acfg = abuse.get_config()
    if body.apply_scope and not decision and acfg["enabled"] and not acfg["exempt_playground"]:   # ตัวกันถามซ้ำ (ปกติยกเว้นหน้าทดลอง)
        lim = abuse.check("playground", body.message, cfg=acfg)
        if lim["action"] != "allow":
            decision = {"kind": "abuse_" + lim["action"], "rule_name": "กันถามซ้ำ/สแปม", "reply": lim["reply"]}
    if body.use_kb and not decision:
        search_info = await kb.search(body.message, body.top_k)
        hits = search_info.get("hits", [])
        if body.apply_scope:
            decision = guard.check_context(body.message, hits, True)
    if decision:
        async def fixed():
            yield json.dumps({"type": "sources", "hits": hits, "mode": search_info.get("mode", "off"),
                              "note": search_info.get("note", ""), "guard": {"kind": decision["kind"], "rule": decision["rule_name"]}},
                             ensure_ascii=False) + "\n"
            yield json.dumps({"type": "delta", "text": decision["reply"]}, ensure_ascii=False) + "\n"
            yield json.dumps({"type": "done", "guard": decision["kind"]}, ensure_ascii=False) + "\n"
        return StreamingResponse(fixed(), media_type="application/x-ndjson")
    if body.use_kb:
        ctx = kb.build_context(hits)
        if ctx:
            system = f"{system}\n\n{ctx}".strip()
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages += [m for m in body.history if m.get("role") in ("user", "assistant") and m.get("content")]
    messages.append({"role": "user", "content": body.message})
    options = {"temperature": body.temperature} if body.temperature is not None else None

    async def gen():
        yield json.dumps({"type": "sources", "hits": hits, "mode": search_info.get("mode", "off"),
                          "note": search_info.get("note", "")}, ensure_ascii=False) + "\n"
        acc: list[str] = []
        async for ev in ollama_client.chat_stream(body.model, messages, options):
            if "delta" in ev:
                acc.append(ev["delta"])
                yield json.dumps({"type": "delta", "text": ev["delta"]}, ensure_ascii=False) + "\n"
            elif "error" in ev:
                yield json.dumps({"type": "error", "error": ev["error"]}, ensure_ascii=False) + "\n"
            elif ev.get("done"):
                # ตรวจเลขหลังตอบจบ: ถ้าแต่งเลขเอง ส่งคำสั่งแทนที่ข้อความทั้งก้อนด้วยข้อความปลอดภัย
                bad = guard.verify_numbers("".join(acc), [h["text"] for h in hits]) if (body.apply_scope and body.use_kb) else None
                if bad:
                    yield json.dumps({"type": "replace", "text": bad["reply"], "guard": bad["kind"], "numbers": bad["numbers"]}, ensure_ascii=False) + "\n"
                yield json.dumps({"type": "done", **{k: v for k, v in ev.items() if k != "done"}}, ensure_ascii=False) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# ====================================================================== กันถามซ้ำ/สแปม (0.8.5)
class AbuseSimBody(BaseModel):
    config: dict | None = None      # ค่าที่กำลังแก้ในหน้าจอ (ยังไม่บันทึก) ว่าง = ใช้ค่าที่บันทึก
    question: str = "ขอเวลาทำการหน่อย"
    repeats: int = 12
    interval_s: float = 5.0


class ClientBody(BaseModel):
    client: str


@router.get("/abuse")
def abuse_get():
    """ค่าตั้งปัจจุบัน + ค่าเริ่มต้น + พรีเซ็ต + สถานะสด (ใครกำลังถูกพัก, เหตุการณ์ล่าสุด, ตัวนับ)"""
    return {"config": abuse.get_config(), "default": abuse.DEFAULT_ABUSE, "presets": abuse.PRESETS, "status": abuse.status()}


@router.put("/abuse")
def abuse_put(body: dict):
    try:
        cfg = abuse.save_config(body)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    db.audit("abuse.update", cfg["preset"], f"enabled={cfg['enabled']} cache>{cfg['cache_after']} warn>{cfg['warn_after']} block>{cfg['block_after']}")
    return {"config": cfg}


@router.post("/abuse/simulate")
def abuse_simulate(body: AbuseSimBody):
    """จำลองถามซ้ำ N ครั้งด้วยค่าที่กำลังแก้ ไม่เรียกโมเดล ไม่แตะสถานะจริง"""
    try:
        return abuse.simulate(body.config, body.question, body.repeats, body.interval_s)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@router.post("/abuse/unlock")
def abuse_unlock(body: ClientBody):
    ok = abuse.unlock(body.client)
    if ok:
        db.audit("abuse.unlock", body.client, "ปลดล็อกด้วยมือ")
    return {"ok": ok}


@router.post("/abuse/reset")
def abuse_reset():
    abuse.reset()
    db.audit("abuse.reset", "all", "ล้างสถานะและแคช")
    return {"ok": True}


# ====================================================================== ขอบเขตการตอบ
class ScopeTestBody(BaseModel):
    message: str
    use_kb: bool = True


@router.get("/scope")
def scope_get():
    """ขอบเขตการตอบปัจจุบัน + ค่าที่เกี่ยวข้องในคลังความรู้ (เกณฑ์คะแนน/จำนวนชิ้น) + system prompt"""
    s = config.get_settings()
    return {"scope": guard.get_scope(), "default": guard.DEFAULT_SCOPE, "kb_min_score": s["kb_min_score"],
            "kb_top_k": s["kb_top_k"], "default_system_prompt": s["default_system_prompt"]}


class ScopeBody(BaseModel):
    scope: dict
    kb_min_score: float | None = None
    kb_top_k: int | None = None
    default_system_prompt: str | None = None


@router.put("/scope")
def scope_put(body: ScopeBody):
    try:
        clean = guard.validate_scope(body.scope)
    except ValueError as e:
        raise HTTPException(400, str(e))
    patch: dict = {"scope": clean}
    if body.kb_min_score is not None:
        if not 0 <= body.kb_min_score <= 1:
            raise HTTPException(400, "เกณฑ์คะแนนต้องอยู่ระหว่าง 0 ถึง 1")
        patch["kb_min_score"] = body.kb_min_score
    if body.kb_top_k is not None:
        if not 1 <= body.kb_top_k <= 20:
            raise HTTPException(400, "จำนวนชิ้นความรู้ต้องอยู่ระหว่าง 1 ถึง 20")
        patch["kb_top_k"] = body.kb_top_k
    if body.default_system_prompt is not None:
        patch["default_system_prompt"] = body.default_system_prompt.strip()[:4000]
    config.save_settings(patch)  # รายการ (กฎ/คำคุยทั่วไป) ถูกแทนที่ทั้งชุด ไม่ใช่รวม กฎที่ลบแล้วจึงไม่กลับมา
    db.audit("scope.update", "scope", f"กฎ {len(clean['rules'])} ข้อ require_context={clean['require_context']}")
    return scope_get()


@router.post("/scope/test")
async def scope_test(body: ScopeTestBody):
    """ลองข้อความกับขอบเขต "โดยไม่เรียกโมเดล": บอกว่าจะถูกตอบตายตัวไหม และคลังความรู้ค้นเจออะไร"""
    rule = guard.check_rules(body.message)
    if rule:
        return {"decision": rule, "hits": []}
    hits: list = []
    if body.use_kb:
        hits = (await kb.search(body.message)).get("hits", [])
    miss = guard.check_context(body.message, hits, body.use_kb)
    return {"decision": miss, "hits": [{"title": h["title"], "score": h["score"]} for h in hits],
            "smalltalk": guard.is_smalltalk(body.message)}


# ====================================================================== ชุดข้อมูล
class ExamplesBody(BaseModel):
    examples: list[dict]
    note: str = ""


class FromKBBody(BaseModel):
    label: str
    notes: str = ""


class RestoreVersionBody(BaseModel):
    version: int


@router.post("/datasets/scan")
def datasets_scan(body: ExamplesBody):
    """ตรวจข้อมูลระบุตัวตนในตัวอย่างที่ส่งมา (ยังไม่บันทึกอะไร) ใช้ก่อนกดสร้าง/นำเข้า"""
    return datasets_mgr.scan_examples(body.examples)


@router.get("/datasets/{dataset_id}/versions")
def datasets_versions(dataset_id: str):
    return datasets_mgr.list_versions(dataset_id)


@router.get("/datasets/{dataset_id}/preview")
def datasets_preview(dataset_id: str, version: int = 0, limit: int = 20):
    return datasets_mgr.preview(dataset_id, version or None, limit)


@router.get("/datasets/{dataset_id}/scan")
def datasets_scan_one(dataset_id: str):
    return datasets_mgr.scan_dataset(dataset_id)


@router.get("/datasets/{dataset_id}/examples")
def datasets_examples(dataset_id: str):
    """ตัวอย่างทั้งหมดของชุดข้อมูลที่สร้างเอง สำหรับหน้าตารางแก้ไข"""
    if not store.get_dataset(dataset_id) or not dataset_id.startswith("custom-"):
        raise HTTPException(404, "ไม่พบชุดข้อมูลนี้ (แก้ไขได้เฉพาะชุดข้อมูลที่สร้างเอง)")
    return datasets_mgr.all_examples(dataset_id)


@router.put("/datasets/{dataset_id}/examples")
def datasets_replace(dataset_id: str, body: ExamplesBody):
    """บันทึกตารางที่แก้แล้วเป็นเวอร์ชันใหม่ (แทนที่ทั้งชุด)"""
    if not store.get_dataset(dataset_id) or not dataset_id.startswith("custom-"):
        raise HTTPException(404, "ไม่พบชุดข้อมูลนี้ (แก้ไขได้เฉพาะชุดข้อมูลที่สร้างเอง)")
    try:
        return datasets_mgr.replace_examples(dataset_id, body.examples, body.note)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/datasets/{dataset_id}/append")
def datasets_append(dataset_id: str, body: ExamplesBody):
    if not store.get_dataset(dataset_id) or not dataset_id.startswith("custom-"):
        raise HTTPException(404, "ไม่พบชุดข้อมูลนี้ (เพิ่มตัวอย่างได้เฉพาะชุดข้อมูลที่สร้างเอง)")
    try:
        return datasets_mgr.append_examples(dataset_id, body.examples, body.note)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/datasets/{dataset_id}/restore")
def datasets_restore(dataset_id: str, body: RestoreVersionBody):
    try:
        return datasets_mgr.restore_version(dataset_id, body.version)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/datasets/from-kb")
def datasets_from_kb(body: FromKBBody):
    try:
        return datasets_mgr.from_kb(body.label, body.notes)
    except ValueError as e:
        raise HTTPException(400, str(e))


class FromFactsBody(BaseModel):
    label: str
    notes: str = ""
    facts: list[dict]
    augment: bool = True
    include_defaults: bool = True
    add_eval: bool = True
    out_of_scope: list[str] | None = None   # None = ใช้รายการเริ่มต้น, [] = ไม่ใส่
    unknown_answer: str | None = None       # คำตอบเมื่อไม่มีข้อมูล (ว่าง = ข้อความเริ่มต้น)
    rag_format: bool = False                # 0.8.2: แนบเอกสารอ้างอิงในตัวอย่างเทรน (ให้ตรงกับตอนใช้งานจริงที่มีคลังความรู้)


@router.post("/datasets/from-facts")
def datasets_from_facts(body: FromFactsBody):
    """สร้างชุดข้อมูลจากตารางข้อเท็จจริง + เพิ่มโจทย์ทดสอบที่ใช้คำสำคัญเดียวกัน (ไม่ใช้ AI)"""
    if not body.label.strip():
        raise HTTPException(400, "ตั้งชื่อชุดข้อมูลก่อน")
    try:
        return datasets_mgr.from_facts(body.label.strip(), body.notes, body.facts, body.augment,
                                       body.include_defaults, body.add_eval, body.out_of_scope, body.unknown_answer, body.rag_format)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/datasets/facts-preview")
def datasets_facts_preview(body: FromFactsBody):
    """ดูตัวอย่างก่อนสร้าง: จำนวนตัวอย่างเทรน/ข้อสอบ และตัวอย่างบางส่วน (ยังไม่บันทึกอะไร)"""
    import faqbuilder
    r = faqbuilder.build(body.facts, body.augment, body.include_defaults, body.out_of_scope, body.unknown_answer, body.rag_format)
    return {"stats": r["stats"], "train_sample": r["train"][:6], "eval": r["eval"],
            "quality": datasets_mgr.quality_report(r["train"])}


@router.get("/datasets/{dataset_id}/quality")
def datasets_quality(dataset_id: str):
    """รายงานความหลากหลายของชุดข้อมูลที่สร้างเอง (คำตอบซ้ำ/คำถามคล้ายกัน) ก่อนเอาไปเทรน"""
    if not store.get_dataset(dataset_id) or not dataset_id.startswith("custom-"):
        raise HTTPException(404, "ไม่พบชุดข้อมูลนี้")
    return datasets_mgr.quality_report(datasets_mgr.read_jsonl(config.CUSTOM_DATASETS_DIR / f"{dataset_id}.jsonl"))


class SuggestBody(BaseModel):
    kind: str                      # "questions" = คิดคำถามเพิ่ม, "answers" = เขียนคำตอบอีกสำนวน
    topic: str = ""
    answer: str
    questions: list[str] = []
    n: int = 5
    confirm: bool = False          # ผู้ใช้ต้องยืนยันว่ารู้ว่าข้อความจะถูกส่งให้ Gemini


@router.post("/datasets/suggest")
async def datasets_suggest(body: SuggestBody):
    """ให้ Gemini ช่วยคิดคำถามสำนวนอื่น / คำตอบอีกสำนวน จากข้อความที่ผู้ใช้พิมพ์ในตารางข้อเท็จจริง (ต้องยืนยันก่อนส่ง
    และบล็อกถ้าข้อความมีข้อมูลระบุตัวตน) ผลลัพธ์เป็นแค่ข้อเสนอ ผู้ใช้ตรวจ/แก้ก่อนใส่ในตาราง"""
    import ai_provider
    if body.kind not in ("questions", "answers"):
        raise HTTPException(400, 'kind ต้องเป็น "questions" หรือ "answers"')
    if not body.confirm:
        raise HTTPException(400, "ต้องยืนยันก่อนส่งข้อความให้ Gemini")
    text = "\n".join([body.topic, body.answer, *body.questions])
    if any(f["type"] in datasets_mgr.BLOCKING_TYPES for f in datasets_mgr.scan_text(text)):
        raise HTTPException(409, "ข้อความมีข้อมูลที่ระบุตัวตนได้ (เลขบัตร/HN/เบอร์ส่วนตัว ฯลฯ) จึงไม่ส่งให้ Gemini")
    n = max(1, min(10, body.n))
    if body.kind == "questions":
        prompt = (f"ช่วยเขียนคำถามภาษาไทยที่ผู้ป่วยหรือญาติอาจพิมพ์ถามแชตบอตโรงพยาบาล เรื่อง \"{body.topic or 'ทั่วไป'}\" "
                  f"ซึ่งคำตอบคือ: {body.answer}\nเขียนมา {n} ข้อ คนละสำนวนจริงๆ (สุภาพ/ห้วน/ภาษาพูด/พิมพ์สั้น/มีคำลงท้าย) "
                  f"ห้ามซ้ำหรือใกล้เคียงกับที่มีแล้ว:\n" + "\n".join(body.questions[:20]) +
                  "\nตอบเป็นบรรทัดละ 1 ข้อ ไม่ต้องใส่เลขข้อหรือสัญลักษณ์ ไม่ต้องมีคำอธิบายอื่น")
    else:
        prompt = (f"เขียนคำตอบต่อไปนี้ใหม่ {min(n, 4)} สำนวน ใจความ ตัวเลข เบอร์โทร และเวลาต้องเหมือนเดิมทุกตัว "
                  f"แต่เรียบเรียงประโยคต่างกัน น้ำเสียงสุภาพแบบเจ้าหน้าที่หญิง ลงท้ายค่ะ/นะคะ ห้ามเพิ่มข้อมูลใหม่:\n{body.answer}\n"
                  "ตอบเป็นบรรทัดละ 1 สำนวน ไม่ต้องใส่เลขข้อ ไม่ต้องมีคำอธิบายอื่น")
    try:
        out = await ai_provider.generate_text(prompt)
    except ai_provider.AIProviderError as e:
        return {"ok": False, "error": str(e)}
    lines = [re.sub(r"^[\s\-•*\d.)]+", "", ln).strip() for ln in out.splitlines()]
    have = {q.strip() for q in body.questions} | {body.answer.strip()}
    items = [ln for ln in dict.fromkeys(lines) if ln and ln not in have][:n]
    db.audit("ai.dataset_suggest", body.kind, f"ส่งข้อความตารางข้อเท็จจริง 1 เรื่อง ({len(text)} ตัวอักษร) ให้ Gemini", "admin")
    return {"ok": True, "items": items}


@router.get("/datasets/out-of-scope-default")
def datasets_oos_default():
    """รายการคำถามนอกขอบเขตเริ่มต้น + คำตอบเริ่มต้น ให้หน้าเว็บโหลดไปแก้เองได้"""
    import faqbuilder
    return {"questions": faqbuilder.DEFAULT_OUT_OF_SCOPE, "answer": faqbuilder.UNKNOWN_ANSWER}


@router.get("/datasets/facts-template")
def datasets_facts_template():
    """ตารางข้อเท็จจริงตัวอย่าง (สมมติ) ให้กดโหลดมาแก้เป็นของตัวเอง"""
    f = Path(__file__).resolve().parent.parent / "samples" / "pack-02" / "facts.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else []


# ====================================================================== ทะเบียนโมเดล
class RegisterBody(BaseModel):
    name: str
    base_model: str = ""
    notes: str = ""


class NotesBody(BaseModel):
    notes: str


@router.get("/registry")
def registry_list():
    return registry.list_all()


@router.get("/registry/active")
def registry_active():
    """โมเดลที่ใช้งานจริงตอนนี้ — เว็บระบบติดตามเรียกอันนี้เพื่อรู้ว่าควรถามโมเดลชื่ออะไร"""
    a = registry.active()
    if not a:
        raise HTTPException(404, "ยังไม่มีโมเดลที่ตั้งเป็นใช้งานจริง")
    return a


@router.get("/registry/events")
def registry_events(version_id: str = "", limit: int = 100):
    return registry.events(version_id or None, limit)


@router.post("/registry")
def registry_add(body: RegisterBody):
    if not body.name.strip():
        raise HTTPException(400, "ต้องระบุชื่อโมเดลใน Ollama")
    return registry.register(body.name.strip(), body.base_model, notes=body.notes)


def _reg_call(fn, *args):
    try:
        return fn(*args)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/registry/{vid}/approve")
def registry_approve(vid: str):
    return _reg_call(registry.approve, vid)


@router.post("/registry/{vid}/activate")
async def registry_activate(vid: str):
    v = _reg_call(registry.activate, vid)
    asyncio.get_running_loop().create_task(ollama_client.warm(v["name"]))  # อุ่นโมเดลไว้ล่วงหน้า ไม่ให้คำถามแรกช้า
    return v


@router.post("/registry/{vid}/archive")
def registry_archive(vid: str):
    return _reg_call(registry.archive, vid)


@router.post("/registry/rollback")
async def registry_rollback():
    v = _reg_call(registry.rollback)
    asyncio.get_running_loop().create_task(ollama_client.warm(v["name"]))
    return v


@router.put("/registry/{vid}/notes")
def registry_notes(vid: str, body: NotesBody):
    v = registry.set_notes(vid, body.notes)
    if not v:
        raise HTTPException(404, "ไม่พบเวอร์ชันนี้")
    return v


@router.delete("/registry/{vid}")
def registry_delete(vid: str):
    if not registry.delete(vid):
        raise HTTPException(400, "ลบไม่ได้ (ไม่พบ หรือเป็นโมเดลที่ใช้งานอยู่)")
    return {"ok": True}


# ====================================================================== ชุดทดสอบ: รัน/เปรียบเทียบ
class PromptPatch(BaseModel):
    text: str | None = None
    category: str | None = None
    expect: list[str] | None = None
    must_not: list[str] | None = None
    red_flag: bool | None = None
    pinned: bool | None = None


@router.put("/eval/prompts/{prompt_id}")
def eval_update_prompt(prompt_id: str, body: PromptPatch):
    return store.update_prompt(prompt_id, body.model_dump())


async def _ask_like_production(model: str, text: str, system: str, context: str = "") -> dict:
    """ถามแบบเดียวกับตอนใช้งานจริง: ด่านขอบเขต → ค้นคลังความรู้ → แนบข้อมูลอ้างอิง → เรียกโมเดล → ตรวจเลขในคำตอบ
    คืนรูปแบบเดียวกับ ollama_client.chat เพิ่ม guard (ถ้าตอบตายตัวหรือถูกแก้) sources (ชื่อเอกสาร) top_score (คะแนนค้นสูงสุด ไว้ตั้งค่าขั้นต่ำ)"""
    decision = guard.check_rules(text)
    hits: list[dict] = []
    if not decision and context:
        # ข้อสอบ "เอกสารขัดความจำ": ใช้เอกสารที่กำหนดแทนผลค้นหา (ไม่ค้นคลังจริง)
        hits = [{"title": "เอกสารทดสอบ", "text": re.sub(r"^ข้อมูลอ้างอิง:\n\[1\] \([^)]*\) ", "", context), "score": 1.0}]
    elif not decision:
        hits = (await kb.search(text)).get("hits", [])
        decision = guard.check_context(text, hits, True)
    top = max((h["score"] for h in hits), default=None)
    if decision:
        return {"reply": decision["reply"], "guard": decision["kind"], "sources": [h["title"] for h in hits], "top_score": top}
    ctx = kb.build_context(hits)
    sysmsg = f"{system}\n\n{ctx}".strip() if ctx else system
    msgs = ([{"role": "system", "content": sysmsg}] if sysmsg else []) + [{"role": "user", "content": text}]
    r = await ollama_client.chat(model, msgs)
    r["sources"] = [h["title"] for h in hits]
    r["top_score"] = top
    if "reply" in r:
        bad = guard.verify_numbers(r["reply"], [h["text"] for h in hits])
        if bad:
            r["reply_original"] = r["reply"]
            r["reply"], r["guard"] = bad["reply"], bad["kind"]
    return r


async def run_eval(model: str, prompt_ids: list[str], use_kb: bool = False, progress=None, cancelled=None) -> dict:
    """รันโจทย์ชุดหนึ่งกับโมเดลหนึ่ง พร้อมตรวจเงื่อนไขอัตโนมัติและวัดเวลา/ความเร็ว แล้วบันทึกเป็นรอบทดสอบ
    use_kb=True (0.8.2) = ทดสอบแบบมีคลังความรู้และด่านขอบเขตเหมือนใช้งานจริง (วัดผลที่ผู้ใช้เห็นจริง)"""
    system = config.get_settings()["default_system_prompt"] if use_kb else ""
    all_prompts = {p["id"]: p for p in store.list_prompts()}
    run_id = store.new_run_id()
    results = []
    for pid in prompt_ids:
        if cancelled and cancelled():
            break
        prompt = all_prompts.get(pid)
        if not prompt:
            continue
        if use_kb:
            r = await _ask_like_production(model, prompt["text"], system, prompt.get("context", ""))
        else:
            r = await ollama_client.chat(model, [{"role": "user", "content": prompt["text"]}])
        err = "error" in r
        reply = f"(error: {r['error']})" if err else r["reply"]
        chk = {"passed": None, "missing": [], "violated": []} if err else evalx.check_reply(prompt, reply)
        results.append({
            "id": f"{pid}-{run_id}", "prompt_id": pid, "prompt_text": prompt["text"], "response": reply,
            "rating": None, "red_flag": bool(prompt.get("red_flag")), "error": err,
            "passed": chk["passed"], "missing": chk["missing"], "violated": chk["violated"],
            "total_s": r.get("total_s"), "tokens_per_s": r.get("tokens_per_s"),
            "guard": r.get("guard"), "sources": r.get("sources"), "top_score": r.get("top_score"),
            "reply_original": r.get("reply_original"),
            "category": prompt.get("category", ""), "expect": prompt.get("expect", []), "must_not": prompt.get("must_not", []),
        })
        if progress:
            progress(len(results), len(prompt_ids))
    run = {"id": run_id, "model": model, "created_at": time.time(), "results": results, "use_kb": use_kb,
           "environment": modelcard.environment_snapshot() if use_kb else None,
           "summary": evalx.summarize(results)}
    store.save_run(run)
    return run


class CompareBody(BaseModel):
    models: list[str]
    prompt_ids: list[str] = []
    pinned_only: bool = False
    use_kb: bool = False            # ทดสอบแบบมีคลังความรู้ + ด่านขอบเขตเหมือนใช้งานจริง


def _select_prompts(prompt_ids: list[str], pinned_only: bool) -> list[str]:
    if prompt_ids:
        return prompt_ids
    prompts = store.list_prompts()
    if pinned_only:
        prompts = [p for p in prompts if p.get("pinned") or p.get("red_flag")]
    return [p["id"] for p in prompts]


def build_compare(models: list[str], ids: list[str], runs: dict, use_kb: bool) -> dict:
    """รวมผลรายโมเดลเป็นตารางเทียบเคียง: หนึ่งแถวต่อคำถาม คำตอบแต่ละโมเดลอยู่ข้างกัน"""
    rows = []
    for pid in ids:
        row: dict = {"prompt_id": pid, "answers": {}}
        for m, run in runs.items():
            res = next((r for r in run["results"] if r["prompt_id"] == pid), None)
            if res:
                row.update({"prompt_text": res["prompt_text"], "red_flag": res["red_flag"], "category": res.get("category", ""),
                            "expect": res.get("expect", []), "must_not": res.get("must_not", [])})
                row["answers"][m] = {k: res.get(k) for k in ("response", "passed", "missing", "violated", "total_s", "tokens_per_s", "guard", "sources", "top_score", "reply_original")}
        if row["answers"]:
            rows.append(row)
    return {"models": list(runs), "rows": rows,
            "summaries": {m: r["summary"] for m, r in runs.items()},
            "run_ids": {m: r["id"] for m, r in runs.items()}, "use_kb": use_kb}


@router.post("/eval/compare")
async def eval_compare(body: CompareBody):
    """รันชุดโจทย์เดียวกันกับหลายโมเดล (ทีละโมเดล กัน VRAM ไม่พอ) แล้วจัดเป็นตารางเทียบเคียงข้างกัน (รอจนเสร็จ)"""
    if len(body.models) < 2:
        raise HTTPException(400, "เลือกอย่างน้อย 2 โมเดลเพื่อเปรียบเทียบ")
    ids = _select_prompts(body.prompt_ids, body.pinned_only)
    if not ids:
        raise HTTPException(400, "ยังไม่มีโจทย์ให้ทดสอบ")
    runs = {}
    for m in body.models:
        runs[m] = await run_eval(m, ids, body.use_kb)
    return build_compare(body.models, ids, runs, body.use_kb)


async def _compare_runner(model, ids, use_kb, progress, cancelled):
    return await run_eval(model, ids, use_kb, progress, cancelled)


@router.post("/eval/compare/start")
async def eval_compare_start(body: CompareBody):
    """เริ่มเปรียบเทียบเป็นงานเบื้องหลัง: คืนเลขงานทันที ติดตามที่ GET /eval/compare/jobs/{id} (เปลี่ยนหน้า/ปิดเบราว์เซอร์ได้)"""
    if len(body.models) < 2:
        raise HTTPException(400, "เลือกอย่างน้อย 2 โมเดลเพื่อเปรียบเทียบ")
    ids = _select_prompts(body.prompt_ids, body.pinned_only)
    if not ids:
        raise HTTPException(400, "ยังไม่มีโจทย์ให้ทดสอบ")
    if any(j["status"] == "running" for j in compare_jobs.list_jobs()):
        raise HTTPException(409, "มีงานเปรียบเทียบที่กำลังรันอยู่ รอให้เสร็จหรือกดหยุดก่อน (รันพร้อมกันจะแย่ง VRAM)")
    job = compare_jobs.start(body.models, ids, body.use_kb, _compare_runner, build_compare)
    db.audit("eval.compare", ",".join(body.models), f"job={job['id']} prompts={len(ids)} kb={body.use_kb}")
    return {"id": job["id"], "status": job["status"]}


@router.get("/eval/compare/jobs")
def eval_compare_jobs():
    return compare_jobs.list_jobs()


@router.get("/eval/compare/jobs/{job_id}")
def eval_compare_job(job_id: str):
    j = compare_jobs.get(job_id)
    if not j:
        raise HTTPException(404, "ไม่พบงานเปรียบเทียบนี้")
    return j


@router.post("/eval/compare/jobs/{job_id}/cancel")
def eval_compare_cancel(job_id: str):
    if not compare_jobs.cancel(job_id):
        raise HTTPException(409, "งานนี้ไม่ได้กำลังรันอยู่")
    return {"ok": True}


@router.get("/eval/compare/jobs/{job_id}/analysis")
def eval_compare_analysis(job_id: str):
    """วิเคราะห์ว่าพลาดเพราะอะไร จัดกลุ่ม + คำแนะนำ + ข้อที่สองโมเดลต่างกัน (กฎในเครื่อง ไม่ใช้ AI)"""
    j = compare_jobs.get(job_id)
    if not j or not j.get("result"):
        raise HTTPException(404, "ยังไม่มีผลให้วิเคราะห์")
    return evalreport.analyze(j["result"])


@router.get("/eval/compare/jobs/{job_id}/export")
def eval_compare_export(job_id: str, format: str = "csv"):
    """ส่งออกผล: csv (เปิดใน Excel) | json (ครบทุกอย่างรวมวิเคราะห์) | failed (ข้อความเฉพาะข้อที่พลาด)"""
    j = compare_jobs.get(job_id)
    if not j or not j.get("result"):
        raise HTTPException(404, "ยังไม่มีผลให้ส่งออก")
    return _export_response(j["result"], format, f"compare-{job_id}")


def _export_response(result: dict, fmt: str, stem: str):
    from fastapi.responses import Response
    if fmt == "csv":
        return Response(evalreport.to_csv(result), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{stem}.csv"'})
    if fmt == "json":
        return Response(evalreport.to_json(result), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{stem}.json"'})
    if fmt == "failed":
        return PlainTextResponse(evalreport.failed_text(result))
    raise HTTPException(400, "format ต้องเป็น csv, json หรือ failed")


@router.get("/eval/runs/{run_id}/export")
def eval_run_export(run_id: str, format: str = "csv"):
    """ส่งออกผลรอบเดี่ยว (รูปแบบเดียวกับผลเปรียบเทียบ)"""
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(404, "ไม่พบรอบทดสอบนี้")
    return _export_response(evalreport.run_to_result(run), format, f"eval-{run_id}")


class DraftBody(BaseModel):
    model: str
    limit: int = 12


@router.post("/eval/compare/jobs/{job_id}/drafts")
async def eval_compare_drafts(job_id: str, body: DraftBody):
    """ร่างข้อมูลสอนจากข้อที่โมเดลหนึ่งพลาด (ยังไม่บันทึกอะไร): ข้อเท็จจริง = คำถาม + คำสำคัญ + คำตอบที่คาดจากคลังความรู้ (ถ้าหาเจอ),
    นอกขอบเขต = รายการคำถามให้ตอบ 'ไม่มีข้อมูล' เหลือให้ผู้ใช้ตรวจ/เติมคำตอบก่อนนำเข้าตารางข้อเท็จจริง"""
    j = compare_jobs.get(job_id)
    if not j or not j.get("result"):
        raise HTTPException(404, "ยังไม่มีผลให้ใช้")
    facts: list[dict] = []
    oos: list[str] = []
    for row in j["result"]["rows"]:
        a = (row.get("answers") or {}).get(body.model)
        kind = evalreport.classify(row, a) if a else None
        if not kind or kind in ("error", "red_flag_miss"):   # red flag ต้องแก้ที่กฎขอบเขต/ให้คนเขียนเอง ไม่ร่างอัตโนมัติ
            continue
        if kind == "hallucination":
            oos.append(row["prompt_text"])
            continue
        if len(facts) >= body.limit:
            continue
        answer = ""
        try:
            hits = (await kb.search(row["prompt_text"], 1)).get("hits", [])
            if hits and hits[0]["score"] >= 0.35:
                answer = re.sub(r"^.*?คำตอบ:\s*", "", hits[0]["text"], flags=re.S).strip()
        except Exception:  # noqa: BLE001 - ค้นไม่ได้ก็ปล่อยว่างให้ผู้ใช้เติม
            pass
        facts.append({"topic": row.get("category") or "ทั่วไป", "questions": [row["prompt_text"]], "answer": answer,
                      "keywords": [k for k in (row.get("expect") or []) if "|" not in k], "kind": kind})
    return {"facts": facts, "oos": oos,
            "note": "ข้อสอบที่ถูกนำไปสอนจะไม่ใช่ข้อสอบที่ยุติธรรมอีกต่อไป ควรเขียนข้อสอบใหม่ที่ใช้สำนวนต่างออกไปมาแทน"}


@router.get("/registry/{vid}/card")
def registry_card(vid: str):
    """การ์ดประจำโมเดล: ค่าเทรน ชุดข้อมูล ผลทดสอบ สภาพคลังความรู้/ขอบเขต และค่าสำหรับเทรนซ้ำ (modelcard.py)"""
    c = modelcard.build(vid)
    if not c:
        raise HTTPException(404, "ไม่พบเวอร์ชันนี้")
    return c


@router.post("/registry/{vid}/eval")
async def registry_eval(vid: str, prompt_ids: list[str] | None = None, use_kb: bool = False):
    """ทดสอบเวอร์ชันนี้ด้วยโจทย์ที่ตรึงไว้ (และเคส red flag) แล้วแนบผลสรุปเข้าทะเบียน"""
    v = registry.get(vid)
    if not v:
        raise HTTPException(404, "ไม่พบเวอร์ชันนี้")
    ids = _select_prompts(prompt_ids or [], True)
    if not ids:
        raise HTTPException(400, "ยังไม่มีโจทย์ที่ตรึงไว้ ไปตรึงโจทย์ในหน้าทดสอบก่อน")
    run = await run_eval(v["name"], ids, use_kb)
    summary = {**run["summary"], "run_id": run["id"], "at": run["created_at"], "use_kb": run.get("use_kb", False),
               "n_prompts": len(run["results"]), "environment": run.get("environment")}
    return registry.attach_eval(vid, summary)


# ====================================================================== ระบบ: ดิสก์ / สำรอง / audit / Ollama
def _busy_job_ids() -> set[str]:
    return {j.id for j in manager.jobs.values() if j.status in ("training", "exporting", "creating_ollama", "queued", "scheduled")}


@router.get("/system/disk")
def system_disk():
    return {"disk": hardware.probe_disk(), "breakdown": sysops.disk_breakdown(_busy_job_ids())}


@router.delete("/system/disk/{name}")
def system_disk_delete(name: str):
    try:
        return sysops.delete_item(name, _busy_job_ids())
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/system/cleanup-scripts")
def system_cleanup_scripts():
    return {"removed": sysops.cleanup_scripts()}


@router.get("/system/backups")
def system_backups():
    return sysops.list_backups()


@router.post("/system/backups")
def system_backup_create():
    return sysops.create_backup()


@router.get("/system/backups/{name}")
def system_backup_download(name: str):
    try:
        p = sysops.backup_path(name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return FileResponse(p, filename=name, media_type="application/zip")


@router.post("/system/backups/{name}/restore")
def system_backup_restore(name: str):
    try:
        return sysops.restore_backup(sysops.backup_path(name))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/system/restore-upload")
async def system_restore_upload(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > 500 * 1024 * 1024:
        raise HTTPException(400, "ไฟล์ใหญ่เกินไป")
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        tmp.write(data)
        path = Path(tmp.name)
    try:
        return sysops.restore_backup(path)
    except Exception as e:  # noqa: BLE001 — zip เสีย/ไม่ใช่ไฟล์สำรองของระบบ แจ้งเป็นข้อความอ่านได้
        raise HTTPException(400, str(e) if isinstance(e, ValueError) else "ไฟล์นี้ไม่ใช่ไฟล์สำรองที่ถูกต้อง")
    finally:
        path.unlink(missing_ok=True)


@router.get("/system/audit")
def system_audit(limit: int = 200, action: str = ""):
    if action:
        return db.query("SELECT * FROM audit_log WHERE action LIKE ? ORDER BY id DESC LIMIT ?", (action + "%", limit))
    return db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,))


@router.get("/system/ollama-tuning")
def system_ollama_tuning():
    gpu = hardware.probe_all().get("gpu")
    return sysops.ollama_tuning(gpu["vram_total_gb"] if gpu else 0.0, config.IS_WINDOWS)


# ---- สแกนข้อมูลระบุตัวตนทั้งคลัง + ชุดทดสอบการค้น
@router.get("/kb/pii-scan")
def kb_pii_scan():
    """สแกนเอกสารทุกชิ้นในคลัง คืนรายการที่พบข้อมูลระบุตัวตน (ไม่คืนค่าจริงเต็ม ๆ)"""
    flagged = []
    for d in kb.list_docs(include_text=True):
        found = _pii_findings(d["title"], d["raw_text"])
        if found:
            by_type: dict[str, int] = {}
            for f in found:
                by_type[f["type"]] = by_type.get(f["type"], 0) + 1
            flagged.append({"doc_id": d["id"], "title": d["title"], "by_type": by_type})
    return {"scanned": len(kb.list_docs()), "flagged": flagged}


class KbTestBody(BaseModel):
    question: str
    expect_doc_ids: list[str]
    note: str = ""


@router.get("/kb/tests")
def kb_tests_list():
    return kbtests.list_tests()


@router.post("/kb/tests")
def kb_tests_add(body: KbTestBody):
    try:
        return kbtests.add_test(body.question, body.expect_doc_ids, body.note)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/kb/tests/{tid}")
def kb_tests_delete(tid: str):
    if not kbtests.delete_test(tid):
        raise HTTPException(404, "ไม่พบข้อสอบนี้")
    return {"ok": True}


@router.post("/kb/tests/run")
async def kb_tests_run():
    return await kbtests.run_all()


# ====================================================================== คีย์ API (ให้ระบบอื่นเรียก /api/v1/*)
class KeyBody(BaseModel):
    name: str


@router.get("/apikeys")
def apikeys_list():
    return apikeys.list_all()


@router.post("/apikeys")
def apikeys_create(body: KeyBody):
    try:
        return apikeys.create(body.name)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/apikeys/{kid}/enabled")
def apikeys_enable(kid: str, body: dict[str, Any]):
    if not apikeys.set_enabled(kid, bool(body.get("enabled"))):
        raise HTTPException(404, "ไม่พบคีย์นี้")
    return apikeys.list_all()


@router.delete("/apikeys/{kid}")
def apikeys_delete(kid: str):
    if not apikeys.delete(kid):
        raise HTTPException(404, "ไม่พบคีย์นี้")
    return {"ok": True}


# ====================================================================== log และข้อมูลวินิจฉัย
@router.get("/system/logs/{name}")
def system_logs(name: str, lines: int = 300):
    try:
        return {"name": name, "lines": logs.tail(name, lines)}
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/system/logs/{name}/download")
def system_logs_download(name: str):
    try:
        p = logs.path_of(name)
    except ValueError as e:
        raise HTTPException(404, str(e))
    if not p.exists():
        raise HTTPException(404, "ยังไม่มี log นี้")
    return FileResponse(p, filename=p.name, media_type="text/plain")


@router.get("/system/diagnostics")
async def system_diagnostics():
    """รวมข้อมูลที่ต้องใช้ตอนแจ้งปัญหา: เวอร์ชัน เครื่อง การตั้งค่า (ไม่มีรหัส/คีย์) Ollama และ log ท้ายๆ"""
    import platform
    import sys
    hw = hardware.probe_all()
    tags = await ollama_client.list_models() if hasattr(ollama_client, "list_models") else None
    return {
        "python": sys.version.split()[0], "platform": platform.platform(), "root": str(config.PROJECT_ROOT),
        "hardware": hw, "ollama_up": await ollama_client.is_up(),
        "ollama_models": [m.get("name") for m in (tags or [])] if isinstance(tags, list) else None,
        "settings": config.public_settings(), "kb": kb.stats(),
        "active_model": (registry.active() or {}).get("name"),
        "backend_log_tail": logs.tail("backend", 40), "client_log_tail": logs.tail("client", 40),
    }


@router.get("/dashboard")
async def dashboard():
    """ข้อมูลรวมสำหรับหน้าแรก: โมเดลที่ใช้งาน คลังความรู้ งาน ดิสก์ GPU"""
    hw = hardware.probe_all()
    jobs_pub = manager.list()
    return {
        "active_model": registry.active(),
        "kb": kb.stats(),
        "queue": manager.queue_info(),
        "recent_jobs": jobs_pub[:5],
        "hardware": hw,
        "ollama_up": await ollama_client.is_up(),
        "registry_counts": {s: sum(1 for v in registry.list_all() if v["status"] == s) for s in registry.STATUSES},
    }
