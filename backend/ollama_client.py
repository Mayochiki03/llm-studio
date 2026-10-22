"""ตัวช่วยคุยกับ Ollama ผ่าน HTTP (ใช้ที่อยู่จากหน้า Settings)

รวมของที่ main.py และโมดูลอื่นใช้ร่วมกัน: รายชื่อโมเดล, โมเดลที่โหลดค้างใน VRAM,
ปลด/อุ่นโมเดล, แชท (ปกติและสตรีม), สร้างเวกเตอร์ (embedding)
ทุกฟังก์ชันไม่ throw เมื่อ Ollama ไม่ได้เปิด — คืนค่าว่างหรือ error ให้ผู้เรียกจัดการเอง
"""
from __future__ import annotations

import json
from typing import Any, AsyncIterator

import httpx

import config


def _base() -> str:
    return config.ollama_url()


async def is_up() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{_base()}/api/tags")
            return r.status_code == 200
    except httpx.HTTPError:
        return False


async def list_models() -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{_base()}/api/tags")
            return r.json().get("models", [])
    except (httpx.HTTPError, ValueError):
        return []


async def running_models() -> list[dict]:
    """โมเดลที่ Ollama โหลดค้างอยู่ใน VRAM ตอนนี้ (/api/ps)"""
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{_base()}/api/ps")
            return r.json().get("models", [])
    except (httpx.HTTPError, ValueError):
        return []


async def unload(model: str) -> bool:
    """สั่งปลดโมเดลออกจาก VRAM ทันที (keep_alive = 0)"""
    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{_base()}/api/generate", json={"model": model, "keep_alive": 0})
            return r.status_code == 200
    except httpx.HTTPError:
        return False


async def warm(model: str, keep_alive: str | None = None) -> bool:
    """โหลดโมเดลเข้า VRAM ล่วงหน้า (prompt ว่าง) เพื่อให้คำถามแรกไม่ต้องรอโหลด"""
    ka = keep_alive if keep_alive is not None else config.get_settings()["keep_alive"]
    try:
        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.post(f"{_base()}/api/generate", json={"model": model, "keep_alive": _ka(ka)})
            return r.status_code == 200
    except httpx.HTTPError:
        return False


def _ka(value: Any) -> Any:
    """keep_alive ของ Ollama รับเลข (วินาที, -1 = ตลอด) หรือข้อความเช่น '30m'"""
    s = str(value).strip()
    if s.lstrip("-").isdigit():
        return int(s)
    return s


async def chat(model: str, messages: list[dict], options: dict | None = None,
               keep_alive: str | None = None, timeout: float = 300) -> dict:
    """แชทแบบรอคำตอบเต็ม คืน {reply, eval_count, eval_duration_s, total_s, tokens_per_s} หรือ {error}"""
    body: dict = {"model": model, "messages": messages, "stream": False,
                  "keep_alive": _ka(keep_alive or config.get_settings()["keep_alive"])}
    if options:
        body["options"] = options
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{_base()}/api/chat", json=body)
            data = r.json()
    except (httpx.HTTPError, ValueError) as e:
        return {"error": f"เรียก Ollama ไม่ได้: {e}"}
    if "error" in data:
        return {"error": str(data["error"])}
    return {"reply": data.get("message", {}).get("content", ""), **_speed(data)}


def _speed(data: dict) -> dict:
    """คำนวณความเร็วจากตัวนับของ Ollama (หน่วยเวลาเป็นนาโนวินาที)"""
    n = data.get("eval_count") or 0
    ed = (data.get("eval_duration") or 0) / 1e9
    td = (data.get("total_duration") or 0) / 1e9
    return {"eval_count": n, "eval_duration_s": round(ed, 2), "total_s": round(td, 2),
            "tokens_per_s": round(n / ed, 1) if ed > 0 else None}


async def chat_stream(model: str, messages: list[dict], options: dict | None = None,
                      keep_alive: str | None = None) -> AsyncIterator[dict]:
    """แชทแบบสตรีม: yield {"delta": "..."} ทีละช่วง และปิดท้ายด้วย {"done": True, ...สถิติ}"""
    body: dict = {"model": model, "messages": messages, "stream": True,
                  "keep_alive": _ka(keep_alive or config.get_settings()["keep_alive"])}
    if options:
        body["options"] = options
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10)) as c:
            async with c.stream("POST", f"{_base()}/api/chat", json=body) as r:
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    if "error" in obj:
                        yield {"error": str(obj["error"])}
                        return
                    piece = obj.get("message", {}).get("content", "")
                    if piece:
                        yield {"delta": piece}
                    if obj.get("done"):
                        yield {"done": True, **_speed(obj)}
                        return
    except httpx.HTTPError as e:
        yield {"error": f"เรียก Ollama ไม่ได้: {e}"}


async def embed(texts: list[str], model: str | None = None) -> tuple[list[list[float]] | None, str]:
    """สร้างเวกเตอร์ของข้อความหลายชิ้นในคำขอเดียว (เร็วกว่าส่งทีละชิ้นมาก)
    คืน (vectors, error) — ถ้าไม่สำเร็จ vectors = None และ error บอกสาเหตุเป็นภาษาไทย"""
    if not texts:
        return [], ""
    m = model or config.get_settings()["embed_model"]
    try:
        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.post(f"{_base()}/api/embed", json={"model": m, "input": texts, "keep_alive": _ka("10m")})
            data = r.json()
    except (httpx.HTTPError, ValueError) as e:
        return None, f"เชื่อมต่อ Ollama ไม่ได้: {e}"
    if "error" in data:
        msg = str(data["error"])
        if "not found" in msg.lower():
            return None, f"ยังไม่มีโมเดลสร้างเวกเตอร์ '{m}' ในเครื่อง ให้รัน: ollama pull {m}"
        return None, msg
    embs = data.get("embeddings")
    if not embs or len(embs) != len(texts):
        return None, "Ollama ตอบกลับจำนวนเวกเตอร์ไม่ตรงกับที่ส่งไป"
    return embs, ""
