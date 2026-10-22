"""ทดสอบ backend แบบครบวงจรผ่าน FastAPI TestClient (ไม่ต้องมี GPU/Ollama จริง — ดู conftest.py)
รัน: cd backend && pip install pytest && python -m pytest tests -q"""
import asyncio
import io
import json
import time
import zipfile

import pytest


# ---------------------------------------------------------------- พื้นฐาน / ตั้งค่า
def test_health_and_settings(client):
    h = client.get("/api/health").json()
    assert h["ok"] and h["version"]
    s = client.get("/api/settings").json()
    assert s["embed_model"] and "salt" not in json.dumps(s["auth"])
    r = client.put("/api/settings", json={"keep_alive": "10m", "network_mode": "fast", "evil": 1})
    assert r.status_code == 200 and r.json()["keep_alive"] == "10m" and "evil" not in r.json()
    assert client.put("/api/settings", json={"network_mode": "bogus"}).status_code == 400
    assert client.put("/api/settings", json={"kb_top_k": "x"}).status_code == 400
    client.put("/api/settings", json={"network_mode": "safe"})


def test_catalog_has_14b_and_prompts_extended(client):
    ids = [m["id"] for m in client.get("/api/catalog/base-models").json()]
    assert "Qwen/Qwen2.5-14B-Instruct" in ids
    prompts = client.get("/api/eval/prompts").json()
    assert any(p.get("red_flag") for p in prompts)


# ---------------------------------------------------------------- ตัดแบ่งข้อความ
def test_chunking():
    import kb
    text = ("ประโยคทดสอบที่หนึ่ง " * 40 + "\n\n" + "อีกย่อหนึ่ง ") * 5
    chunks = kb.chunk_text(text, 300, 40)
    assert len(chunks) > 3 and all(len(c) <= 300 * 1.3 for c in chunks)
    assert kb.chunk_text("", 300, 40) == []
    assert kb.chunk_text("สั้นๆ", 300, 40) == ["สั้นๆ"]
    long_no_space = "ก" * 1000
    assert all(len(c) <= 300 for c in kb.chunk_text(long_no_space, 300, 0))


# ---------------------------------------------------------------- คลังความรู้
def test_kb_lifecycle(client):
    r = client.post("/api/kb/docs", json={"title": "เวลาทำการ", "text": "โรงพยาบาลเปิดทำการวันจันทร์ถึงศุกร์ 08.30-16.30 น. ปิดวันเสาร์อาทิตย์", "category": "ทั่วไป", "tags": ["เวลา"]})
    assert r.status_code == 200
    doc = r.json()["doc"]
    assert doc["chunks"] >= 1 and doc["embedded"] == doc["chunks"]
    qa = client.post("/api/kb/qa", json={"question": "เบอร์โทรโรงพยาบาลคืออะไร", "answer": "074-000-000", "category": "ติดต่อ"}).json()["doc"]
    assert qa["kind"] == "qa"

    hits = client.post("/api/kb/search", json={"query": "เปิดทำการวันไหน"}).json()
    assert hits["mode"] == "hybrid" and hits["hits"], hits
    assert hits["hits"][0]["doc_id"] == doc["id"]

    # ปิดใช้ → ต้องไม่ถูกค้นเจอ
    client.put(f"/api/kb/docs/{doc['id']}", json={"enabled": False})
    hits2 = client.post("/api/kb/search", json={"query": "เปิดทำการวันไหน"}).json()
    assert all(h["doc_id"] != doc["id"] for h in hits2["hits"])
    client.put(f"/api/kb/docs/{doc['id']}", json={"enabled": True})

    # แก้ไข → เวอร์ชันเพิ่ม + ย้อนกลับได้
    u = client.put(f"/api/kb/docs/{doc['id']}", json={"text": "โรงพยาบาลเปิดทุกวัน 24 ชั่วโมง"}).json()["doc"]
    assert u["version"] == 2
    hist = client.get(f"/api/kb/docs/{doc['id']}/history").json()
    first_create = [h for h in hist if h["action"] == "create"][0]
    back = client.post(f"/api/kb/docs/{doc['id']}/restore/{first_create['id']}").json()["doc"]
    assert "จันทร์ถึงศุกร์" in client.get(f"/api/kb/docs/{doc['id']}").json()["raw_text"] and back["version"] == 3

    # กรอง / สถิติ / หมวด
    assert len(client.get("/api/kb/docs", params={"category": "ติดต่อ"}).json()) == 1
    assert client.get("/api/kb/stats").json()["docs"] == 2
    assert set(client.get("/api/kb/categories").json()) == {"ทั่วไป", "ติดต่อ"}

    # ส่งออก/นำเข้า
    exp = client.get("/api/kb/export").text
    assert len(exp.strip().splitlines()) == 2
    imp = client.post("/api/kb/import", json={"text": exp}).json()
    assert imp["added"] == 2
    # ลบ
    assert client.delete(f"/api/kb/docs/{doc['id']}").status_code == 200
    assert client.get(f"/api/kb/docs/{doc['id']}").status_code == 404


