"""0.8.0: Gemini fallback, ตัวตรวจคำปฏิเสธหลายแบบ, ข้อมูลทักทาย/ตัวตน"""
import asyncio

import httpx
import pytest

import ai_provider
import evalx
import faqbuilder


def test_expect_ทางเลือกด้วยขีดตั้ง():
    p = {"expect": ["ไม่มีข้อมูล|ไม่สามารถ"]}
    assert evalx.check_reply(p, "ขออภัยค่ะ ฉันไม่สามารถช่วยเขียนโปรแกรมได้")["passed"] is True
    assert evalx.check_reply(p, "โทร 074-999-123")["passed"] is False


def test_ข้อสอบนอกขอบเขตรับคำปฏิเสธหลายแบบ():
    r = faqbuilder.build([])
    oos = [e for e in r["eval"] if e["category"] == "นอกขอบเขต"]
    assert oos and all(evalx.check_reply(e, "ฉันไม่สามารถช่วยเรื่องนี้ได้ค่ะ")["passed"] for e in oos)


def test_มีตัวอย่างทักทายและถามชื่อ():
    r = faqbuilder.build([])
    qs = {t["instruction"] for t in r["train"]}
    assert {"คุณชื่ออะไร", "สวัสดีครับ", "คุณทำอะไรได้บ้าง"} <= qs
    gen = [e for e in r["eval"] if e["category"] == "ทั่วไป"]
    assert gen and all("ไม่มีข้อมูล" in e["must_not"] for e in gen)


