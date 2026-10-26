"""0.8.2: ขอบเขตการตอบ (guard) ใช้กับ Playground และ API + หน้าตั้งค่าขอบเขต"""
import json
import pytest
from fastapi.testclient import TestClient

import config
import guard
import kb as kbmod
import ollama_client


@pytest.fixture
def client():
    from main import app
    with TestClient(app) as c:
        yield c


def test_กฎเคสอันตรายมาก่อนหัวข้อต้องห้าม():
    r = guard.check_rules("ช่วยนี้รู้สึกท้อมาก อยากตายไปเลย ช่วยแนะนำยาหน่อย")
    assert r["kind"] == "red_flag" and "1323" in r["reply"]
    assert guard.check_rules("ขอให้วินิจฉัยอาการให้หน่อย")["kind"] == "blocked"
    assert guard.check_rules("เปิดกี่โมง") is None


def test_ไม่จับคำที่แค่คล้าย():
    assert guard.check_rules("เขาชักชวนให้มาสมัครบำบัด") is None


def test_คุยทั่วไปผ่านแม้ไม่มีเอกสาร():
    assert guard.check_context("สวัสดีครับ", [], True) is None
    assert guard.check_context("คุณชื่ออะไร", [], True) is None
    assert guard.check_context("ที่จอดรถเสียค่าบริการไหม", [], True)["kind"] == "no_context"
    assert guard.check_context("ที่จอดรถเสียค่าบริการไหม", [{"x": 1}], True) is None   # มีเอกสาร → ปล่อยให้โมเดลตอบ
    assert guard.check_context("ที่จอดรถเสียค่าบริการไหม", [], False) is None          # ไม่ใช้คลังความรู้ → ไม่บังคับ


def test_ปิดขอบเขตแล้วไม่ทำอะไร():
    sc = {**guard.get_scope(), "enabled": False}
    assert guard.check_rules("อยากตาย", sc) is None and guard.check_context("x", [], True, sc) is None


def test_api_ตั้งขอบเขต_ตรวจรูปแบบ_และแทนที่กฎทั้งชุด(client):
    cur = client.get("/api/scope").json()
    assert len(cur["scope"]["rules"]) == len(guard.DEFAULT_RULES) and cur["default"]["require_context"] is True
    sc = cur["scope"]
    bad = client.put("/api/scope", json={"scope": {**sc, "rules": [{"kind": "x", "keywords": ["a"], "reply": "b"}]}})
    assert bad.status_code == 400
    assert client.put("/api/scope", json={"scope": {**sc, "no_info_reply": " "}}).status_code == 400
    assert client.put("/api/scope", json={"scope": sc, "kb_min_score": 2}).status_code == 400
    one = [r for r in sc["rules"] if r["id"] == "diagnosis"]
    ok = client.put("/api/scope", json={"scope": {**sc, "rules": one}, "kb_min_score": 0.3}).json()
    assert [r["id"] for r in ok["scope"]["rules"]] == ["diagnosis"] and ok["kb_min_score"] == 0.3
    assert guard.check_rules("อยากตาย") is None              # กฎที่ลบแล้วไม่กลับมา


def test_ลองข้อความกับขอบเขตโดยไม่เรียกโมเดล(client, monkeypatch):
    async def none(*a, **k): return {"hits": [], "mode": "none"}
    monkeypatch.setattr(kbmod, "search", none)
    r = client.post("/api/scope/test", json={"message": "อยากตาย"}).json()
    assert r["decision"]["kind"] == "red_flag"
    r = client.post("/api/scope/test", json={"message": "ที่จอดรถ"}).json()
    assert r["decision"]["kind"] == "no_context"


def _stream(client, msg, **kw):
    r = client.post("/api/playground/chat", json={"model": "m", "message": msg, **kw})
    return [json.loads(x) for x in r.text.splitlines() if x.strip()]


def test_playground_กฎตายตัวไม่เรียกโมเดล(client, monkeypatch):
    called = []

    async def fake(*a, **k):
        called.append(1)
        yield {"delta": "x"}
    monkeypatch.setattr(ollama_client, "chat_stream", fake)
    ev = _stream(client, "รู้สึกอยากตาย")
    assert not called and ev[0]["guard"]["kind"] == "red_flag" and "1323" in ev[1]["text"]
    # ปิดขอบเขตเฉพาะการลองนี้ → โมเดลตอบเอง
    ev = _stream(client, "รู้สึกอยากตาย", apply_scope=False, use_kb=False)
    assert called and any(e["type"] == "delta" for e in ev)


def test_playground_ไม่มีเอกสาร_ตอบไม่มีข้อมูล(client, monkeypatch):
    async def none(*a, **k): return {"hits": [], "mode": "hybrid", "note": ""}
    monkeypatch.setattr(kbmod, "search", none)
    called = []

    async def fake(*a, **k):
        called.append(1)
        yield {"delta": "x"}
    monkeypatch.setattr(ollama_client, "chat_stream", fake)
    ev = _stream(client, "ที่จอดรถเสียค่าบริการไหม")
    assert not called and "ไม่มีข้อมูล" in ev[1]["text"]
    ev = _stream(client, "สวัสดีครับ")        # ทักทายผ่านไปให้โมเดลตอบ
    assert called


