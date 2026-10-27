"""ตั้งค่าชุดทดสอบ: ใช้โฟลเดอร์ชั่วคราวเป็น LLM_STUDIO_ROOT (ต้องตั้งก่อน import โมดูลใดๆ ของ backend)
และแทน Ollama ด้วยตัวปลอมที่ตอบแบบกำหนดได้ เพื่อให้รันทดสอบได้โดยไม่ต้องมี Ollama/GPU"""
import hashlib
import os
import sys
import tempfile
from pathlib import Path

_ROOT = tempfile.mkdtemp(prefix="llmstudio_test_")
os.environ["LLM_STUDIO_ROOT"] = _ROOT
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402


def _fake_vec(text: str, dim: int = 32) -> list[float]:
    """เวกเตอร์ปลอมจากแฮชของ trigram — ข้อความที่คล้ายกันได้เวกเตอร์ที่ใกล้กัน พอให้ทดสอบการค้นหาได้"""
    v = [0.0] * dim
    t = "".join(text.split()).lower()
    for i in range(max(1, len(t) - 2)):
        h = int(hashlib.md5(t[i:i + 3].encode()).hexdigest(), 16)
        v[h % dim] += 1.0
    return v


@pytest.fixture(autouse=True)
def clean_abuse():
    """ล้างสถานะตัวกันถามซ้ำก่อนทุกเทสต์ (เป็นตัวแปรระดับโมดูล ไม่ให้ข้ามเทสต์)"""
    import abuse
    abuse.reset()
    yield
    abuse.reset()


@pytest.fixture(autouse=True)
def fake_ollama(monkeypatch):
    import ollama_client

    async def embed(texts, model=None):
        return [_fake_vec(t) for t in texts], ""

    async def chat(model, messages, options=None, keep_alive=None, timeout=300):
        last = messages[-1]["content"]
        return {"reply": f"ตอบ: {last} 1323", "eval_count": 10, "eval_duration_s": 1.0, "total_s": 1.5, "tokens_per_s": 10.0}

    async def chat_stream(model, messages, options=None, keep_alive=None):
        for piece in ("สวัส", "ดี"):
            yield {"delta": piece}
        yield {"done": True, "eval_count": 4, "tokens_per_s": 8.0}

    async def running_models():
        return []

    async def is_up():
        return True

    async def warm(model, keep_alive=None):
        return True

    monkeypatch.setattr(ollama_client, "embed", embed)
    monkeypatch.setattr(ollama_client, "chat", chat)
    monkeypatch.setattr(ollama_client, "chat_stream", chat_stream)
    monkeypatch.setattr(ollama_client, "running_models", running_models)
    monkeypatch.setattr(ollama_client, "is_up", is_up)
    monkeypatch.setattr(ollama_client, "warm", warm)


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    import main
    with TestClient(main.app) as c:
        yield c


@pytest.fixture(autouse=True)
def clean_state():
    """ล้างข้อมูลทุกอย่างก่อนแต่ละเทสต์ เพื่อไม่ให้เทสต์หนึ่งทำให้อีกเทสต์ผิด"""
    import config, db, jobs, shutil
    for t in ("kb_chunks", "kb_docs", "kb_history", "model_versions", "model_events", "dataset_versions", "audit_log",
              "api_keys", "kb_tests"):
        db.execute(f"DELETE FROM {t}")
    shutil.rmtree(config.BACKUP_DIR, ignore_errors=True)
    import apikeys, logs
    apikeys._rate.clear()
    logs._client_hits.clear()
    for f in ("datasets.json", "eval_runs.json", "eval_prompts.json", "jobs.json", "settings.json"):
        (config.DATA_DIR / f).unlink(missing_ok=True)
    shutil.rmtree(config.CUSTOM_DATASETS_DIR, ignore_errors=True)
    jobs.manager.jobs.clear()
    config.save_settings({"auto_backup": False})  # ไม่ให้งานสำรองอัตโนมัติแทรกระหว่างเทสต์ (เทสต์สำรองเรียกฟังก์ชันตรง)
    yield
