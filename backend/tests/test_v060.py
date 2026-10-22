"""ทดสอบฟีเจอร์ใหม่ใน 0.6.0: log/วินิจฉัย, คีย์ API และ /api/v1, ตรวจ PII ในคลังความรู้, ชุดทดสอบการค้น, สำรองอัตโนมัติ"""
import pytest

CID = "1101700230678"  # เลขบัตรสมมติที่ checksum ถูกต้อง


# ------------------------------------------------------------------ log / วินิจฉัย
def test_client_log_open_and_rate_limited(client):
    r = client.post("/api/client-log", json={"kind": "render", "message": "boom", "stack": "at X", "page": "/playground"})
    assert r.json()["ok"] is True
    lines = client.get("/api/system/logs/client").json()["lines"]
    assert any("boom" in ln and "/playground" in ln for ln in lines)
    # เกิน 60 รายการ/นาที ต้องไม่บันทึกเพิ่ม (กัน log ท่วม)
    for _ in range(70):
        last = client.post("/api/client-log", json={"message": "spam"}).json()["ok"]
    assert last is False


def test_client_log_works_without_login(client):
    client.post("/api/auth/set-password", json={"password": "password123"})
    try:
        assert client.get("/api/settings").status_code == 401          # ต้องล็อกอิน
        assert client.post("/api/client-log", json={"message": "x"}).status_code == 200  # แต่รายงาน error ได้เสมอ
    finally:
        tok = client.post("/api/auth/login", json={"password": "password123"}).json()["token"]
        client.post("/api/auth/disable", headers={"Authorization": f"Bearer {tok}"})


def test_unhandled_exception_logged_with_reference(monkeypatch):
    import main
    import registry
    from fastapi.testclient import TestClient

    def boom():
        raise RuntimeError("พังจำลอง")

    monkeypatch.setattr(registry, "list_all", boom)
    with TestClient(main.app, raise_server_exceptions=False) as c:
        r = c.get("/api/registry")
        assert r.status_code == 500
        detail = r.json()["detail"]
        assert "รหัสอ้างอิง" in detail
        ref = detail.split("รหัสอ้างอิง ")[1].split(")")[0]
        lines = c.get("/api/system/logs/backend?lines=50").json()["lines"]
        assert any(ref in ln for ln in lines) and any("พังจำลอง" in ln for ln in lines)


def test_diagnostics_has_no_secrets(client):
    client.post("/api/auth/set-password", json={"password": "password123"})
    try:
        tok = client.post("/api/auth/login", json={"password": "password123"}).json()["token"]
        d = client.get("/api/system/diagnostics", headers={"Authorization": f"Bearer {tok}"}).json()
        text = str(d)
        assert "hash" not in d["settings"]["auth"] and "secret" not in d["settings"]["auth"]
        assert "password123" not in text
        assert {"python", "platform", "hardware", "ollama_up", "backend_log_tail"} <= d.keys()
    finally:
        client.post("/api/auth/disable", headers={"Authorization": f"Bearer {tok}"})


def test_unknown_log_name_404(client):
    assert client.get("/api/system/logs/passwd").status_code == 404
    assert client.get("/api/system/logs/..%2Fx/download").status_code in (404, 405)


# ------------------------------------------------------------------ คีย์ API และ /api/v1
def _activate_model(client, name="sud-model"):
    v = client.post("/api/registry", json={"name": name}).json()
    client.post(f"/api/registry/{v['id']}/approve")
    client.post(f"/api/registry/{v['id']}/activate")
    return v


def test_apikey_lifecycle_and_v1_auth(client):
    k = client.post("/api/apikeys", json={"name": "SUD web"}).json()
    assert k["key"].startswith("sk-llmstudio-")
    listed = client.get("/api/apikeys").json()
    assert listed[0]["name"] == "SUD web" and "key" not in listed[0] and "key_hash" not in listed[0]
    assert client.post("/api/apikeys", json={"name": "  "}).status_code == 400

    assert client.get("/api/v1/health").status_code == 401                      # ไม่มีคีย์
    assert client.get("/api/v1/health", headers={"Authorization": "Bearer sk-llmstudio-wrong"}).status_code == 401
    h = {"Authorization": f"Bearer {k['key']}"}
    r = client.get("/api/v1/health", headers=h)
    assert r.status_code == 200 and r.json()["model"] is None
    assert client.get("/api/apikeys").json()[0]["use_count"] >= 1

    client.post(f"/api/apikeys/{k['id']}/enabled", json={"enabled": False})     # ปิดคีย์
    assert client.get("/api/v1/health", headers=h).status_code == 401
    client.post(f"/api/apikeys/{k['id']}/enabled", json={"enabled": True})
    assert client.get("/api/v1/health", headers=h).status_code == 200
    assert client.delete(f"/api/apikeys/{k['id']}").status_code == 200
    assert client.get("/api/v1/health", headers=h).status_code == 401