def test_kb_embed_reuse_and_keyword_fallback(client, monkeypatch):
    import kb, ollama_client
    calls = {"n": 0}
    orig = ollama_client.embed

    async def counting(texts, model=None):
        calls["n"] += len(texts)
        return await orig(texts, model)

    monkeypatch.setattr(ollama_client, "embed", counting)
    client.post("/api/kb/docs", json={"title": "ก", "text": "ข้อความซ้ำกันทดสอบแคช"})
    n1 = calls["n"]
    client.post("/api/kb/docs", json={"title": "ข", "text": "ข้อความซ้ำกันทดสอบแคช"})
    assert calls["n"] == n1, "ข้อความเดียวกันต้องใช้เวกเตอร์เดิม ไม่เรียก embed ซ้ำ"

    async def broken(texts, model=None):
        return None, "ยังไม่มีโมเดลสร้างเวกเตอร์"

    monkeypatch.setattr(ollama_client, "embed", broken)
    res = client.post("/api/kb/search", json={"query": "ทดสอบแคช"}).json()
    assert res["mode"] == "keyword" and res["hits"] and res["note"]


def test_kb_upload(client):
    csv_qa = "question,answer\nเปิดกี่โมง,8 โมงเช้า\nปิดกี่โมง,4 โมงเย็น\n".encode("utf-8")
    txt = "เนื้อหาบันทึกข้อความทดสอบ".encode("cp874")
    files = [("files", ("faq.csv", csv_qa, "text/csv")), ("files", ("note.txt", txt, "text/plain")),
             ("files", ("bad.xyz", b"x", "application/octet-stream"))]
    r = client.post("/api/kb/upload", files=files, data={"category": "นำเข้า", "tags": "a, b"}).json()
    assert r["added"] == 3
    ok = {f["file"]: f["ok"] for f in r["files"]}
    assert ok == {"faq.csv": True, "note.txt": True, "bad.xyz": False}
    docs = client.get("/api/kb/docs", params={"category": "นำเข้า"}).json()
    assert {d["kind"] for d in docs} == {"qa", "file"}


def test_playground_stream(client):
    client.post("/api/kb/docs", json={"title": "เวลา", "text": "เปิดทำการ 8.30 ถึง 16.30 น."})
    r = client.post("/api/playground/chat", json={"model": "m", "message": "เปิดทำการกี่โมง", "use_kb": True})
    lines = [json.loads(l) for l in r.text.strip().splitlines()]
    assert lines[0]["type"] == "sources" and lines[0]["hits"]
    assert "".join(x["text"] for x in lines if x["type"] == "delta") == "สวัสดี"
    assert lines[-1]["type"] == "done"
    r2 = client.post("/api/playground/chat", json={"model": "m", "message": "x", "use_kb": False})
    assert json.loads(r2.text.splitlines()[0])["hits"] == []


# ---------------------------------------------------------------- PII / dataset
def test_pii_scan():
    import datasets_mgr as d
    assert d.valid_thai_cid("1101700230678") and not d.valid_thai_cid("1234567890123")
    ex = [{"instruction": "เลขบัตร 1-1017-00230-67-8 โทร 081-234-5678", "input": "", "output": "ok"},
          {"instruction": "ถามทั่วไป", "input": "", "output": "คุณสมชาย ใจดี HN 123456 และ a@b.com"},
          {"instruction": "เลข 1234567890123 ไม่ใช่บัตรจริง", "input": "", "output": "x"}]
    r = d.scan_examples(ex)
    assert r["blocking"] == 2 and r["by_type"]["cid"] == 1 and r["by_type"]["phone"] == 1
    assert r["by_type"]["hn"] == 1 and r["by_type"]["email"] == 1
    assert "1101700230678" not in json.dumps(r, ensure_ascii=False)  # ต้องไม่เปิดเผยค่าจริงเต็ม


