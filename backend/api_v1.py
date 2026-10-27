"""API สำหรับระบบอื่นเรียกใช้ (เว็บระบบติดตาม SUD, แชทบอท LINE) ที่ /api/v1/*

ต่างจาก /api/* ของหน้าเว็บตรงที่ยืนยันตัวตนด้วย "คีย์ API" (Authorization: Bearer sk-llmstudio-...)
ไม่ใช่รหัสผ่านผู้ดูแล และใช้ได้แม้ไม่ได้เปิดล็อกอินของหน้าเว็บ
- ระบบที่เรียกเลือกโมเดลเองไม่ได้ ใช้โมเดลที่ตั้งเป็น "ใช้งานจริง" ในทะเบียนเท่านั้น (ต้องอนุมัติผ่านคนก่อน)
- ไม่บันทึกเนื้อหาคำถาม/คำตอบ (อาจมีข้อมูลผู้ป่วย) บันทึกเฉพาะชื่อคีย์ ความยาว และจำนวนแหล่งที่ใช้
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

import abuse
import apikeys
import config
import db
import guard
import kb
import ollama_client
import registry

router = APIRouter(prefix="/v1")

MAX_QUESTION = 4000
MAX_HISTORY = 10


async def require_key(request: Request) -> dict:
    header = request.headers.get("authorization", "")
    key = header[7:].strip() if header.lower().startswith("bearer ") else ""
    row = apikeys.verify(key)
    if not row:
        raise HTTPException(401, "คีย์ API ไม่ถูกต้องหรือถูกปิดใช้งาน")
    if not apikeys.allow_rate(row["id"]):
        raise HTTPException(429, "เรียกถี่เกินไป (จำกัด 60 ครั้งต่อนาทีต่อคีย์) รอสักครู่แล้วลองใหม่")
    return row


class SearchBody(BaseModel):
    query: str
    top_k: int | None = None
    category: str = ""


class AskBody(BaseModel):
    question: str
    history: list[dict] = []
    category: str = ""        # จำกัดการค้นเฉพาะหมวดนี้ (ว่าง = ทุกหมวด)
    use_kb: bool = True
    top_k: int | None = None
    temperature: float | None = None
    client_id: str = ""       # รหัสผู้ใช้ปลายทาง (เช่น เลขเครื่อง/เซสชัน) ไว้แยกคนที่ใช้คีย์เดียวกัน เพื่อจำกัดการถามซ้ำรายคน


def _snippet(text: str, n: int = 240) -> str:
    return text if len(text) <= n else text[:n] + "..."


@router.get("/health")
async def health(_key: dict = Depends(require_key)):
    act = registry.active()
    return {"ok": True, "ollama_up": await ollama_client.is_up(), "model": act["name"] if act else None}


@router.get("/model")
def model(_key: dict = Depends(require_key)):
    act = registry.active()
    if not act:
        raise HTTPException(404, "ยังไม่มีโมเดลที่ตั้งเป็นใช้งานจริง")
    return {"name": act["name"], "version_id": act["id"], "activated_at": act["activated_at"]}


@router.post("/search")
async def search(body: SearchBody, key: dict = Depends(require_key)):
    if not body.query.strip() or len(body.query) > MAX_QUESTION:
        raise HTTPException(400, f"คำค้นว่าง หรือยาวเกิน {MAX_QUESTION} ตัวอักษร")
    res = await kb.search(body.query, body.top_k, None, body.category)
    db.audit("api.search", key["name"], f"q_len={len(body.query)} hits={len(res.get('hits', []))}", actor=f"key:{key['name']}")
    return {"mode": res.get("mode"), "hits": [
        {"doc_id": h["doc_id"], "title": h["title"], "score": h["score"], "text": h["text"]} for h in res.get("hits", [])]}


@router.post("/ask")
async def ask(body: AskBody, key: dict = Depends(require_key)):
    """ถามตอบด้วยโมเดลที่ใช้งานจริง + คลังความรู้ ตอบกลับเป็น JSON ครั้งเดียว พร้อมแหล่งที่มา"""
    q = body.question.strip()
    if not q or len(q) > MAX_QUESTION:
        raise HTTPException(400, f"คำถามว่าง หรือยาวเกิน {MAX_QUESTION} ตัวอักษร")
    act = registry.active()
    if not act:
        raise HTTPException(503, "ยังไม่มีโมเดลที่ตั้งเป็นใช้งานจริง ให้ผู้ดูแลอนุมัติและเปิดใช้โมเดลในทะเบียนก่อน")

    # ด่าน 1: กฎตอบตายตัว (เคสอันตราย/หัวข้อต้องห้าม) ไม่ผ่านโมเดล
    rule = guard.check_rules(q)
    if rule:
        db.audit("api.ask.guard", key["name"], f"{rule['kind']}:{rule['rule_id']} q_len={len(q)}", actor=f"key:{key['name']}")
        return {"answer": rule["reply"], "model": None, "mode": "guard", "elapsed_s": 0.0, "sources": [],
                "guard": {"kind": rule["kind"], "rule": rule["rule_id"]}}
    # ด่านกันถามซ้ำ/สแปม (หลังด่านกฎ จึงไม่จำกัดเคสอันตราย)
    client = f"key:{key['id']}" + (f":{body.client_id[:64]}" if body.client_id else "")
    lim = abuse.check(client, q)
    if lim["action"] == "block":
        db.audit("api.ask.abuse", key["name"], f"block:{lim['reason']} n={lim['count']} q_len={len(q)}", actor=f"key:{key['name']}")
        raise HTTPException(429, detail={"code": "cooldown" if lim["reason"] == "cooldown" else lim["reason"], "message": lim["reply"],
                                         "retry_after": lim["retry_after"]}, headers={"Retry-After": str(max(1, lim["retry_after"]))})
    if lim["action"] == "warn":
        db.audit("api.ask.abuse", key["name"], f"warn n={lim['count']} q_len={len(q)}", actor=f"key:{key['name']}")
        return {"answer": lim["reply"], "model": None, "mode": "abuse", "elapsed_s": 0.0, "sources": [],
                "guard": {"kind": "repeat_warn", "rule": "abuse", "count": lim["count"]}}
    if lim["action"] == "cached":
        return {"answer": lim["reply"], "model": None, "mode": "cache", "elapsed_s": 0.0, "sources": [],
                "guard": {"kind": "repeat_cached", "rule": "abuse", "count": lim["count"]}}
    system = config.get_settings()["default_system_prompt"]
    hits: list[dict] = []
    mode = "off"
    if body.use_kb:
        res = await kb.search(q, body.top_k, None, body.category)
        hits, mode = res.get("hits", []), res.get("mode", "none")
    # ด่าน 2-3: ไม่มีเอกสารรองรับ → ตอบไม่มีข้อมูลทันที
    miss = guard.check_context(q, hits, body.use_kb)
    if miss:
        db.audit("api.ask.guard", key["name"], f"no_context q_len={len(q)}", actor=f"key:{key['name']}")
        return {"answer": miss["reply"], "model": None, "mode": mode, "elapsed_s": 0.0, "sources": [],
                "guard": {"kind": "no_context", "rule": "no-context"}}
    if body.use_kb:
        ctx = kb.build_context(hits)
        if ctx:
            system = f"{system}\n\n{ctx}".strip()
    messages: list[dict] = [{"role": "system", "content": system}] if system else []
    messages += [{"role": m["role"], "content": str(m["content"])[:MAX_QUESTION]} for m in body.history[-MAX_HISTORY:]
                 if m.get("role") in ("user", "assistant") and m.get("content")]
    messages.append({"role": "user", "content": q})

    t0 = time.time()
    r = await ollama_client.chat(act["name"], messages, {"temperature": body.temperature} if body.temperature is not None else None)
    if "error" in r:
        db.audit("api.ask.error", key["name"], r["error"][:300], actor=f"key:{key['name']}")
        raise HTTPException(502, f"โมเดลตอบไม่ได้: {r['error']}")
    answer, guard_info = r["reply"], None
    bad = guard.verify_numbers(answer, [h["text"] for h in hits]) if body.use_kb else None   # แก้เลขที่โมเดลแต่งเอง
    if bad:
        db.audit("api.ask.guard", key["name"], f"unverified_number {','.join(bad['numbers'])[:80]} q_len={len(q)}", actor=f"key:{key['name']}")
        answer, guard_info = bad["reply"], {"kind": bad["kind"], "rule": bad["rule_id"], "numbers": bad["numbers"]}
    else:
        if not body.history:
            abuse.cache_put(q, answer, mode)                    # จำคำตอบปกติไว้ใช้ตอนถูกถามซ้ำ (ไม่จำคำตอบที่ถูกแก้)
    db.audit("api.ask", key["name"], f"q_len={len(q)} hits={len(hits)} model={act['name']}", actor=f"key:{key['name']}")
    out = {
        "answer": answer, "model": act["name"], "mode": mode, "elapsed_s": round(time.time() - t0, 2),
        "sources": [{"doc_id": h["doc_id"], "title": h["title"], "score": h["score"], "snippet": _snippet(h["text"])} for h in hits],
    }
    if guard_info:
        out["guard"] = guard_info
    return out