def test_v1_ask_needs_active_model_then_answers_with_sources(client):
    k = client.post("/api/apikeys", json={"name": "line-bot"}).json()
    h = {"Authorization": f"Bearer {k['key']}"}
    assert client.post("/api/v1/ask", json={"question": "สวัสดี"}, headers=h).status_code == 503
    assert client.get("/api/v1/model", headers=h).status_code == 404

    client.post("/api/kb/docs", json={"title": "สายด่วน", "text": "สายด่วนสุขภาพจิต โทร 1323 ตลอด 24 ชั่วโมง"})
    _activate_model(client)
    assert client.get("/api/v1/model", headers=h).json()["name"] == "sud-model"
    r = client.post("/api/v1/ask", json={"question": "สายด่วนสุขภาพจิตเบอร์อะไร"}, headers=h)
    assert r.status_code == 200
    body = r.json()
    assert "1323" in body["answer"] and body["model"] == "sud-model"
    assert body["sources"] and body["sources"][0]["title"] == "สายด่วน"

    # ไม่ใช้คลังความรู้ → ไม่มีแหล่งที่มา
    r2 = client.post("/api/v1/ask", json={"question": "ทดสอบ", "use_kb": False}, headers=h).json()
    assert r2["sources"] == [] and r2["mode"] == "off"

    # คำถามว่าง/ยาวเกินถูกปฏิเสธ
    assert client.post("/api/v1/ask", json={"question": "  "}, headers=h).status_code == 400
    assert client.post("/api/v1/ask", json={"question": "ก" * 4001}, headers=h).status_code == 400

    # audit ต้องไม่เก็บเนื้อหาคำถาม (อาจมีข้อมูลผู้ป่วย)
    audit = client.get("/api/system/audit?limit=50&action=api.").json()
    assert audit and all("สายด่วนสุขภาพจิตเบอร์อะไร" not in str(a) for a in audit)
    assert any(a["actor"] == "key:line-bot" for a in audit)


def test_v1_ask_ollama_error_is_502(client, monkeypatch):
    import ollama_client

    async def bad_chat(*a, **kw):
        return {"error": "ollama down"}

    monkeypatch.setattr(ollama_client, "chat", bad_chat)
    k = client.post("/api/apikeys", json={"name": "x"}).json()
    _activate_model(client)
    r = client.post("/api/v1/ask", json={"question": "hi"}, headers={"Authorization": f"Bearer {k['key']}"})
    assert r.status_code == 502 and "ollama down" in r.json()["detail"]


def test_v1_rate_limit(client, monkeypatch):
    import apikeys
    monkeypatch.setattr(apikeys, "RATE_PER_MIN", 3)
    k = client.post("/api/apikeys", json={"name": "x"}).json()
    h = {"Authorization": f"Bearer {k['key']}"}
    codes = [client.get("/api/v1/health", headers=h).status_code for _ in range(5)]
    assert codes[:3] == [200, 200, 200] and codes[3] == 429


def test_v1_works_when_admin_login_enabled_and_session_token_is_not_a_key(client):
    k = client.post("/api/apikeys", json={"name": "svc"}).json()
    client.post("/api/auth/set-password", json={"password": "password123"})
    try:
        tok = client.post("/api/auth/login", json={"password": "password123"}).json()["token"]
        assert client.get("/api/v1/health", headers={"Authorization": f"Bearer {k['key']}"}).status_code == 200
        assert client.get("/api/v1/health", headers={"Authorization": f"Bearer {tok}"}).status_code == 401  # โทเคนแอดมินใช้เป็นคีย์ไม่ได้
        assert client.get("/api/apikeys", headers={"Authorization": f"Bearer {k['key']}"}).status_code == 401  # คีย์ใช้เข้าหน้าแอดมินไม่ได้
    finally:
        tok = client.post("/api/auth/login", json={"password": "password123"}).json()["token"]
        client.post("/api/auth/disable", headers={"Authorization": f"Bearer {tok}"})