def test_dataset_versions(client):
    ex = [{"instruction": f"คำถาม {i}", "input": "", "output": f"ตอบ {i}"} for i in range(5)]
    assert client.post("/api/catalog/custom-datasets", json={"label": "ทดสอบ", "examples": ex}).status_code == 200
    ds = [d for d in client.get("/api/catalog/datasets").json() if d["kind"] == "custom"][-1]
    vs = client.get(f"/api/datasets/{ds['id']}/versions").json()
    assert len(vs) == 1 and vs[0]["count"] == 5
    ap = client.post(f"/api/datasets/{ds['id']}/append", json={"examples": [{"instruction": "ใหม่", "output": "ใหม่"}, {"instruction": "", "output": "เสีย"}]}).json()
    assert ap["version"] == 2 and ap["count"] == 6
    rs = client.post(f"/api/datasets/{ds['id']}/restore", json={"version": 1}).json()
    assert rs["version"] == 3 and rs["count"] == 5
    assert client.get(f"/api/datasets/{ds['id']}/preview").json()["total"] == 5
    # จากคลังความรู้
    client.post("/api/kb/qa", json={"question": "คำถามจากคลัง", "answer": "คำตอบจากคลัง"})
    fk = client.post("/api/datasets/from-kb", json={"label": "จากคลัง"}).json()
    assert fk["count"] == 1 and fk["version"] == 1
    # ว่างเปล่าต้อง error ที่อ่านรู้เรื่อง
    assert client.post("/api/catalog/custom-datasets", json={"label": "x", "examples": [{"instruction": "", "output": ""}]}).status_code == 400


# ---------------------------------------------------------------- Preflight / งานเทรน / คิว
def test_preflight_logic():
    import preflight
    hw = {"gpu": {"vram_total_gb": 4.0, "vram_free_gb": 3.5}, "ram": {"total_gb": 16, "available_gb": 10},
          "disk": {"total_gb": 500, "free_gb": 100}}
    assert preflight.evaluate(3, 1, 512, hw)["level"] in ("ok", "tight")
    assert preflight.evaluate(8, 1, 512, hw)["level"] == "no"           # 8B บน 4GB ต้องไม่ผ่าน
    big = {"gpu": {"vram_total_gb": 24.0, "vram_free_gb": 23.0}, "ram": {"total_gb": 64, "available_gb": 55},
           "disk": {"total_gb": 1000, "free_gb": 600}}                    # เซิร์ฟเวอร์เป้าหมาย: 4090 / 64GB / 1TB
    assert preflight.evaluate(14, 4, 1024, big)["level"] == "ok"        # 14B QLoRA บน 24GB ต้องไหว
    low_ram = {**big, "ram": {"total_gb": 16, "available_gb": 10}}
    assert preflight.evaluate(14, 4, 1024, low_ram)["level"] == "no"    # RAM ไม่พอสำหรับ merge+GGUF ต้องเตือน
    assert preflight.evaluate(32, 1, 1024, big)["level"] == "no"
    low_disk = {**big, "disk": {"total_gb": 500, "free_gb": 10}}
    assert preflight.evaluate(14, 4, 1024, low_disk)["level"] == "no"
    nogpu = {**hw, "gpu": None}
    assert preflight.evaluate(3, 1, 512, nogpu)["level"] == "no"


def test_recommend_training():
    import hardware
    small = hardware.recommend_training(4, 3, 512)
    assert (small["batch_size"], small["grad_accum"]) == (1, 8)        # เครื่อง dev 4GB ต้องได้ค่าเดิมที่ใช้ได้จริง
    big = hardware.recommend_training(24, 14, 1024, is_linux=True, cpu_threads=24)
    assert big["batch_size"] >= 4 and big["batch_size"] * big["grad_accum"] in (16, 8, 32) and big["workers"] > 0
    assert hardware.recommend_training(24, 14, 1024, is_linux=False)["workers"] == 0


@pytest.fixture()
def fake_exec(monkeypatch):
    import jobs
    ran = []

    async def _exec(job, loop, resume):
        job.status = "training"
        ran.append(job.id)
        await asyncio.sleep(0.05)
        job.status = "done"

    monkeypatch.setattr(jobs.manager, "_execute", _exec)
    return ran


def _wait_status(client, jid, want, secs=6):
    end = time.time() + secs
    while time.time() < end:
        st = client.get(f"/api/jobs/{jid}").json()["status"]
        if st in want:
            return st
        time.sleep(0.1)
    return st


