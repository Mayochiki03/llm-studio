"""ทดสอบรุ่น 0.7.1: สรุปผลเทรนให้ AI อ่านโดยส่งเฉพาะตัวเลข และแผงมอนิเตอร์ gpu-live"""
import pytest
from fastapi.testclient import TestClient

import ai_digest
import ai_provider
from jobs import Job, manager


def _job(**kw):
    base = dict(id="j-ai", base_model="scb10x/llama3.2-typhoon2-3b-instruct", dataset="ข้อมูลลับของโรงพยาบาล",
                output_name="โมเดลชื่อลับ", r=32, lora_alpha=32, max_seq_length=512, num_train_epochs=4, sample_size=728,
                status="done", learning_rate=2e-4, val_ratio=0.1,
                loss_points=[{"step": i * 2, "loss": 1.5 / (i + 1), "val_loss": None} for i in range(100)],
                log_lines=["HN 1234567 ชื่อ สมชาย", "ERROR E:\\\\secret\\\\path"], error="เกิดข้อผิดพลาดที่ E:\\\\secret")
    base.update(kw)
    return Job(**base)


def test_digest_ไม่มีข้อมูลลับ():
    d = ai_digest.build_digest(_job())
    blob = ai_digest.build_prompt(d)
    for secret in ["ข้อมูลลับ", "โมเดลชื่อลับ", "สมชาย", "1234567", "secret", "E:\\"]:
        assert secret not in blob
    assert len(d["loss_points"]) <= ai_digest.MAX_POINTS
    assert d["loss_points"][0]["step"] == 0 or d["loss_points"][0]["step"] == 2  # คงจุดแรกไว้
    assert d["loss_points"][-1]["step"] == 198                                    # คงจุดท้ายไว้
    assert set(d) == {"base_model", "status", "settings", "loss_points"}


@pytest.fixture
def client():
    from main import app
    with TestClient(app) as c:
        yield c


def test_ดูข้อมูลที่จะส่งก่อน_และต้องยืนยันถึงส่ง(client, monkeypatch):
    manager.jobs["j-ai"] = _job()
    called = []

    async def fake(prompt):
        called.append(prompt)
        return "สรุป: loss ลงดี"
    monkeypatch.setattr(ai_provider, "generate_text", fake)
    r = client.get("/api/jobs/j-ai/ai-digest")
    assert r.status_code == 200 and "สมชาย" not in r.text and called == []
    assert client.post("/api/jobs/j-ai/ai-summary", json={"confirm": False}).status_code == 400
    assert called == []
    ok = client.post("/api/jobs/j-ai/ai-summary", json={"confirm": True}).json()
    assert ok == {"ok": True, "text": "สรุป: loss ลงดี"} and len(called) == 1
    assert "สมชาย" not in called[0] and "ข้อมูลลับ" not in called[0]


def test_ระหว่างเทรนไม่ส่ง(client):
    manager.jobs["j-ai2"] = _job(id="j-ai2", status="training")
    assert client.post("/api/jobs/j-ai2/ai-summary", json={"confirm": True}).status_code == 409


def test_ไม่มีคีย์คืนข้อความอธิบาย(client, monkeypatch):
    manager.jobs["j-ai3"] = _job(id="j-ai3")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    r = client.post("/api/jobs/j-ai3/ai-summary", json={"confirm": True}).json()
    assert r["ok"] is False and "GEMINI_API_KEY" in r["error"]


def test_gpu_live_ไม่พังเมื่อไม่มีการ์ด(client):
    r = client.get("/api/system/gpu-live")
    assert r.status_code == 200
    assert {"gpu", "ts", "cpu_pct", "ram_used_gb", "net_rx"} <= set(r.json())