# ------------------------------------------------------------------ PII ในคลังความรู้
def test_kb_pii_gate_text_qa_update_upload(client):
    r = client.post("/api/kb/docs", json={"title": "ผู้ป่วย", "text": f"เลขบัตร {CID} มาตามนัด"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "pii"
    assert CID not in str(r.json())                                   # ต้องไม่ส่งค่าจริงเต็มกลับมา
    assert client.get("/api/kb/stats").json()["docs"] == 0

    ok = client.post("/api/kb/docs", json={"title": "ผู้ป่วย", "text": f"เลขบัตร {CID}", "pii_ack": True})
    assert ok.status_code == 200
    doc_id = ok.json()["doc"]["id"]

    qa = client.post("/api/kb/qa", json={"question": "ติดต่อ", "answer": "โทร 081-234-5678"})
    assert qa.status_code == 409

    clean = client.post("/api/kb/docs", json={"title": "ทั่วไป", "text": "ข้อมูลทั่วไป"}).json()["doc"]["id"]
    upd = client.put(f"/api/kb/docs/{clean}", json={"text": "อีเมล a.b@example.com"})
    assert upd.status_code == 409

    up = client.post("/api/kb/upload", files=[("files", ("a.txt", f"ผู้ป่วย HN 1234567 เลข {CID}".encode(), "text/plain"))])
    assert up.json()["added"] == 0 and up.json()["files"][0]["pii"] is True
    up2 = client.post("/api/kb/upload", files=[("files", ("a.txt", f"เลข {CID}".encode(), "text/plain"))], data={"pii_ack": "true"})
    assert up2.json()["added"] == 1

    scan = client.get("/api/kb/pii-scan").json()
    flagged_ids = {f["doc_id"] for f in scan["flagged"]}
    assert doc_id in flagged_ids and clean not in flagged_ids
    assert CID not in str(scan)


def test_kb_pii_gate_can_be_disabled(client):
    client.put("/api/settings", json={"kb_pii_block": False})
    assert client.post("/api/kb/docs", json={"title": "x", "text": f"เลข {CID}"}).status_code == 200


# ------------------------------------------------------------------ ชุดทดสอบการค้น
def test_kb_retrieval_tests(client):
    a = client.post("/api/kb/docs", json={"title": "สายด่วนสุขภาพจิต", "text": "สายด่วนสุขภาพจิต โทร 1323 ตลอด 24 ชั่วโมง"}).json()["doc"]["id"]
    b = client.post("/api/kb/docs", json={"title": "เวลาทำการ", "text": "คลินิกเปิดวันจันทร์ถึงศุกร์ เวลา 8.30 ถึง 16.30 น."}).json()["doc"]["id"]
    assert client.post("/api/kb/tests", json={"question": "", "expect_doc_ids": [a]}).status_code == 400
    assert client.post("/api/kb/tests", json={"question": "x", "expect_doc_ids": []}).status_code == 400
    t1 = client.post("/api/kb/tests", json={"question": "สายด่วนสุขภาพจิตโทรอะไร", "expect_doc_ids": [a]}).json()
    client.post("/api/kb/tests", json={"question": "คลินิกเปิดวันไหน", "expect_doc_ids": [b]})
    assert t1["expect_titles"] == ["สายด่วนสุขภาพจิต"]
    res = client.post("/api/kb/tests/run").json()
    assert res["total"] == 2 and res["hit_rate"] == 1.0 and res["mrr"] > 0.5
    assert all(r["hit"] for r in res["results"])

    # ถ้าเอกสารที่คาดไว้ถูกลบ ข้อสอบต้องตกและบอกว่าเอกสารหาย ไม่ใช่ error
    client.delete(f"/api/kb/docs/{a}")
    res2 = client.post("/api/kb/tests/run").json()
    bad = next(r for r in res2["results"] if r["id"] == t1["id"])
    assert bad["hit"] is False and bad["expect_titles"] == ["(เอกสารถูกลบแล้ว)"]
    assert client.delete(f"/api/kb/tests/{t1['id']}").status_code == 200
    assert client.delete(f"/api/kb/tests/{t1['id']}").status_code == 404


def test_kb_retrieval_tests_empty(client):
    res = client.post("/api/kb/tests/run").json()
    assert res["total"] == 0 and res["hit_rate"] is None


# ------------------------------------------------------------------ สำรองอัตโนมัติ
def test_auto_backup_due_and_prune(client):
    import os
    import sysops
    import config
    assert sysops.auto_backup_due() is True
    b = sysops.create_backup(auto=True)
    assert b["name"].startswith("studio-backup-auto-")
    assert sysops.auto_backup_due() is False
    assert sysops.auto_backup_due(max_age_h=0) is True

    manual = sysops.create_backup()                      # ไฟล์ที่กดเองต้องไม่ถูก prune
    for i in range(4):
        p = config.BACKUP_DIR / f"studio-backup-auto-20200101-00000{i}.zip"
        p.write_bytes(b"PK")
        os.utime(p, (1000 + i, 1000 + i))
    removed = sysops.prune_auto_backups(2)
    assert removed == 3
    names = {x["name"] for x in sysops.list_backups()}
    assert manual["name"] in names and b["name"] in names
    assert len([n for n in names if "-auto-" in n]) == 2


def test_new_settings_validated(client):
    assert client.put("/api/settings", json={"auto_backup": False, "backup_keep": 3}).json()["auto_backup"] is False
    assert client.put("/api/settings", json={"backup_keep": "x"}).status_code == 400