def test_create_job_gates_and_queue(client, fake_exec):
    base = {"base_model": "scb10x/llama3.2-typhoon2-3b-instruct", "output_name": "t1", "dataset": "Thaweewat/x"}
    # Preflight: ไม่มี GPU ในเครื่องทดสอบ → ต้องถูกบล็อกพร้อมรายละเอียด
    r = client.post("/api/jobs", json=base)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "preflight"
    # ฝืนได้
    j = client.post("/api/jobs", json={**base, "force": True}).json()
    assert _wait_status(client, j["id"], {"done"}) == "done"
    # PII: ชุดข้อมูลมีเลขบัตรจริงต้องถูกบล็อกจนกว่าจะยืนยัน
    ex = [{"instruction": "บัตร 1101700230678", "input": "", "output": "x"}]
    client.post("/api/catalog/custom-datasets", json={"label": "pii", "examples": ex})
    ds = [d for d in client.get("/api/catalog/datasets").json() if d["kind"] == "custom"][-1]["id"]
    r = client.post("/api/jobs", json={**base, "dataset": ds, "force": True})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "pii"
    assert "1101700230678" not in r.text
    ok = client.post("/api/jobs", json={**base, "dataset": ds, "force": True, "pii_ack": True})
    assert ok.status_code == 200 and ok.json()["dataset_version"] == 1
    # ตั้งเวลา: อนาคตต้องเป็น scheduled และยกเลิกได้
    fut = client.post("/api/jobs", json={**base, "force": True, "start_at": time.time() + 3600}).json()
    assert fut["status"] == "scheduled"
    q = client.get("/api/queue").json()
    assert any(w["id"] == fut["id"] for w in q["waiting"])
    client.post(f"/api/jobs/{fut['id']}/stop")
    assert client.get(f"/api/jobs/{fut['id']}").json()["status"] == "stopped"
    # template_mode ผิด
    assert client.post("/api/jobs", json={**base, "force": True, "template_mode": "x"}).status_code == 400


def test_system_endpoints(client):
    hw = client.get("/api/system/hardware").json()
    assert "ram" in hw and "disk" in hw and hw["ollama_up"] is True
    pf = client.post("/api/preflight", json={"base_model": "Qwen/Qwen2.5-14B-Instruct", "max_seq_length": 1024}).json()
    assert pf["params_b"] == 14 and pf["checks"]
    assert client.get("/api/system/ollama-tuning").json()
    dash = client.get("/api/dashboard").json()
    assert "kb" in dash and "queue" in dash


# ---------------------------------------------------------------- ทะเบียนโมเดล
def test_registry_flow(client):
    a = client.post("/api/registry", json={"name": "model-a", "base_model": "b"}).json()
    b = client.post("/api/registry", json={"name": "model-b"}).json()
    assert a["status"] == "candidate"
    # ยังไม่อนุมัติ → ตั้ง active ไม่ได้
    assert client.post(f"/api/registry/{a['id']}/activate").status_code == 400
    assert client.get("/api/registry/active").status_code == 404
    client.post(f"/api/registry/{a['id']}/approve")
    assert client.post(f"/api/registry/{a['id']}/activate").json()["status"] == "active"
    assert client.get("/api/registry/active").json()["name"] == "model-a"
    client.post(f"/api/registry/{b['id']}/approve")
    client.post(f"/api/registry/{b['id']}/activate")
    states = {v["name"]: v["status"] for v in client.get("/api/registry").json()}
    assert states == {"model-a": "archived", "model-b": "active"}      # active มีได้ตัวเดียว
    assert client.delete(f"/api/registry/{b['id']}").status_code == 400  # ลบตัวที่ใช้งานอยู่ไม่ได้
    assert client.post(f"/api/registry/{b['id']}/archive").status_code == 400
    rb = client.post("/api/registry/rollback").json()
    assert rb["name"] == "model-a" and client.get("/api/registry/active").json()["name"] == "model-a"
    assert len(client.get("/api/registry/events").json()) >= 6
    actions = [x["action"] for x in client.get("/api/system/audit").json()]
    assert "model.activate" in actions and "model.approve" in actions


