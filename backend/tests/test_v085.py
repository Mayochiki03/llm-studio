"""ทดสอบ 0.8.5: ตรวจเลขในคำตอบ, กฎคำตอบสำเร็จรูป, กันถามซ้ำ/สแปม, คะแนนค้น, ข้อสอบชุดตัวอย่างที่ปรับแล้ว"""
import pytest

import abuse
import evalreport
import faqbuilder
import guard


# ------------------------------------------------------------------ ตรวจเลข
DOCS = ["เบอร์โทรห้องฉุกเฉิน 074-999-123 เปิด 08.00-16.30 น."]


def test_verify_numbers_ผ่านเมื่อเลขอยู่ในเอกสาร():
    assert guard.verify_numbers("โทร 074-999-123 ได้ค่ะ เปิด 08.00", DOCS) is None


def test_verify_numbers_จับเลขที่แต่งเอง():
    r = guard.verify_numbers("โทร 074-123-456 ได้ค่ะ", DOCS)
    assert r and r["kind"] == "unverified_number" and "074-123-456" in r["numbers"] and r["reply"]


def test_verify_numbers_เลขอนุญาตและไม่มีเอกสาร():
    assert guard.verify_numbers("สายด่วน 1323 ตลอด 24 ชั่วโมง", DOCS) is None        # อยู่ในรายการอนุญาต
    assert guard.verify_numbers("โทร 074-123-456", []) is None                         # ไม่มีเอกสาร = ตรวจไม่ได้
    sc = guard.validate_scope({**guard.DEFAULT_SCOPE, "verify_numbers": False})
    assert guard.verify_numbers("โทร 074-123-456", DOCS, sc) is None                   # ปิดใช้


def test_verify_numbers_ตรงแบบตัวเลขล้วนแม้เขียนต่างรูป():
    assert guard.verify_numbers("โทร 074999123", ["โทร 074-999-123"]) is None


def test_scope_ใหม่_validate():
    sc = guard.validate_scope({"no_info_reply": "ไม่มีข้อมูล", "number_whitelist": ["1 6 6 9", "  "], "number_reply": " ", "verify_numbers": 0})
    assert sc["number_whitelist"] == ["1669"] and sc["number_reply"] and sc["verify_numbers"] is False


# ------------------------------------------------------------------ กฎสำเร็จรูป
def test_canned_ตอบตายตัวและเคสอันตรายมาก่อน():
    r = guard.check_rules("คุณคือใครคะ")
    assert r and r["kind"] == "canned" and r["rule_id"] == "identity"
    mixed = guard.check_rules("คุณคือใคร ฉันอยากตาย")
    assert mixed and mixed["kind"] == "red_flag"


def test_canned_ผ่าน_validate():
    sc = guard.validate_scope({"no_info_reply": "ไม่มีข้อมูล", "rules": [{"id": "x", "name": "n", "kind": "canned", "keywords": ["ขอบคุณ"], "reply": "ยินดีค่ะ"}]})
    assert sc["rules"][0]["kind"] == "canned"
    with pytest.raises(ValueError):
        guard.validate_scope({"no_info_reply": "ไม่มีข้อมูล", "rules": [{"id": "x", "name": "n", "kind": "weird", "keywords": ["a"], "reply": "b"}]})


# ------------------------------------------------------------------ กันถามซ้ำ
def _run(cfg_raw, n, interval=5.0, q="ขอเวลาทำการ"):
    return abuse.simulate(cfg_raw, q, n, interval)["rows"]


def test_abuse_ขั้นบันไดตามเกณฑ์ปกติ():
    rows = _run({"preset": "normal"}, 10)
    acts = [r["action"] for r in rows]
    # ครั้ง 1-2 ผ่าน, 3-4 แคช, 5-7 เตือน, 8 พัก, หลังพักยังพักอยู่
    assert acts[:2] == ["allow", "allow"] and acts[2:4] == ["cached", "cached"] and acts[4:7] == ["warn"] * 3
    assert acts[7] == "block" and rows[7]["retry_after"] == 60 and acts[8] == "block" and rows[8]["reason"] == "cooldown"


