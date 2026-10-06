"""LLM Studio backend.

Runs locally next to Ollama/Unsloth on your own machine. Start with:
    uvicorn main:app --reload --port 8800

It shells out to `ollama` and spawns training/export scripts as child
processes — nothing here talks to the internet except the normal
huggingface/ollama traffic those tools already make.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import ai_provider
from jobs import PROJECT_ROOT, Job, _subprocess_env, manager, pump_process
import store

load_dotenv(Path(__file__).parent / ".env")  # optional: GEMINI_API_KEY=... lives here

OLLAMA_URL = "http://localhost:11434"
HF_API = "https://huggingface.co/api"

app = FastAPI(title="LLM Studio")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    return store.create_custom_dataset(req.label, req.notes, req.examples)


# ---------- Hugging Face Hub search (for picking models/datasets in the UI) ----------

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


# ---------- AI-assisted dataset prep (Gemini) ----------

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


# ---------- training jobs ----------

class CreateJobRequest(BaseModel):
    base_model: str
    dataset: str
    output_name: str
    r: int = 8
    lora_alpha: int = 8
    max_seq_length: int = 512
    num_train_epochs: float = 1
    sample_size: int = 2000


@app.get("/api/jobs")
def list_jobs():
    return manager.list()


@app.post("/api/jobs")
async def create_job(req: CreateJobRequest):
    job = manager.create(**req.model_dump())
    loop = asyncio.get_event_loop()
    asyncio.create_task(manager.run_training(job, loop))
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
    return {"ok": True}


@app.post("/api/jobs/{job_id}/resume")
async def resume_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้")
    if job.status not in ("stopped", "failed"):
        raise HTTPException(400, "รันต่อได้เฉพาะงานที่หยุดแล้วหรือ error เท่านั้น")
    loop = asyncio.get_event_loop()
    asyncio.create_task(manager.resume_training(job, loop))
    return job.to_public()


@app.websocket("/api/jobs/{job_id}/ws")
async def job_ws(websocket: WebSocket, job_id: str):
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
        job.subscribers.remove(queue)


# ---------- export + ollama create ----------

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

    import sys

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

    return {"ok": code == 0, "gguf_dir": gguf_dir or out_dir, "gguf_file": gguf_file}


@app.get("/api/jobs/{job_id}/gguf-files")
def list_gguf_files(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้")
    gguf_dir, gguf_file = _find_gguf(job.output_name)
    return {"gguf_dir": gguf_dir, "files": [gguf_file] if gguf_file else []}

class CreateOllamaRequest(BaseModel):
    model_name: str
    gguf_path: str
    system_prompt: str = "คุณเป็นผู้ช่วยที่พูดภาษาไทยเป็นธรรมชาติ อบอุ่น และเข้าใจบริบทของผู้ใช้"
    stop_token: str = "<|eot_id|>"
    num_ctx: int = 4096
    temperature: float = 0.7


@app.post("/api/ollama/create")
def create_ollama_model(req: CreateOllamaRequest):
    modelfile = PROJECT_ROOT / f"Modelfile.{req.model_name}"
    modelfile.write_text(
        f'''FROM {req.gguf_path}

SYSTEM """{req.system_prompt}"""

PARAMETER temperature {req.temperature}
PARAMETER num_ctx {req.num_ctx}
PARAMETER stop "{req.stop_token}"
''',
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
    return {"ok": result.returncode == 0, "stdout": result.stdout, "stderr": result.stderr}


@app.post("/api/jobs/{job_id}/cleanup")
def cleanup_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "ไม่พบงานนี้")
    removed = []
    for name in (job.output_name, f"{job.output_name}-gguf", f"outputs_{job_id}"):
        p = PROJECT_ROOT / name
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
            removed.append(name)
    return {"ok": True, "removed": removed}


# ---------- ollama proxy (model list / chat test / delete) ----------

@app.get("/api/ollama/models")
async def ollama_models():
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(f"{OLLAMA_URL}/api/tags", timeout=5)
            return r.json()
        except httpx.HTTPError:
            return {"models": [], "error": "ollama_unreachable"}


class ChatRequest(BaseModel):
    model: str
    message: str


@app.post("/api/ollama/chat")
async def ollama_chat(req: ChatRequest):
    async with httpx.AsyncClient(timeout=120) as client:
        try:
            r = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={
                    "model": req.model,
                    "messages": [{"role": "user", "content": req.message}],
                    "stream": False,
                },
            )
            data = r.json()
            return {"reply": data.get("message", {}).get("content", ""), "raw": data}
        except httpx.HTTPError as e:
            return {"error": str(e)}


@app.delete("/api/ollama/models/{name}")
def delete_ollama_model(name: str):
    result = subprocess.run(
        ["ollama", "rm", name], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    return {"ok": result.returncode == 0, "stdout": result.stdout, "stderr": result.stderr}


@app.get("/api/health")
def health():
    return {"ok": True, "project_root": str(PROJECT_ROOT)}


# ---------- eval / test harness ----------

@app.get("/api/eval/prompts")
def eval_list_prompts():
    return store.list_prompts()


class AddPromptRequest(BaseModel):
    text: str
    category: str = "ทั่วไป"


@app.post("/api/eval/prompts")
def eval_add_prompt(req: AddPromptRequest):
    return store.add_prompt(req.text, req.category)


@app.delete("/api/eval/prompts/{prompt_id}")
def eval_delete_prompt(prompt_id: str):
    return store.delete_prompt(prompt_id)


class RunEvalRequest(BaseModel):
    model: str
    prompt_ids: list[str]


@app.post("/api/eval/run")
async def eval_run(req: RunEvalRequest):
    all_prompts = {p["id"]: p for p in store.list_prompts()}
    run_id = store.new_run_id()
    results = []
    async with httpx.AsyncClient(timeout=120) as client:
        for pid in req.prompt_ids:
            prompt = all_prompts.get(pid)
            if not prompt:
                continue
            try:
                r = await client.post(
                    f"{OLLAMA_URL}/api/chat",
                    json={
                        "model": req.model,
                        "messages": [{"role": "user", "content": prompt["text"]}],
                        "stream": False,
                    },
                )
                reply = r.json().get("message", {}).get("content", "")
            except httpx.HTTPError as e:
                reply = f"(error: {e})"
            results.append(
                {
                    "id": f"{pid}-{run_id}",
                    "prompt_id": pid,
                    "prompt_text": prompt["text"],
                    "response": reply,
                    "rating": None,
                }
            )
    run = {
        "id": run_id,
        "model": req.model,
        "created_at": time.time(),
        "results": results,
    }
    store.save_run(run)
    return run


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
