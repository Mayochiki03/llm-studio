"""Thin wrapper around a text-generation API used to help prepare
training data (turn pasted raw info into instruction/output pairs).

Kept provider-agnostic on purpose: `generate_qa_pairs` is the only
function the rest of the app calls, so swapping Gemini for Claude or
anything else later only means rewriting the inside of this file.

Configure with an environment variable (put it in backend/.env):
    GEMINI_API_KEY=your-key-here

Get a free key at https://aistudio.google.com/apikey

Google retires/renames Gemini model ids over time (e.g. gemini-2.0-flash
was retired and the API now points at gemini-3.8-flash). Rather than
hardcode one name and break again later, this tries a short candidate
list in order and remembers whichever one actually worked. Override
entirely with GEMINI_MODEL=... in backend/.env if Google renames things
again before this code gets updated.
"""
from __future__ import annotations

import asyncio
import json
import os
import re

import httpx

# 503 = model temporarily overloaded, 429 = rate limited — both are worth
# a short retry instead of failing the user's request immediately.
_TRANSIENT_STATUS = {503, 429}
_RETRY_DELAYS = [2, 5, 10]  # seconds, one retry per entry

# Tried in order; first one that doesn't 404 wins and is reused after that.
# Put the current recommended model first.
_CANDIDATE_MODELS = [
    os.environ.get("GEMINI_MODEL", "").strip() or None,
    "gemini-3.8-flash",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
]
_CANDIDATE_MODELS = [m for m in _CANDIDATE_MODELS if m]
_working_model: str | None = None


def _gemini_url(model: str) -> str:
    return f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class AIProviderError(Exception):
    pass


def is_configured() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY"))


PROMPT_TEMPLATE = """คุณคือผู้ช่วยเตรียมข้อมูลสำหรับเทรนแชทบอท AI ภาษาไทย

จากข้อมูลดิบด้านล่าง ให้สร้างคู่ "คำถาม-คำตอบ" สำหรับใช้เป็นตัวอย่างเทรนโมเดล
จำนวนประมาณ {num_pairs} คู่ โดย:
- คำถามให้เขียนในมุมของผู้ใช้จริงที่อยากรู้เรื่องนี้ ภาษาพูดธรรมชาติ หลากหลายรูปแบบ
- คำตอบให้ดึงข้อมูลจากข้อความดิบเท่านั้น ห้ามกุข้อมูลเพิ่มเอง ตอบให้ครบถ้วนและเป็นธรรมชาติ
- ตอบกลับเป็น JSON array เท่านั้น ไม่ต้องมีข้อความอื่นนอกเหนือจาก JSON
  รูปแบบแต่ละรายการ: {{"instruction": "...", "output": "..."}}

ข้อมูลดิบ:
---
{raw_text}
---

ตอบเป็น JSON array เท่านั้น:"""


def _extract_json_array(text: str) -> list[dict]:
    text = text.strip()
    # Gemini sometimes wraps the array in ```json ... ``` fences.
    fence = re.search(r"```(?:json)?\s*(\[.*\])\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1:
        raise AIProviderError("AI ไม่ได้ตอบกลับเป็น JSON array ตามที่คาดไว้")
    return json.loads(text[start : end + 1])


class _ModelRetired(Exception):
    """Raised internally when a model id 404s, so the caller moves to the next candidate."""


async def _call_model(client: httpx.AsyncClient, model: str, api_key: str, prompt: str) -> dict:
    """POST to one Gemini model, retrying transient errors (503/429) a few times.

    Raises _ModelRetired on 404 (caller should try the next candidate model),
    or AIProviderError for anything else that still fails after retries.
    """
    delays = [0] + _RETRY_DELAYS
    last_error: AIProviderError | None = None
    for i, delay in enumerate(delays):
        if delay:
            await asyncio.sleep(delay)
        try:
            r = await client.post(
                _gemini_url(model),
                params={"key": api_key},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.4},
                },
            )
            r.raise_for_status()
            return r.json()
        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            if status == 404:
                raise _ModelRetired()
            last_error = AIProviderError(f"Gemini API ตอบกลับ error: {status} — {e.response.text[:200]}")
            if status in _TRANSIENT_STATUS and i < len(delays) - 1:
                continue  # retry this same model after the next delay
            if status in _TRANSIENT_STATUS:
                raise AIProviderError(
                    "Gemini กำลังมีคนใช้งานเยอะตอนนี้ (error 503) ลองใหม่อีกครั้งในอีกสักครู่ "
                    "— ข้อมูลที่พิมพ์/วางไว้ในกล่องยังอยู่ครบ ไม่ต้องพิมพ์ใหม่"
                )
            raise last_error
        except httpx.HTTPError as e:
            raise AIProviderError(f"เรียก Gemini API ไม่สำเร็จ: {e}")
    raise last_error or AIProviderError("เรียก Gemini API ไม่สำเร็จ")


async def _generate(prompt: str) -> str:
    """ส่ง prompt ให้ Gemini (ลองรุ่นตามลำดับ จำรุ่นที่ใช้ได้) แล้วคืนข้อความตอบกลับดิบ"""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise AIProviderError(
            "ยังไม่ได้ตั้งค่า GEMINI_API_KEY — ใส่ในไฟล์ backend/.env แล้ว restart backend ก่อน"
        )

    global _working_model
    models_to_try = [_working_model] if _working_model else list(_CANDIDATE_MODELS)

    data: dict | None = None
    async with httpx.AsyncClient(timeout=60) as client:
        for idx, model in enumerate(models_to_try):
            try:
                data = await _call_model(client, model, api_key, prompt)
                _working_model = model
                break
            except _ModelRetired:
                _working_model = None
                if idx == len(models_to_try) - 1:
                    raise AIProviderError(
                        f"โมเดล Gemini ที่รู้จักทั้งหมดใช้ไม่ได้แล้ว (รุ่นล่าสุดที่ลอง: {model}) "
                        "ลองตั้งค่า GEMINI_MODEL=ชื่อรุ่นใหม่ ใน backend/.env"
                    )
                continue  # try the next candidate model

    assert data is not None
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise AIProviderError(f"รูปแบบคำตอบจาก Gemini ไม่ตรงตามที่คาด: {json.dumps(data)[:300]}")


async def generate_text(prompt: str) -> str:
    """ใช้กับฟีเจอร์อื่นที่ต้องการข้อความตอบกลับธรรมดา (เช่น สรุปผลเทรน)"""
    return (await _generate(prompt)).strip()


async def generate_qa_pairs(raw_text: str, num_pairs: int = 8) -> list[dict]:
    prompt = PROMPT_TEMPLATE.format(num_pairs=num_pairs, raw_text=raw_text.strip()[:8000])
    text = await _generate(prompt)

    pairs = _extract_json_array(text)
    cleaned = []
    for p in pairs:
        if isinstance(p, dict) and p.get("instruction") and p.get("output"):
            cleaned.append({"instruction": p["instruction"], "input": p.get("input", ""), "output": p["output"]})
    if not cleaned:
        raise AIProviderError("AI ไม่ได้สร้างคู่คำถาม-คำตอบที่ใช้ได้เลย ลองแก้ข้อความดิบแล้วลองใหม่")
    return cleaned