def test_abuse_พักครั้งถัดไปนานขึ้นและล้างได้เมื่อสงบ():
    cfg = abuse.validate({"preset": "strict"})
    st = abuse._new_state()
    t = 1000.0
    durs = []
    for _ in range(3):
        while True:                                    # ถามจนโดนพัก
            r = abuse.check("c", "ถามซ้ำ", now=t, state=st, cfg=cfg)
            t += 1
            if r["action"] == "block" and r["reason"] == "repeat":
                durs.append(r["retry_after"])
                t = st["cooldown_until"] + 1
                break
    assert durs == [120, 900, 3600]
    t += cfg["strike_decay_s"] + 10                    # สงบนาน → ล้าง strikes
    while True:
        r = abuse.check("c", "ถามซ้ำ", now=t, state=st, cfg=cfg)
        t += 1
        if r["reason"] == "repeat" and r["action"] == "block":
            break
    assert r["retry_after"] == 120                     # กลับไปพักสั้นสุดอีกครั้ง


def test_abuse_ข้อความต่างกันไม่นับเป็นซ้ำ_และสำนวนเดียวกันนับรวม():
    st, cfg = abuse._new_state(), abuse.validate({})
    for i in range(10):
        assert abuse.check("c", f"คำถามที่ {i}", now=1000 + i * 10, state=st, cfg=cfg)["action"] == "allow"
    st2 = abuse._new_state()
    seq = ["เปิดกี่โมง", "เปิด กี่โมง?", "เปิดกี่โมง!!", "เปิดกี่โมง"]
    acts = [abuse.check("c", q, now=1000 + i, state=st2, cfg=cfg)["action"] for i, q in enumerate(seq)]
    assert acts == ["allow", "allow", "cached", "cached"]


def test_abuse_เพดานต่อนาทีและความยาว():
    cfg = abuse.validate({"rate_per_min": 5, "cache_after": 50, "warn_after": 60, "block_after": 70})
    st = abuse._new_state()
    acts = [abuse.check("c", f"q{i}", now=1000 + i * 0.1, state=st, cfg=cfg) for i in range(8)]
    assert acts[4]["action"] == "allow" and acts[5]["action"] == "block" and acts[5]["reason"] == "rate"
    long = abuse.check("c2", "ก" * 5000, now=2000, state=abuse._new_state(), cfg=abuse.validate({}))
    assert long["action"] == "block" and long["reason"] == "long"


def test_abuse_ปิดใช้และ_validate():
    assert all(r["action"] == "allow" for r in _run({"enabled": False}, 15))
    with pytest.raises(ValueError):
        abuse.validate({"cache_after": 9, "warn_after": 3, "block_after": 5})
    with pytest.raises(ValueError):
        abuse.validate({"cooldown_s": []})
    with pytest.raises(ValueError):
        abuse.validate({"rate_per_min": "x"})


def test_abuse_simulate_สรุปประหยัด():
    r = abuse.simulate({"preset": "normal"}, "ทดสอบ", 12, 5)
    assert r["total"] == 12 and r["model_calls"] == 2 and r["saved"] == 10


# ------------------------------------------------------------------ API
def _setup(client):
    k = client.post("/api/apikeys", json={"name": "bot"}).json()
    v = client.post("/api/registry", json={"name": "m"}).json()
    client.post(f"/api/registry/{v['id']}/approve")
    client.post(f"/api/registry/{v['id']}/activate")
    return {"Authorization": f"Bearer {k['key']}"}


def test_api_ask_ถามซ้ำ_แคช_เตือน_พัก429(client):
    h = _setup(client)
    q = {"question": "ขอเวลาทำการหน่อย", "use_kb": False}
    modes = []
    for _ in range(7):
        modes.append(client.post("/api/v1/ask", json=q, headers=h).json()["mode"])
    assert modes[:2] == ["off", "off"] and modes[2:4] == ["cache", "cache"] and modes[4:] == ["abuse"] * 3
    r = client.post("/api/v1/ask", json=q, headers=h)
    assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1 and r.json()["detail"]["retry_after"] >= 1
    st = client.get("/api/abuse").json()["status"]
    assert st["cooling"] and st["counters"]["block"] >= 1
    assert all("ขอเวลาทำการ" not in str(e) for e in st["events"])             # ไม่เก็บตัวข้อความคำถาม
    # ปลดล็อก
    assert client.post("/api/abuse/unlock", json={"client": st["cooling"][0]["client"]}).json()["ok"] is True
    assert client.post("/api/v1/ask", json=q, headers=h).status_code == 200


def test_api_ask_เคสอันตรายไม่ถูกจำกัด(client):
    h = _setup(client)
    for _ in range(15):
        r = client.post("/api/v1/ask", json={"question": "ฉันอยากตาย"}, headers=h)
        assert r.status_code == 200 and r.json()["mode"] == "guard" and "1323" in r.json()["answer"]


