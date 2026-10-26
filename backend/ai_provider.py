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

# ลองตามลำดับ: รุ่น lite ก่อน (เร็วและพอสำหรับงานสรุป/สร้าง Q&A) แล้วค่อยรุ่นใหญ่
# ตัวแรกที่ใช้ได้จะถูกจำไว้ใช้ต่อ (0.8.0: เปลี่ยนจาก gemini-3.8-flash ที่ timeout เป็น lite)
_CANDIDATE_MODELS = [
    os.environ.get("GEMINI_MODEL", "").strip() or None,
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
    "gemini-2.5-flash",
]
_CANDIDATE_MODELS = [m for m in dict.fromkeys(_CANDIDATE_MODELS) if m]
_working_model: str | None = None
# timeout ต่อรุ่น (วินาที) — รุ่นที่ค้างจะถูกข้ามไปรุ่นถัดไปแทนที่จะรอ 60 วิ
_MODEL_TIMEOUT = 25


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
    """รุ่นนี้ใช้ไม่ได้ (404 / timeout / ล้มเหลวซ้ำ) → ให้ผู้เรียกลองรุ่นถัดไป"""

    def __init__(self, reason: str = ""):
        super().__init__(reason)
        self.reason = reason


def _describe(e: Exception) -> str:
    """ข้อความ error ที่อ่านออก (httpx บางตัว เช่น ReadTimeout มี str ว่าง)"""
    return str(e).strip() or type(e).__name__


async def _call_model(client: httpx.AsyncClient, model: str, api_key: str, prompt: str) -> dict:
    """เรียก Gemini 1 รุ่น (retry 503/429 สั้นๆ)

    404 / timeout / error ที่ไม่ใช่ปัญหาชั่วคราว → _ModelRetired (ไปลองรุ่นถัดไป)
    """
    delays = [0] + _RETRY_DELAYS
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
                timeout=_MODEL_TIMEOUT,
            )
            r.raise_for_status()
            return r.json()
        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            if status == 404:
                raise _ModelRetired("404 (รุ่นนี้ถูกยกเลิกหรือบัญชีนี้ใช้ไม่ได้)")
            if status in _TRANSIENT_STATUS and i < len(delays) - 1:
                continue
            if status in _TRANSIENT_STATUS:
                raise _ModelRetired(f"{status} (กำลังมีคนใช้งานเยอะ)")
            if status in (400, 401, 403):
                # คีย์ผิด/ไม่มีสิทธิ์ — เปลี่ยนรุ่นก็ไม่ช่วย แจ้งตรงๆ
                raise AIProviderError(
                    f"Gemini ปฏิเสธคำขอ ({status}) — ตรวจ GEMINI_API_KEY ว่าถูกต้องและยังใช้งานได้: "
                    f"{e.response.text[:160]}"
                )
            raise _ModelRetired(f"error {status}")
        except httpx.HTTPError as e:
            # timeout / เชื่อมต่อไม่ได้ → ข้ามไปรุ่นถัดไป
            raise _ModelRetired(_describe(e))
    raise _ModelRetired("ไม่สำเร็จ")


async def list_models() -> list[str]:
    """ถาม Gemini ว่าบัญชีนี้ใช้รุ่นไหนสร้างข้อความได้บ้าง (ใช้ตรวจเมื่อ id เปลี่ยน)"""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise AIProviderError("ยังไม่ได้ตั้งค่า GEMINI_API_KEY")
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": api_key, "pageSize": 200},
            )
            r.raise_for_status()
    except httpx.HTTPError as e:
        raise AIProviderError(f"ดึงรายการรุ่น Gemini ไม่สำเร็จ: {_describe(e)}")
    out = []
    for m in r.json().get("models", []):
        if "generateContent" in m.get("supportedGenerationMethods", []):
            out.append(m.get("name", "").removeprefix("models/"))
    return out


def _lite_first(models: list[str]) -> list[str]:
    """เรียงรุ่นจาก ListModels: lite/flash ก่อน ตัดรุ่น image/tts/embedding ที่ไม่ใช่งานข้อความ"""
    bad = ("image", "tts", "embed", "live", "audio", "vision", "imagen", "veo", "robotics")
    ok = [m for m in models if m.startswith("gemini") and not any(b in m for b in bad)]
    ok.sort(key=lambda m: (0 if "lite" in m else 1 if "flash" in m else 2, m))
    return ok


async def _generate(prompt: str) -> str:
    """ส่ง prompt ให้ Gemini (ลองรุ่นตามลำดับ ข้ามรุ่นที่ timeout/404 จำรุ่นที่ใช้ได้) แล้วคืนข้อความดิบ"""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise AIProviderError(
            "ยังไม่ได้ตั้งค่า GEMINI_API_KEY — ใส่ในไฟล์ backend/.env แล้ว restart backend ก่อน"
        )

    global _working_model
    models_to_try = [_working_model] if _working_model else list(_CANDIDATE_MODELS)
    failures: list[str] = []
    data: dict | None = None
    tried_discovery = False

    async with httpx.AsyncClient(timeout=_MODEL_TIMEOUT) as client:
        while models_to_try and data is None:
            model = models_to_try.pop(0)
            try:
                data = await _call_model(client, model, api_key, prompt)
                _working_model = model
            except _ModelRetired as e:
                failures.append(f"{model}: {e.reason}")
                if model == _working_model:
                    _working_model = None
                    models_to_try = [m for m in _CANDIDATE_MODELS if m != model]
                # หมดรายการแล้ว → ถาม ListModels หาตัวเลือกใหม่ 1 ครั้ง
                if not models_to_try and not tried_discovery:
                    tried_discovery = True
                    try:
                        known = set(_CANDIDATE_MODELS)
                        models_to_try = [m for m in _lite_first(await list_models()) if m not in known][:4]
                    except AIProviderError:
                        pass

    if data is None:
        raise AIProviderError(
            "เรียก Gemini ไม่สำเร็จทุกรุ่นที่ลอง — " + "; ".join(failures[-5:]) +
            " | ลองตั้ง GEMINI_MODEL=gemini-3.5-flash-lite ใน backend/.env แล้ว restart backend"
        )
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
