"""LLM Studio backend.

รันบนเครื่องของคุณข้างๆ Ollama/Unsloth เริ่มด้วย:
    python -m uvicorn main:app --reload --port 8800

เรียก `ollama` และเปิดสคริปต์เทรน/ส่งออกเป็นโปรเซสลูก — ไม่มีอะไรในนี้ต่อออกอินเทอร์เน็ต
นอกจากทราฟฟิกปกติของ huggingface/ollama ที่เครื่องมือเหล่านั้นทำอยู่แล้ว
endpoint ชุดใหม่ (คลังความรู้ ทะเบียนโมเดล ฯลฯ) อยู่ใน api_studio.py
"""
from __future__ import annotations

import asyncio
import json
import re
import time
import traceback
import uuid
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

import ai_provider
import ai_digest
import api_studio
import api_v1
import auth
import chat_templates
import config
import datasets_mgr
import db
import hardware
import logs
import ollama_client
import registry
import store
import sysops
from jobs import PROJECT_ROOT, _subprocess_env, manager, pump_process

load_dotenv(Path(__file__).parent / ".env")  # ไม่บังคับ: GEMINI_API_KEY=... เก็บไว้ที่นี่

HF_API = "https://huggingface.co/api"
APP_VERSION = "0.8.6"


async def _auto_backup_loop():
    """ตรวจทุก 30 นาที ถ้าเปิดสำรองอัตโนมัติและยังไม่มีไฟล์ของวันนี้ ก็สำรองแล้วลบไฟล์เก่าเกินจำนวนที่เก็บ"""
    log = logs.get("backend")
    while True:
        try:
            s = config.get_settings()
            if s.get("auto_backup", True) and sysops.auto_backup_due():
                res = await asyncio.get_running_loop().run_in_executor(None, lambda: sysops.create_backup(auto=True))
                removed = sysops.prune_auto_backups(int(s.get("backup_keep", 7)))
                log.info("สำรองอัตโนมัติ %s (%s MB) ลบไฟล์เก่า %s", res["name"], res["size_mb"], removed)
        except Exception:  # noqa: BLE001 — สำรองพังต้องไม่ทำให้ระบบล้ม แต่ต้องมีร่องรอยใน log
            log.error("สำรองอัตโนมัติล้มเหลว\n%s", traceback.format_exc())
        await asyncio.sleep(1800)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """เริ่ม/หยุดตัวทำงานคิวและงานสำรองอัตโนมัติพร้อมแอป — งานที่ค้างรอคิวไว้ก่อนรีสตาร์ทจะกลับมารันเอง"""
    import platform
    logs.get("backend").info("เริ่มระบบ LLM Studio %s | python %s | %s | root=%s", APP_VERSION,
                             platform.python_version(), platform.platform(), config.PROJECT_ROOT)
    manager.start()
    backup_task = asyncio.get_running_loop().create_task(_auto_backup_loop())
    yield
    backup_task.cancel()
    manager.stop_worker()


app = FastAPI(title="LLM Studio", version=APP_VERSION, lifespan=lifespan)