def test_api_v1_ask_ใช้ขอบเขตเหมือนกัน(client, monkeypatch):
    v = client.post("/api/registry", json={"name": "sud-model"}).json()
    client.post(f"/api/registry/{v['id']}/approve")
    client.post(f"/api/registry/{v['id']}/activate")
    k = client.post("/api/apikeys", json={"name": "bot"}).json()
    h = {"Authorization": f"Bearer {k['key']}"}
    called = []

    async def fake_chat(*a, **kw):
        called.append(1)
        return {"reply": "โมเดลตอบ"}
    monkeypatch.setattr(ollama_client, "chat", fake_chat)
    r = client.post("/api/v1/ask", json={"question": "ฉันอยากตาย"}, headers=h).json()
    assert r["guard"]["kind"] == "red_flag" and "1669" in r["answer"] and r["model"] is None and not called
    r = client.post("/api/v1/ask", json={"question": "ที่จอดรถเสียเงินไหม"}, headers=h).json()
    assert r["guard"]["kind"] == "no_context" and not called
    r = client.post("/api/v1/ask", json={"question": "ที่จอดรถเสียเงินไหม", "use_kb": False}, headers=h).json()
    assert r["answer"] == "โมเดลตอบ" and called and "guard" not in r


# ---------------------------------------------------------------- 0.8.2: RAG-mode eval + ข้อมูลสอนแบบมีเอกสาร
def test_rag_format_attaches_context():
    """rag_format: ตัวอย่างที่มีข้อมูลแนบเอกสารตรงเรื่อง, นอกขอบเขตแนบเอกสารไม่เกี่ยว (ทุกข้อที่ 3 ไม่แนบ)"""
    import faqbuilder
    facts = [{"topic": "เวลาทำการ", "questions": ["เปิดกี่โมง", "ปิดกี่โมง"], "answer": "เปิด 08.00 น.", "keywords": ["08.00"]},
             {"topic": "ที่จอดรถ", "questions": ["จอดรถที่ไหน"], "answer": "จอดที่ลานด้านหน้า"}]
    plain = faqbuilder.build(facts)
    rag = faqbuilder.build(facts, rag_format=True)
    assert len(plain["train"]) == len(rag["train"])
    assert all(r["input"] == "" for r in plain["train"])
    fact_rows = [r for r in rag["train"] if r["group"].startswith("เวลาทำการ|")]
    assert fact_rows and all("เปิด 08.00 น." in r["input"] for r in fact_rows)
    oos = [r for r in rag["train"] if r["group"].startswith("oos|")]
    assert oos and any(r["input"] for r in oos) and any(not r["input"] for r in oos)
    # เอกสารที่แนบกับนอกขอบเขตต้องมาจากข้อเท็จจริงจริง และคำตอบยังเป็นปฏิเสธ
    assert all("ไม่มีข้อมูล" in r["output"] for r in oos)
    assert rag["stats"]["rag_format"] is True


def test_run_eval_use_kb_applies_guard(monkeypatch):
    """use_kb=True: เคส red flag ตอบตายตัวโดยไม่เรียกโมเดล และบันทึกว่าเป็นรอบแบบมีคลังความรู้"""
    import asyncio
    import api_studio
    import ollama_client

    calls = []

    async def fake_chat(model, messages, *a, **k):
        calls.append(messages)
        return {"reply": "ตอบจากโมเดล", "total_s": 0.1, "tokens_per_s": 10}

    async def fake_search(q, *a, **k):
        return {"mode": "keyword", "hits": [{"title": "เอกสาร", "text": "เปิด 08.00 น.", "score": 0.9}], "note": ""}

    monkeypatch.setattr(ollama_client, "chat", fake_chat)
    monkeypatch.setattr(api_studio.kb, "search", fake_search)
    p1 = api_studio.store.add_prompt("อยากตายจะทำยังไงดี", "ทดสอบ", [], [], True, False)
    p2 = api_studio.store.add_prompt("เปิดกี่โมง", "ทดสอบ", [], [], False, False)
    ids = [p["id"] for p in api_studio.store.list_prompts() if p["text"] in ("อยากตายจะทำยังไงดี", "เปิดกี่โมง")]
    run = asyncio.run(api_studio.run_eval("m", ids, True))
    assert run["use_kb"] is True
    by = {r["prompt_text"]: r for r in run["results"]}
    assert by["อยากตายจะทำยังไงดี"]["guard"] == "red_flag"
    assert by["เปิดกี่โมง"]["sources"] == ["เอกสาร"]
    assert len(calls) == 1 and "เปิด 08.00 น." in calls[0][0]["content"]  # แนบเอกสารใน system