def test_api_ask_แยกผู้ใช้ด้วย_client_id(client):
    h = _setup(client)
    for _ in range(8):
        client.post("/api/v1/ask", json={"question": "ซ้ำ", "use_kb": False, "client_id": "A"}, headers=h)
    assert client.post("/api/v1/ask", json={"question": "ซ้ำ", "use_kb": False, "client_id": "A"}, headers=h).status_code == 429
    assert client.post("/api/v1/ask", json={"question": "ซ้ำ", "use_kb": False, "client_id": "B"}, headers=h).status_code == 200


def test_api_ask_แก้เลขที่แต่งเอง(client, monkeypatch):
    import ollama_client

    async def chat(model, messages, options=None, keep_alive=None, timeout=300):
        return {"reply": "โทร 074-123-456 ได้เลย", "eval_count": 1, "eval_duration_s": 1, "total_s": 1, "tokens_per_s": 1}

    monkeypatch.setattr(ollama_client, "chat", chat)
    h = _setup(client)
    client.post("/api/kb/docs", json={"title": "เบอร์", "text": "เบอร์โทรห้องฉุกเฉิน 074-999-123"})
    r = client.post("/api/v1/ask", json={"question": "เบอร์โทรห้องฉุกเฉิน"}, headers=h).json()
    assert "074-123-456" not in r["answer"] and r["guard"]["kind"] == "unverified_number"


def test_api_abuse_config_และ_simulate(client):
    d = client.get("/api/abuse").json()
    assert d["config"]["enabled"] and set(d["presets"]) == {"lenient", "normal", "strict"}
    r = client.put("/api/abuse", json={"preset": "strict"})
    assert r.status_code == 200 and r.json()["config"]["block_after"] == 4 and r.json()["config"]["preset"] == "strict"
    r = client.put("/api/abuse", json={"cache_after": 1, "warn_after": 2, "block_after": 9})
    assert r.json()["config"]["preset"] == "custom"
    assert client.put("/api/abuse", json={"cache_after": 9, "warn_after": 3}).status_code == 400
    sim = client.post("/api/abuse/simulate", json={"config": {"preset": "lenient"}, "question": "x", "repeats": 5, "interval_s": 1}).json()
    assert sim["total"] == 5 and sim["rows"][0]["action"] == "allow"
    assert client.post("/api/abuse/simulate", json={"config": {"cache_after": 9, "warn_after": 1}}).status_code == 400
    assert client.post("/api/abuse/reset").json()["ok"]


def test_playground_แทนที่ข้อความเมื่อเลขไม่ตรง(client, monkeypatch):
    import json
    import ollama_client

    async def chat_stream(model, messages, options=None, keep_alive=None):
        yield {"delta": "โทร 074-123-"}
        yield {"delta": "456"}
        yield {"done": True}

    monkeypatch.setattr(ollama_client, "chat_stream", chat_stream)
    client.post("/api/kb/docs", json={"title": "เบอร์", "text": "เบอร์โทรห้องฉุกเฉิน 074-999-123"})
    r = client.post("/api/playground/chat", json={"model": "m", "message": "เบอร์โทรห้องฉุกเฉิน"})
    evs = [json.loads(x) for x in r.text.splitlines() if x]
    assert any(e["type"] == "replace" and e["guard"] == "unverified_number" for e in evs)
    # ปิดขอบเขต = ไม่แทนที่
    r2 = client.post("/api/playground/chat", json={"model": "m", "message": "เบอร์โทรห้องฉุกเฉิน", "apply_scope": False})
    assert not any('"replace"' in x for x in r2.text.splitlines())


# ------------------------------------------------------------------ ข้อสอบชุดตัวอย่าง / คะแนนค้น
def test_faqbuilder_ข้อสอบมีคำตอบทางเลือกและตัวหลอกใกล้เคียง():
    pool = ["เวลาทำการ เปิด 08.00", "ค่ารักษา ใช้สิทธิบัตรทอง", "เบอร์โทร 074-999-123", "ขั้นตอนนัดหมาย โทรนัด"]
    top = faqbuilder._closest("ขอเบอร์โทรห้องจ่ายยา", pool, 0)
    assert top and "เบอร์โทร" in top


def test_evalreport_csv_มีคะแนนค้น():
    res = {"models": ["a"], "use_kb": True, "summaries": {"a": {}}, "rows": [
        {"prompt_id": "1", "prompt_text": "q", "category": "c", "red_flag": False, "expect": [], "must_not": [],
         "answers": {"a": {"response": "x", "passed": True, "missing": [], "violated": [], "guard": None, "sources": ["d"], "top_score": 0.42,
                           "reply_original": None}}}]}
    csv_text = evalreport.to_csv(res)
    assert "คะแนนค้นสูงสุด" in csv_text and "0.42" in csv_text