def test_gemini_ข้ามรุ่นที่_timeout(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setattr(ai_provider, "_working_model", None)
    monkeypatch.setattr(ai_provider, "_CANDIDATE_MODELS", ["slow", "good"])
    calls = []

    async def fake(client, model, key, prompt):
        calls.append(model)
        if model == "slow":
            raise ai_provider._ModelRetired("ReadTimeout")
        return {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
    monkeypatch.setattr(ai_provider, "_call_model", fake)
    assert asyncio.run(ai_provider.generate_text("x")) == "ok"
    assert calls == ["slow", "good"] and ai_provider._working_model == "good"


def test_gemini_ล้มทุกรุ่นมีข้อความชัด(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setattr(ai_provider, "_working_model", None)
    monkeypatch.setattr(ai_provider, "_CANDIDATE_MODELS", ["a"])

    async def fake(client, model, key, prompt):
        raise ai_provider._ModelRetired(ai_provider._describe(httpx.ReadTimeout("")))

    async def no_list():
        return []
    monkeypatch.setattr(ai_provider, "_call_model", fake)
    monkeypatch.setattr(ai_provider, "list_models", no_list)
    with pytest.raises(ai_provider.AIProviderError) as e:
        asyncio.run(ai_provider.generate_text("x"))
    assert "a: ReadTimeout" in str(e.value) and "GEMINI_MODEL" in str(e.value)


# ---------------- ตารางแก้ไขชุดข้อมูล + ตรวจชื่อผลลัพธ์ ----------------
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from main import app
    with TestClient(app) as c:
        yield c


def _make_ds(client, n=3):
    ex = [{"instruction": f"คำถาม{i}", "input": "", "output": f"คำตอบ{i}"} for i in range(n)]
    client.post("/api/catalog/custom-datasets", json={"label": "ed", "examples": ex})
    return [d for d in client.get("/api/catalog/datasets").json() if d["kind"] == "custom"][-1]["id"]


def test_ตารางแก้ไข_โหลดและบันทึกเป็นเวอร์ชันใหม่(client):
    ds = _make_ds(client)
    r = client.get(f"/api/datasets/{ds}/examples").json()
    assert r["total"] == 3 and r["version"] == 1
    rows = r["examples"]
    rows[0]["output"] = "แก้แล้ว"
    rows.append({"instruction": "ใหม่", "output": "ตอบใหม่"})
    rows.append({"instruction": "", "output": ""})  # แถวว่างทั้งคู่ = ทิ้ง
    ok = client.put(f"/api/datasets/{ds}/examples", json={"examples": rows}).json()
    assert ok["version"] == 2 and ok["count"] == 4
    again = client.get(f"/api/datasets/{ds}/examples").json()
    assert again["examples"][0]["output"] == "แก้แล้ว" and again["total"] == 4
    assert len(client.get(f"/api/datasets/{ds}/versions").json()) == 2  # ของเดิมยังอยู่


def test_ตารางแก้ไข_แถวไม่ครบถูกปฏิเสธ(client):
    ds = _make_ds(client)
    r = client.put(f"/api/datasets/{ds}/examples", json={"examples": [{"instruction": "มีแต่คำถาม", "output": ""}]})
    assert r.status_code == 400 and "แถวที่ 1" in r.json()["detail"]
    assert client.get(f"/api/datasets/{ds}/examples").json()["version"] == 1  # ไม่เกิดเวอร์ชันใหม่


def test_ตารางแก้ไข_ชุดของระบบแก้ไม่ได้(client):
    assert client.get("/api/datasets/Thaweewat%2Fx/examples").status_code == 404


def test_ชื่อผลลัพธ์_ว่าง_ผิดรูป_ซ้ำ(client):
    base = {"base_model": "scb10x/llama3.2-typhoon2-3b-instruct", "dataset": "Thaweewat/x", "force": True}
    assert client.post("/api/jobs", json={**base, "output_name": "  "}).status_code == 400
    assert client.post("/api/jobs", json={**base, "output_name": "ชื่อไทย"}).status_code == 400
    assert client.post("/api/jobs", json={**base, "output_name": "../x"}).status_code == 400
    ok = client.post("/api/jobs", json={**base, "output_name": "dup-name"})
    assert ok.status_code == 200
    again = client.post("/api/jobs", json={**base, "output_name": "DUP-name"})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "name_taken"


# ---------------- 0.8.1: ลดความซ้ำ + รายงานคุณภาพ + ให้ Gemini ช่วยคิด ----------------
import json as _json
import datasets_mgr
import load_sample_pack


def test_ไม่คูณคำนำหน้าทุกแบบ_และหมุนคำตอบสำนวน():
    facts = [{"topic": "t", "answer": "เปิด 08.00 ค่ะ", "answers_alt": ["เวลา 08.00 นะคะ", "ไม่มีเวลา"],
              "questions": [f"q{i}" for i in range(4)], "keywords": ["08.00"]}]
    r = faqbuilder.build(facts, include_defaults=False, out_of_scope=[])
    assert r["stats"]["alt_dropped"] == 1                      # คำตอบสำรองที่ไม่มีคำสำคัญถูกตัด
    ts = [t for t in r["train"] if t["group"].startswith("t|")]
    assert len(ts) == 6                                        # 3 คำถามเทรน × 2 สำนวน (เดิม × 5)
    assert {t["output"] for t in ts} == {"เปิด 08.00 ค่ะ", "เวลา 08.00 นะคะ"}


def test_คำตอบไม่มีข้อมูลหลายแบบ_ยังมีวลีให้ตรวจ():
    assert len(faqbuilder.UNKNOWN_VARIANTS) >= 3 and all("ไม่มีข้อมูล" in a for a in faqbuilder.UNKNOWN_VARIANTS)
    r = faqbuilder.build([])
    outs = {t["output"] for t in r["train"] if t["group"].startswith("oos|")}
    assert len(outs) == len(faqbuilder.UNKNOWN_VARIANTS)
    r2 = faqbuilder.build([], unknown_answer="ไม่ทราบค่ะ")
    assert {t["output"] for t in r2["train"] if t["group"].startswith("oos|")} == {"ไม่ทราบค่ะ"}


def test_แพ็ก2_ข้อมูลน้อยลงแต่หลากหลาย():
    facts = _json.loads((load_sample_pack.PACK2_DIR / "facts.json").read_text(encoding="utf-8"))
    r = faqbuilder.build(facts)
    assert 250 < r["stats"]["train"] < 500 and r["stats"]["alt_dropped"] == 0
    q = datasets_mgr.quality_report(r["train"])
    assert q["answer_diversity"] > 0.12 and q["top_answer_share"] < 0.15 and not q["warnings"]


def test_รายงานคุณภาพจับคำตอบซ้ำและคำถามคล้าย():
    rows = [{"instruction": f"เปิดกี่โมงคะ{i}", "output": "เหมือนกัน"} for i in range(1)]
    rows += [{"instruction": "ขอเบอร์โทรโรงพยาบาลหน่อยค่ะ", "output": "เหมือนกัน"}, {"instruction": "ขอเบอร์โทรโรงพยาบาลหน่อยครับ", "output": "เหมือนกัน"}]
    q = datasets_mgr.quality_report(rows)
    assert q["unique_answers"] == 1 and q["top_answer_share"] == 1.0 and q["warnings"]
    assert q["near_dup_pairs"] == 1
    same_group = [{"instruction": "ขอเบอร์โทรโรงพยาบาลหน่อยค่ะ", "output": "a", "group": "g"}, {"instruction": "ขอเบอร์โทรโรงพยาบาลหน่อยครับ", "output": "b", "group": "g"}]
    assert datasets_mgr.quality_report(same_group)["near_dup_pairs"] == 0


def test_api_คุณภาพและพรีวิว(client):
    ds = _make_ds(client)
    assert client.get(f"/api/datasets/{ds}/quality").json()["total"] == 3
    facts = [{"topic": "t", "answer": "a", "questions": ["q1", "q2"], "keywords": []}]
    pv = client.post("/api/datasets/facts-preview", json={"label": "x", "facts": facts}).json()
    assert pv["quality"]["total"] == pv["stats"]["train"]


def test_suggest_ต้องยืนยัน_บล็อก_PII_และกรองข้อซ้ำ(client, monkeypatch):
    body = {"kind": "questions", "topic": "เวลา", "answer": "เปิด 08.00", "questions": ["เปิดกี่โมง"], "n": 3}
    assert client.post("/api/datasets/suggest", json=body).status_code == 400            # ยังไม่ยืนยัน
    sent = []

    async def fake(prompt):
        sent.append(prompt)
        return "1. เปิดกี่โมง\n- วันเสาร์เปิดไหมคะ\n• เปิดกี่โมงครับ\nวันเสาร์เปิดไหมคะ"
    monkeypatch.setattr(ai_provider, "generate_text", fake)
    ok = client.post("/api/datasets/suggest", json={**body, "confirm": True}).json()
    assert ok["ok"] and ok["items"] == ["วันเสาร์เปิดไหมคะ", "เปิดกี่โมงครับ"]           # ตัดเลขนำหน้า ข้อซ้ำกับของเดิม และซ้ำกันเอง
    bad = client.post("/api/datasets/suggest", json={**body, "answer": "บัตร 1101700230678", "confirm": True})
    assert bad.status_code == 409 and len(sent) == 1                                      # PII ไม่ถูกส่ง