# ---------------------------------------------------------------- ชุดทดสอบ / เปรียบเทียบ
def test_eval_compare_and_registry_eval(client):
    prompts = client.get("/api/eval/prompts").json()
    pinned = [p["id"] for p in prompts if p.get("pinned")]
    assert pinned
    c = client.post("/api/eval/compare", json={"models": ["m1", "m2"], "pinned_only": True}).json()
    assert set(c["summaries"]) == {"m1", "m2"} and len(c["rows"]) == len(pinned)
    s = c["summaries"]["m1"]
    # แชทปลอมตอบมี "1323" เสมอ: เคส rf-1 ผ่าน, rf-2 (ต้องมี 1669) ไม่ผ่าน → recall 0.5
    assert s["red_flag_total"] == 2 and s["red_flag_recall"] == 0.5 and s["avg_tokens_per_s"] == 10.0
    assert client.post("/api/eval/compare", json={"models": ["only-one"]}).status_code == 400
    v = client.post("/api/registry", json={"name": "ev-model"}).json()
    done = client.post(f"/api/registry/{v['id']}/eval").json()
    assert done["eval"]["red_flag_recall"] == 0.5
    # เพิ่มโจทย์ใหม่พร้อมเงื่อนไข
    client.post("/api/eval/prompts", json={"text": "ทดสอบ", "expect": ["ตอบ"], "must_not": ["ห้าม"], "pinned": True})
    run = client.post("/api/eval/run", json={"model": "m", "prompt_ids": [p["id"] for p in client.get("/api/eval/prompts").json()][-1:]}).json()
    assert run["results"][0]["passed"] is True


# ---------------------------------------------------------------- ระบบ: ดิสก์ / สำรอง
def test_disk_and_backup_restore(client):
    import config
    (config.PROJECT_ROOT / "outputs_dead").mkdir(parents=True, exist_ok=True)
    (config.PROJECT_ROOT / "outputs_dead" / "f.bin").write_bytes(b"x" * 1000)
    items = {i["name"]: i for i in client.get("/api/system/disk").json()["breakdown"]["items"]}
    assert items["outputs_dead"]["deletable"] and not items["studio_data"]["deletable"]
    assert client.delete("/api/system/disk/studio_data").status_code == 400
    assert client.delete("/api/system/disk/..%2Fetc").status_code in (400, 404, 405)
    assert client.delete("/api/system/disk/outputs_dead").json()["ok"]

    client.post("/api/kb/docs", json={"title": "สำรอง", "text": "ข้อมูลที่ต้องกู้คืนได้"})
    b = client.post("/api/system/backups").json()
    assert b["name"].endswith(".zip")
    # ลบความรู้ทิ้ง แล้วกู้คืน
    for d in client.get("/api/kb/docs").json():
        client.delete(f"/api/kb/docs/{d['id']}")
    assert client.get("/api/kb/stats").json()["docs"] == 0
    r = client.post(f"/api/system/backups/{b['name']}/restore").json()
    assert r["ok"] and r["safety_backup"]
    assert client.get("/api/kb/stats").json()["docs"] >= 1
    assert client.post("/api/system/backups/..%2Fx.zip/restore").status_code in (400, 404, 405)
    # zip ไม่ปลอดภัยต้องถูกปฏิเสธ
    evil = io.BytesIO()
    with zipfile.ZipFile(evil, "w") as z:
        z.writestr("studio_data/../../evil.txt", "x")
    r = client.post("/api/system/restore-upload", files={"file": ("e.zip", evil.getvalue())})
    assert r.status_code == 400
    r = client.post("/api/system/restore-upload", files={"file": ("e.zip", b"not a zip")})
    assert r.status_code == 400


# ---------------------------------------------------------------- ล็อกอิน (ทดสอบท้ายสุดเพราะแก้สถานะทั้งระบบ)
def test_zz_auth_flow(client):
    assert client.get("/api/auth/status").json()["enabled"] is False
    assert client.post("/api/auth/set-password", json={"password": "short"}).status_code == 400
    tok = client.post("/api/auth/set-password", json={"password": "correct-horse-1"}).json()["token"]
    assert client.get("/api/kb/stats").status_code == 401
    assert client.get("/api/health").status_code == 200                    # เส้นทางเปิด
    assert client.post("/api/auth/login", json={"password": "wrong-pass-12"}).status_code == 401
    t2 = client.post("/api/auth/login", json={"password": "correct-horse-1"}).json()["token"]
    h = {"Authorization": f"Bearer {t2}"}
    assert client.get("/api/kb/stats", headers=h).status_code == 200
    assert client.get("/api/kb/stats", headers={"Authorization": "Bearer junk"}).status_code == 401
    assert client.get(f"/api/kb/stats?token={tok}").status_code == 200
    # settings สาธารณะต้องไม่รั่ว hash/secret
    pub = client.get("/api/settings", headers=h).json()
    assert pub["auth"] == {"enabled": True}
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/jobs/x/ws"):
            pass
    assert client.post("/api/auth/disable", headers=h).status_code == 200
    assert client.get("/api/kb/stats").status_code == 200