# เส้นทางที่เข้าได้โดยไม่ต้องล็อกอิน (ต้องใช้ตอนยังไม่มี token)
_OPEN_PATHS = {"/api/auth/login", "/api/auth/status", "/api/health", "/api/client-log"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """ถ้าเปิดล็อกอินไว้ ทุก /api ต้องมี token (header Authorization: Bearer หรือ ?token=)"""
    path = request.url.path
    # /api/v1/* ยืนยันตัวตนด้วยคีย์ API ใน api_v1.py เอง ไม่ใช้โทเคนล็อกอินของหน้าเว็บ
    if (request.method == "OPTIONS" or not path.startswith("/api/") or path in _OPEN_PATHS
            or path.startswith("/api/v1/") or not auth.is_enabled()):
        return await call_next(request)
    header = request.headers.get("authorization", "")
    token = header[7:] if header.lower().startswith("bearer ") else request.query_params.get("token")
    if not auth.check_token(token):
        return JSONResponse({"detail": "ต้องล็อกอินก่อน"}, status_code=401)
    return await call_next(request)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """บันทึก request ที่ล้มเหลว (>=400) หรือช้า (>5 วินาที) และ exception ที่ไม่คาดคิด พร้อมรหัสอ้างอิงให้หน้าเว็บแจ้งผู้ใช้
    ไม่บันทึกเนื้อหา request/response และไม่บันทึก query string (อาจมีโทเคน)"""
    path = request.url.path
    t0 = time.time()
    try:
        resp = await call_next(request)
    except Exception:  # noqa: BLE001
        ref = uuid.uuid4().hex[:8]
        logs.get("backend").error("[%s] EXCEPTION %s %s\n%s", ref, request.method, path, traceback.format_exc(limit=-8))  # เก็บเฉพาะ 8 เฟรมในสุด (จุดที่พังจริง) ไม่เอาเฟรมของเฟรมเวิร์กยาวเป็นร้อยบรรทัด
        return JSONResponse({"detail": f"เกิดข้อผิดพลาดภายในระบบ (รหัสอ้างอิง {ref}) ดูรายละเอียดที่หน้า เครื่องและพื้นที่ → บันทึกการทำงาน"},
                            status_code=500)
    dt = time.time() - t0
    if path.startswith("/api/") and path != "/api/client-log" and (resp.status_code >= 400 or dt > 5):
        # 401 ตอนยังไม่ล็อกอินเป็นเรื่องปกติ ไม่ต้องรก log
        if resp.status_code != 401:
            logs.get("backend").warning("%s %s -> %s (%.2fs)", request.method, path, resp.status_code, dt)
    return resp


# เพิ่มหลัง middleware ล็อกอิน เพื่อให้ CORS อยู่ชั้นนอกสุด — ไม่งั้นคำตอบ 401 จะไม่มี header CORS แล้วเบราว์เซอร์แสดงเป็น network error
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.get_settings()["cors_origins"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_studio.router, prefix="/api")
app.include_router(api_v1.router, prefix="/api")


class ClientLogBody(BaseModel):
    kind: str = "error"
    message: str = ""
    stack: str = ""
    page: str = ""
    ua: str = ""
    viewport: str = ""
    version: str = ""


@app.post("/api/client-log")
def client_log(body: ClientLogBody):
    """หน้าเว็บรายงาน error ของตัวเองมาที่นี่ (เปิดให้เรียกได้แม้ยังไม่ล็อกอิน เพราะหน้าล็อกอินเองก็อาจพัง; จำกัด 60 รายการ/นาที)"""
    return {"ok": logs.write_client(body.model_dump())}


# ---------- catalog ----------

@app.get("/api/catalog/base-models")
def get_base_models():
    return store.list_models()


class AddModelRequest(BaseModel):
    id: str
    label: str
    params: str = "?"
    vramFitGb: int = 4
    notes: str = ""
    recommended: bool = False


@app.post("/api/catalog/base-models")
def add_base_model(req: AddModelRequest):
    return store.add_model(req.model_dump())


@app.delete("/api/catalog/base-models/{model_id:path}")
def delete_base_model(model_id: str):
    return store.delete_model(model_id)


@app.get("/api/catalog/datasets")
def get_datasets():
    return store.list_datasets()


class AddHFDatasetRequest(BaseModel):
    id: str
    label: str
    sizeHint: str = ""
    notes: str = ""


@app.post("/api/catalog/datasets")
def add_hf_dataset(req: AddHFDatasetRequest):
    return store.add_hf_dataset(req.model_dump())


@app.delete("/api/catalog/datasets/{dataset_id:path}")
def delete_dataset(dataset_id: str):
    return store.delete_dataset(dataset_id)


class CreateCustomDatasetRequest(BaseModel):
    label: str
    notes: str = ""
    examples: list[dict]


@app.post("/api/catalog/custom-datasets")
def create_custom_dataset(req: CreateCustomDatasetRequest):
    """สร้างชุดข้อมูลของเรา — ผ่าน datasets_mgr เพื่อให้มีเวอร์ชัน 1 และผลตรวจ PII ตั้งแต่แรก
    (คืนรายการแคตตาล็อกเหมือนเดิมเพื่อให้หน้าเว็บเดิมทำงานต่อได้)"""
    try:
        datasets_mgr.create_dataset(req.label, req.notes, req.examples, source="manual")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return store.list_datasets()


# ---------- Hugging Face Hub search ----------

@app.get("/api/hf/search/models")
async def hf_search_models(q: str = ""):
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            r = await client.get(f"{HF_API}/models", params={"search": q, "limit": 15, "sort": "downloads"})
            r.raise_for_status()
        except httpx.HTTPError as e:
            return {"error": str(e), "results": []}
    return {
        "results": [
            {"id": m["id"], "downloads": m.get("downloads", 0), "likes": m.get("likes", 0)}
            for m in r.json()
        ]
    }


@app.get("/api/hf/search/datasets")
async def hf_search_datasets(q: str = ""):
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            r = await client.get(f"{HF_API}/datasets", params={"search": q, "limit": 15, "sort": "downloads"})
            r.raise_for_status()
        except httpx.HTTPError as e:
            return {"error": str(e), "results": []}
    return {
        "results": [
            {"id": d["id"], "downloads": d.get("downloads", 0), "likes": d.get("likes", 0)}
            for d in r.json()
        ]
    }


# ---------- AI ช่วยเตรียม dataset (Gemini) ----------

@app.get("/api/ai/status")
def ai_status():
    return {"configured": ai_provider.is_configured(), "provider": "gemini"}


class GenerateDatasetRequest(BaseModel):
    raw_text: str
    num_pairs: int = 8


@app.post("/api/ai/generate-dataset")
async def ai_generate_dataset(req: GenerateDatasetRequest):
    try:
        pairs = await ai_provider.generate_qa_pairs(req.raw_text, req.num_pairs)
        return {"ok": True, "pairs": pairs}
    except ai_provider.AIProviderError as e:
        return {"ok": False, "error": str(e)}


# ---------- ให้ AI ช่วยอ่านผลเทรน (ส่งเฉพาะตัวเลข ไม่ส่งข้อมูลจริง) ----------

@app.get("/api/jobs/{job_id}/ai-digest")
def job_ai_digest(job_id: str):
    """ดูข้อมูลที่ "จะถูกส่ง" ไป Gemini ก่อนตัดสินใจ (ยังไม่ส่งอะไร)"""
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้")
    digest = ai_digest.build_digest(job)
    return {"digest": digest, "prompt": ai_digest.build_prompt(digest), "configured": ai_provider.is_configured()}


class AiSummaryRequest(BaseModel):
    confirm: bool = False


@app.post("/api/jobs/{job_id}/ai-summary")
async def job_ai_summary(job_id: str, req: AiSummaryRequest):
    """ส่งสรุปตัวเลขให้ Gemini อ่านผล: ต้องกดยืนยัน (confirm=true) เท่านั้น และบันทึกลงประวัติการใช้งาน"""
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้")
    if not req.confirm:
        raise HTTPException(400, "ต้องยืนยันก่อนส่ง")
    if job.status == "training":
        raise HTTPException(409, "รอให้เทรนเสร็จก่อน (ระหว่างเทรนไม่ทำอะไรเพิ่มเพื่อไม่รบกวนเครื่อง)")
    if not job.loss_points:
        raise HTTPException(400, "ยังไม่มีข้อมูล loss ให้อ่าน")
    digest = ai_digest.build_digest(job)
    try:
        text = await ai_provider.generate_text(ai_digest.build_prompt(digest))
    except ai_provider.AIProviderError as e:
        return {"ok": False, "error": str(e)}
    db.audit("ai.job_summary", job_id, f"ส่งตัวเลข loss {len(digest['train_loss']) + len(digest['val_loss'])} จุดให้ Gemini (ไม่มีเนื้อหาข้อมูล)", "admin")
    return {"ok": True, "text": text}


# ---------- งานเทรน ----------

class CreateJobRequest(BaseModel):
    base_model: str
    dataset: str
    output_name: str
    r: int = 8
    lora_alpha: int = 8
    max_seq_length: int = 512
    num_train_epochs: float = 1
    sample_size: int = 2000
    # ---- ตัวเลือกใหม่ (ไม่ส่งมาก็ใช้ค่าเริ่มต้น หน้าเว็บเดิมยังทำงานได้) ----
    preset: str = ""
    params_b: float = 0
    batch_size: int = 0           # 0 = เลือกอัตโนมัติตามเครื่อง
    grad_accum: int = 0
    learning_rate: float = 2e-4
    packing: bool = False
    val_ratio: float = 0.0
    system_prompt: str = ""
    template_mode: str = "auto"   # auto | legacy
    start_at: float | None = None  # ตั้งเวลาเริ่ม (epoch วินาที)
    max_minutes: int = 0
    pii_ack: bool = False         # ยืนยันว่ารับทราบผลตรวจข้อมูลระบุตัวตนแล้ว
    force: bool = False           # ฝืนเริ่มแม้ Preflight บอกว่าไม่พอ


@app.get("/api/jobs")
def list_jobs():
    return manager.list()


@app.post("/api/jobs")
async def create_job(req: CreateJobRequest):
    """สร้างงานเทรนเข้าคิว — ตรวจ 2 ด่านก่อน: ข้อมูลระบุตัวตน (PII) และ Preflight (VRAM/RAM/ดิสก์)
    ด่านไหนไม่ผ่านจะตอบ 409 พร้อมรายละเอียด ให้หน้าเว็บแสดงและให้ผู้ใช้ตัดสินใจ (ยืนยัน/ฝืน) ได้"""
    fields = req.model_dump(exclude={"pii_ack", "force"})
    # 0.8.0: ชื่อผลลัพธ์ต้องไม่ว่าง ใช้เป็นชื่อใน Ollama ได้ (a-z 0-9 . _ -) และไม่ซ้ำกับงานที่ยังใช้อยู่ (กันเขียนทับโมเดลเดิม)
    name = (req.output_name or "").strip()
    if not name:
        raise HTTPException(400, "ต้องตั้งชื่อโมเดลผลลัพธ์")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name):
        raise HTTPException(400, "ชื่อโมเดลใช้ได้เฉพาะ a-z, 0-9, จุด, ขีดกลาง, ขีดล่าง (ไม่เกิน 64 ตัว) และขึ้นต้นด้วยตัวอักษร/ตัวเลข")
    if any(j.output_name.lower() == name.lower() and j.status not in ("failed", "stopped") for j in manager.jobs.values()):
        raise HTTPException(409, {"code": "name_taken", "message": f"มีงานเทรนที่ใช้ชื่อ {name} อยู่แล้ว เปลี่ยนชื่อ (เช่น {name}-v2) เพื่อไม่ให้เขียนทับ"})
    fields["output_name"] = name
    if req.template_mode not in ("auto", "legacy"):
        raise HTTPException(400, 'template_mode ต้องเป็น "auto" หรือ "legacy"')
    if not fields["params_b"]:
        fields["params_b"] = api_studio._params_from_catalog(req.base_model)

    if req.dataset.startswith("custom-"):
        if not (config.CUSTOM_DATASETS_DIR / f"{req.dataset}.jsonl").exists():
            raise HTTPException(404, "ไม่พบไฟล์ชุดข้อมูลนี้")
        scan = datasets_mgr.scan_dataset(req.dataset)
        if scan["blocking"] > 0 and not req.pii_ack:
            raise HTTPException(409, {"code": "pii", "scan": {k: scan[k] for k in ("total", "flagged", "blocking", "by_type", "items")},
                                      "message": "พบข้อมูลที่ระบุตัวตนได้ในชุดข้อมูล ตรวจและแก้ก่อน หรือกดยืนยันถ้าแน่ใจว่าเป็นข้อมูลสมมติ"})
        fields["dataset_version"] = datasets_mgr.current_version(req.dataset)

    pf = api_studio._preflight(api_studio.PreflightBody(
        base_model=req.base_model, max_seq_length=req.max_seq_length, batch_size=req.batch_size,
        params_b=fields["params_b"], export_after=True))
    if pf["level"] == "no" and not req.force:
        raise HTTPException(409, {"code": "preflight", "preflight": pf, "message": pf["summary"]})

    job = manager.create(**fields)
    db.audit("train.create", job.id, {"base": req.base_model, "dataset": req.dataset, "out": req.output_name,
                                       "start_at": req.start_at})
    manager.enqueue(job)  # สร้างแล้วเข้าคิวทันที (ไม่มี await คั่น ตัวทำงานคิวจึงไม่หยิบก่อน)
    return job.to_public()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้ — อาจถูกลบไปแล้ว หรือสร้างไว้ก่อนอัปเดตเวอร์ชันที่บันทึกงานลงดิสก์")
    return job.to_public()


@app.post("/api/jobs/{job_id}/stop")
def stop_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้")
    manager.stop(job)
    db.audit("train.stop", job_id)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/resume")
async def resume_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้")
    if job.status not in ("stopped", "failed"):
        raise HTTPException(400, "รันต่อได้เฉพาะงานที่หยุดแล้วหรือ error เท่านั้น")
    await manager.resume_training(job)
    return job.to_public()


@app.websocket("/api/jobs/{job_id}/ws")
async def job_ws(websocket: WebSocket, job_id: str):
    # websocket ไม่ผ่าน middleware http จึงตรวจ token เองที่นี่
    if not auth.check_token(websocket.query_params.get("token")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    job = manager.get(job_id)
    if not job:
        await websocket.close()
        return
    queue: asyncio.Queue = asyncio.Queue()
    job.subscribers.append(queue)
    try:
        await websocket.send_text(json.dumps({"type": "status", "status": job.status}))
        for line in job.log_lines[-200:]:
            await websocket.send_text(json.dumps({"type": "log", "line": line}))
        while True:
            payload = await queue.get()
            await websocket.send_text(json.dumps(payload))
    except WebSocketDisconnect:
        pass
    finally:
        if queue in job.subscribers:
            job.subscribers.remove(queue)


# ---------- ส่งออก + สร้างโมเดลใน Ollama ----------

class ExportRequest(BaseModel):
    job_id: str
    quantization: str = "q4_k_m"


def _find_gguf(output_name: str, quantization: str = "") -> tuple[str | None, str | None]:
    """ค้นหาไฟล์ .gguf จริง — Unsloth เก็บไว้ในโฟลเดอร์ที่เติม _gguf ต่อท้ายเสมอ"""
    base = f"{output_name}-gguf"
    for dir_name in (f"{base}_gguf", base):
        d = PROJECT_ROOT / dir_name
        if not d.is_dir():
            continue
        candidates = sorted(d.glob("*.gguf"))
        if not candidates:
            continue
        quant_matches = [c for c in candidates if quantization and quantization.upper() in c.name.upper()]
        chosen = quant_matches or candidates
        return dir_name, chosen[0].name
    return None, None


@app.post("/api/jobs/{job_id}/export")
async def export_gguf(job_id: str, req: ExportRequest):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้")
    if manager.current is not None and manager.current.id != job.id:
        raise HTTPException(409, "GPU กำลังเทรนงานอื่นอยู่ รอให้จบก่อนแล้วค่อยส่งออก")
    job.status = "exporting"
    manager._save()
    await job.broadcast({"type": "status", "status": job.status})

    out_dir = f"{job.output_name}-gguf"
    script = PROJECT_ROOT / f"_studio_export_{job_id}.py"
    script.write_text(
        f'''from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="{job.output_name}",
    max_seq_length={job.max_seq_length},
    load_in_4bit=True,
)
model.save_pretrained_gguf("{out_dir}", tokenizer, quantization_method="{req.quantization}")
print("EXPORT_DONE")
''',
        encoding="utf-8",
    )

    proc = subprocess.Popen(
        [sys.executable, str(script)],
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=_subprocess_env(),
    )
    loop = asyncio.get_event_loop()
    await pump_process(job, proc, loop)
    code = proc.wait()
    job.status = "done" if code == 0 else "failed"
    manager._save()
    await job.broadcast({"type": "status", "status": job.status})

    gguf_dir, gguf_file = (None, None)
    if code == 0:
        gguf_dir, gguf_file = _find_gguf(job.output_name, req.quantization)
    db.audit("train.export", job_id, f"ok={code == 0} quant={req.quantization}")
    return {"ok": code == 0, "gguf_dir": gguf_dir or out_dir, "gguf_file": gguf_file}


@app.get("/api/jobs/{job_id}/gguf-files")
def list_gguf_files(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้")
    gguf_dir, gguf_file = _find_gguf(job.output_name)
    return {"gguf_dir": gguf_dir, "files": [gguf_file] if gguf_file else []}


class CreateOllamaRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())  # ชื่อฟิลด์ model_name ขึ้นต้นด้วย model_ ซึ่ง pydantic สงวนไว้ ปิดคำเตือน

    model_name: str
    gguf_path: str
    system_prompt: str = ""        # ว่าง = ใช้ค่าเริ่มต้นจากหน้าตั้งค่า
    stop_token: str = ""           # คงไว้เพื่อความเข้ากันได้ (stop token มาจาก template ของตระกูลโมเดลแล้ว)
    num_ctx: int = 4096
    temperature: float = 0.7
    job_id: str = ""               # ถ้าระบุ จะใช้ฐานโมเดล/รูปแบบ prompt ของงานนั้น และลงทะเบียนเข้าทะเบียนโมเดลให้
    base_model: str = ""


@app.post("/api/ollama/create")
def create_ollama_model(req: CreateOllamaRequest):
    """สร้างโมเดลเข้า Ollama ด้วย Modelfile ที่มี TEMPLATE ถูกต้องตามตระกูลโมเดล
    (เดิมไม่ใส่ TEMPLATE ทำให้ Ollama ใช้รูปแบบของโมเดลต้นทางซึ่งไม่ตรงกับตอนเทรน)"""
    job = manager.get(req.job_id) if req.job_id else None
    base = req.base_model or (job.base_model if job else "")
    family = "gemma" if (job and job.template_mode == "legacy") else None  # เทรนแบบเดิม (Gemma) ต้องใช้ template เดิมตอนใช้งานด้วย
    system = req.system_prompt or (job.system_prompt if job and job.system_prompt else "") \
        or config.get_settings()["default_system_prompt"]
    modelfile = PROJECT_ROOT / f"Modelfile.{req.model_name}"
    modelfile.write_text(
        chat_templates.build_modelfile(req.gguf_path, base, system, req.temperature, req.num_ctx, family),
        encoding="utf-8",
    )
    result = subprocess.run(
        ["ollama", "create", req.model_name, "-f", str(modelfile)],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    ok = result.returncode == 0
    version = None
    if ok:
        version = registry.register(req.model_name, base, req.job_id,
                                    job.dataset if job else "", str(job.dataset_version) if job and job.dataset_version else "")
        db.audit("ollama.create", req.model_name, f"base={base}")
    return {"ok": ok, "stdout": result.stdout, "stderr": result.stderr, "version": version}


@app.post("/api/jobs/{job_id}/cleanup")
def cleanup_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้")
    if job.status in ("training", "exporting", "creating_ollama"):
        raise HTTPException(409, "งานกำลังรันอยู่ หยุดงานก่อนแล้วค่อยล้างไฟล์")
    removed = []
    for name in (job.output_name, f"{job.output_name}-gguf", f"{job.output_name}-gguf_gguf", f"outputs_{job_id}"):
        p = PROJECT_ROOT / name
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
            removed.append(name)
    db.audit("train.cleanup", job_id, ",".join(removed))
    return {"ok": True, "removed": removed}


# ---------- Ollama: รายชื่อโมเดล / ทดสอบแชท / ลบ ----------

@app.get("/api/ollama/models")
async def ollama_models():
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(f"{config.ollama_url()}/api/tags", timeout=5)
            return r.json()
        except httpx.HTTPError:
            return {"models": [], "error": "ollama_unreachable"}


class ChatRequest(BaseModel):
    model: str
    message: str


@app.post("/api/ollama/chat")
async def ollama_chat(req: ChatRequest):
    r = await ollama_client.chat(req.model, [{"role": "user", "content": req.message}])
    if "error" in r:
        return {"error": r["error"]}
    return {"reply": r["reply"], "raw": r}


@app.delete("/api/ollama/models/{name}")
def delete_ollama_model(name: str):
    result = subprocess.run(
        ["ollama", "rm", name], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if result.returncode == 0:
        db.audit("ollama.delete", name)
    return {"ok": result.returncode == 0, "stdout": result.stdout, "stderr": result.stderr}


@app.get("/api/health")
async def health():
    return {"ok": True, "version": APP_VERSION, "project_root": str(PROJECT_ROOT),
            "auth_enabled": auth.is_enabled(), "ollama_up": await ollama_client.is_up()}


# ---------- ชุดทดสอบ ----------

@app.get("/api/eval/prompts")
def eval_list_prompts():
    return store.list_prompts()


class AddPromptRequest(BaseModel):
    text: str
    category: str = "ทั่วไป"
    expect: list[str] = []
    must_not: list[str] = []
    red_flag: bool = False
    pinned: bool = False


@app.post("/api/eval/prompts")
def eval_add_prompt(req: AddPromptRequest):
    return store.add_prompt(req.text, req.category, req.expect, req.must_not, req.red_flag, req.pinned)


@app.delete("/api/eval/prompts/{prompt_id}")
def eval_delete_prompt(prompt_id: str):
    return store.delete_prompt(prompt_id)


class RunEvalRequest(BaseModel):
    model: str
    prompt_ids: list[str]
    use_kb: bool = False            # 0.8.2: ทดสอบแบบมีคลังความรู้ + ด่านขอบเขต


@app.post("/api/eval/run")
async def eval_run(req: RunEvalRequest):
    return await api_studio.run_eval(req.model, req.prompt_ids, req.use_kb)


@app.get("/api/eval/runs")
def eval_list_runs():
    return sorted(store.list_runs(), key=lambda r: -r["created_at"])


@app.get("/api/eval/runs/{run_id}")
def eval_get_run(run_id: str):
    run = store.get_run(run_id)
    return run or {"error": "not_found"}


class RateResultRequest(BaseModel):
    rating: int


@app.post("/api/eval/runs/{run_id}/results/{result_id}/rate")
def eval_rate_result(run_id: str, result_id: str, req: RateResultRequest):
    run = store.get_run(run_id)
    if not run:
        return {"error": "not_found"}
    for res in run["results"]:
        if res["id"] == result_id:
            res["rating"] = max(1, min(5, req.rating))
    store.save_run(run)
    return run


@app.get("/api/eval/leaderboard")
def eval_leaderboard():
    return store.leaderboard()


# ---------- เสิร์ฟหน้าเว็บที่บิลด์แล้ว (โหมดเซิร์ฟเวอร์: พอร์ตเดียวจบ ไม่ต้องรัน npm run dev) ----------
# ใช้เมื่อมีโฟลเดอร์ frontend/dist (สร้างด้วย `npm run build`) ตอนพัฒนาบนเครื่องตัวเองไม่มี dist ก็ไม่กระทบอะไร
_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST.is_dir():
    from fastapi.responses import FileResponse

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404, "ไม่พบ endpoint นี้")
        target = (_DIST / full_path).resolve()
        # ไฟล์ที่มีจริงใน dist ส่งตรงๆ (กัน path ออกนอกโฟลเดอร์); นอกนั้นส่ง index.html ให้ React Router จัดการเส้นทาง
        if full_path and target.is_file() and _DIST in target.parents:
            return FileResponse(target)
        return FileResponse(_DIST / "index.html")
