"""ขอบเขตการตอบ (guardrails): ตัดสินก่อนเรียกโมเดลว่า "ควรตอบเองหรือตอบตายตัว"

ทำไมไม่สอนในข้อมูลเทรนอย่างเดียว: โมเดลเล็ก (3B) ปฏิเสธไม่สม่ำเสมอ และแก้ขอบเขตทีต้องเทรนใหม่
ชั้นนี้ทำงานก่อนโมเดล แก้จากหน้าเว็บได้ทันที มี 3 ด่านตามลำดับ:
  1. กฎตอบตายตัว (rules): เคสอันตราย (red flag) เช่น อยากทำร้ายตัวเอง → ตอบข้อความที่เราเขียนไว้พร้อมเบอร์โทรฉุกเฉิน
     และหัวข้อต้องห้าม เช่น วินิจฉัยโรค/แนะนำยา → ตอบข้อความตายตัว ไม่ผ่านโมเดลเลย
  2. คุยทั่วไป (smalltalk): ทักทาย/ถามตัวตนสั้นๆ ผ่านไปให้โมเดลตอบได้แม้ไม่มีเอกสาร
  3. ต้องมีเอกสารรองรับ (require_context): ถ้าเปิดใช้คลังความรู้แต่ค้นไม่เจอชิ้นที่คะแนนถึงเกณฑ์ → ตอบ "ไม่มีข้อมูล" ทันที
  4. ตรวจเลขหลังโมเดลตอบ (verify_numbers, 0.8.5): ถ้าคำตอบมีเบอร์โทร/เวลา/ตัวเลขที่ไม่อยู่ในเอกสารที่ดึงมา (และไม่อยู่ในรายการที่อนุญาต)
     แปลว่าโมเดลแต่งเลขเอง → แทนที่ด้วยข้อความปลอดภัย (ตัวอย่างจริง: ตอบเบอร์ 074-123-456 ทั้งที่เอกสารบอก 074-999-123)
ผลที่ได้เป็นข้อความตายตัวที่ผู้ดูแลอ่านและแก้เองได้ ไม่ขึ้นกับว่าโมเดลจะเดาถูกหรือไม่
"""
from __future__ import annotations

import re

import config

NO_INFO_DEFAULT = "ขออภัยค่ะ ฉันไม่มีข้อมูลเรื่องนี้ในระบบ รบกวนสอบถามเจ้าหน้าที่โดยตรงนะคะ"

# กฎเริ่มต้น (ผู้ดูแลแก้/เพิ่ม/ปิดได้จากหน้า "ควบคุมและเชื่อมต่อ → ขอบเขตการตอบ")
DEFAULT_RULES: list[dict] = [
    {"id": "self-harm", "name": "คิดทำร้ายตัวเอง", "kind": "red_flag", "enabled": True,
     "keywords": ["ฆ่าตัวตาย", "ทำร้ายตัวเอง", "อยากตาย", "ตายไปเลย", "ไม่อยากอยู่แล้ว", "จบชีวิต"],
     "reply": "ขอบคุณที่บอกให้ฟังนะคะ ความรู้สึกนี้สำคัญมาก ตอนนี้ขอให้อยู่กับคนที่ไว้ใจ และโทรสายด่วนสุขภาพจิต 1323 ได้ตลอด 24 ชั่วโมง "
              "หากรู้สึกว่าจะทำร้ายตัวเองทันที โทร 1669 ค่ะ"},
    {"id": "severe-withdrawal", "name": "อาการรุนแรง/ฉุกเฉิน", "kind": "red_flag", "enabled": True,
     "keywords": ["ชักเกร็ง", "ชักกระตุก", "หมดสติ", "ไม่รู้สึกตัว", "หายใจไม่ออก", "เพ้อคลั่ง", "ฉีดเกินขนาด", "เสพเกินขนาด"],
     "reply": "อาการแบบนี้อันตรายค่ะ ควรรีบโทร 1669 เพื่อขอรถพยาบาลทันที หรือพาไปห้องฉุกเฉินที่ใกล้ที่สุด อย่าปล่อยให้อยู่คนเดียวนะคะ"},
    {"id": "stop-meds", "name": "ถามหยุดยาเอง", "kind": "blocked", "enabled": True,
     "keywords": ["หยุดยาเอง", "เลิกกินยา", "หยุดกินยา", "ไม่กินยาแล้ว"],
     "reply": "ไม่ควรหยุดยาเองนะคะ การหยุดยากะทันหันอาจเป็นอันตราย ควรปรึกษาแพทย์หรือเภสัชกรก่อนทุกครั้งค่ะ"},
    {"id": "diagnosis", "name": "ขอให้วินิจฉัยโรค", "kind": "blocked", "enabled": True,
     "keywords": ["วินิจฉัย", "เป็นโรคอะไร", "เป็นอะไรกันแน่"],
     "reply": "ฉันไม่สามารถวินิจฉัยโรคได้ค่ะ ควรพบแพทย์เพื่อประเมินอาการ หากฉุกเฉินโทร 1669"},
    {"id": "medication", "name": "ขอให้แนะนำยา", "kind": "blocked", "enabled": True,
     "keywords": ["แนะนำยา", "กินยาอะไรดี", "ยาตัวไหนดี", "ยาอะไรดี"],
     "reply": "ฉันไม่สามารถแนะนำยาได้ค่ะ ควรปรึกษาแพทย์หรือเภสัชกร หากฉุกเฉินโทร 1669"},
]

# กฎ "คำตอบสำเร็จรูป" (canned): ตอบข้อความตายตัวโดยไม่เรียกโมเดล เหมาะกับคำถามที่คำตอบไม่เปลี่ยน เช่น แนะนำตัว (โมเดลเล็กมักตอบเลอะ)
DEFAULT_RULES.append(
    {"id": "identity", "name": "แนะนำตัว/ทำอะไรได้บ้าง", "kind": "canned", "enabled": True,
     "keywords": ["คุณคือใคร", "คุณเป็นใคร", "แนะนำตัว", "ทำอะไรได้บ้าง", "ช่วยอะไรได้บ้าง"],
     "reply": "สวัสดีค่ะ ฉันเป็นผู้ช่วยตอบคำถามเบื้องต้นของโรงพยาบาล เช่น เวลาทำการ ขั้นตอนรับบริการ การนัดหมาย และข้อมูลทั่วไป "
              "ส่วนเรื่องวินิจฉัยโรคหรือแนะนำยา ขอให้ปรึกษาแพทย์โดยตรงนะคะ"})

DEFAULT_SMALLTALK = ["สวัสดี", "หวัดดี", "hello", "hi ", "ขอบคุณ", "บาย", "ลาก่อน", "คุณคือใคร", "คุณชื่อ", "ชื่ออะไร", "ทำอะไรได้", "ช่วยอะไรได้", "แนะนำตัว"]

DEFAULT_SCOPE: dict = {
    "enabled": True,
    "require_context": True,
    "no_info_reply": NO_INFO_DEFAULT,
    "smalltalk_keywords": DEFAULT_SMALLTALK,
    "rules": DEFAULT_RULES,
    "verify_numbers": True,
    "number_whitelist": ["1669", "1323", "199", "191", "1300"],     # เลขที่โมเดลพูดได้แม้ไม่อยู่ในเอกสาร (เบอร์ฉุกเฉินทั่วไป)
    "number_reply": "ขออภัยค่ะ ตัวเลขในคำตอบยังยืนยันกับเอกสารของระบบไม่ได้ เพื่อความถูกต้องรบกวนสอบถามเจ้าหน้าที่โดยตรงนะคะ",
}

_MAX_RULES = 40
_MAX_KEYWORDS = 60
_MAX_TEXT = 1500


def _norm(t: str) -> str:
    return "".join((t or "").lower().split())


def get_scope() -> dict:
    """ขอบเขตปัจจุบัน (ค่าที่ผู้ดูแลตั้ง รวมกับค่าเริ่มต้น)"""
    s = config.get_settings().get("scope") or {}
    out = {**DEFAULT_SCOPE, **{k: v for k, v in s.items() if k in DEFAULT_SCOPE}}
    return out


def validate_scope(raw: dict) -> dict:
    """ตรวจและทำความสะอาดข้อมูลจากหน้าเว็บก่อนบันทึก (ผิดรูปแบบ → ValueError พร้อมข้อความไทย)"""
    if not isinstance(raw, dict):
        raise ValueError("รูปแบบข้อมูลไม่ถูกต้อง")
    reply = str(raw.get("no_info_reply", "")).strip()
    if not reply:
        raise ValueError("ต้องมีข้อความตอบเมื่อไม่มีข้อมูล")
    rules = []
    seen_ids: set[str] = set()
    for i, r in enumerate(raw.get("rules") or [], 1):
        if not isinstance(r, dict):
            raise ValueError(f"กฎข้อที่ {i} ผิดรูปแบบ")
        kind = r.get("kind")
        if kind not in ("red_flag", "blocked", "canned"):
            raise ValueError(f"กฎข้อที่ {i}: ชนิดต้องเป็นเคสอันตราย (red_flag) หัวข้อต้องห้าม (blocked) หรือคำตอบสำเร็จรูป (canned)")
        kws = [str(k).strip() for k in (r.get("keywords") or []) if str(k).strip()]
        if not kws:
            raise ValueError(f"กฎข้อที่ {i}: ต้องมีคำสำคัญอย่างน้อย 1 คำ")
        text = str(r.get("reply", "")).strip()
        if not text:
            raise ValueError(f"กฎข้อที่ {i}: ต้องมีข้อความตอบ")
        rid = str(r.get("id") or f"rule-{i}").strip() or f"rule-{i}"
        while rid in seen_ids:
            rid += "-x"
        seen_ids.add(rid)
        rules.append({"id": rid, "name": str(r.get("name") or f"กฎ {i}").strip()[:80], "kind": kind,
                      "enabled": bool(r.get("enabled", True)), "keywords": list(dict.fromkeys(kws))[:_MAX_KEYWORDS],
                      "reply": text[:_MAX_TEXT]})
    if len(rules) > _MAX_RULES:
        raise ValueError(f"กฎมากเกิน {_MAX_RULES} ข้อ")
    talk = [str(k).strip() for k in (raw.get("smalltalk_keywords") or []) if str(k).strip()]
    wl = [re.sub(r"\s+", "", str(x)) for x in (raw.get("number_whitelist", DEFAULT_SCOPE["number_whitelist"]) or []) if str(x).strip()]
    nreply = str(raw.get("number_reply") or "").strip() or DEFAULT_SCOPE["number_reply"]
    return {"enabled": bool(raw.get("enabled", True)), "require_context": bool(raw.get("require_context", True)),
            "no_info_reply": reply[:_MAX_TEXT], "smalltalk_keywords": list(dict.fromkeys(talk))[:_MAX_KEYWORDS], "rules": rules,
            "verify_numbers": bool(raw.get("verify_numbers", True)), "number_whitelist": list(dict.fromkeys(wl))[:60],
            "number_reply": nreply[:_MAX_TEXT]}


def check_rules(message: str, scope: dict | None = None) -> dict | None:
    """ด่าน 1: คำถามตรงกับกฎตอบตายตัวไหม (เคสอันตรายมาก่อนหัวข้อต้องห้าม) คืน {kind, rule_id, rule_name, reply} หรือ None"""
    sc = scope or get_scope()
    if not sc.get("enabled"):
        return None
    m = _norm(message)
    for want in ("red_flag", "blocked", "canned"):
        for r in sc.get("rules", []):
            if r.get("kind") != want or not r.get("enabled", True):
                continue
            if any(_norm(k) and _norm(k) in m for k in r.get("keywords", [])):
                return {"kind": want, "rule_id": r["id"], "rule_name": r["name"], "reply": r["reply"]}
    return None


def is_smalltalk(message: str, scope: dict | None = None) -> bool:
    """ทักทาย/ถามตัวตนสั้นๆ (ไม่เกิน 40 ตัวอักษร และมีคำในรายการ) ให้ผ่านไปโมเดลตอบได้แม้ไม่มีเอกสาร"""
    sc = scope or get_scope()
    m = _norm(message)
    return len(message.strip()) <= 40 and any(_norm(k) and _norm(k) in m for k in sc.get("smalltalk_keywords", []))


def check_context(message: str, hits: list, use_kb: bool, scope: dict | None = None) -> dict | None:
    """ด่าน 2-3: เปิดใช้คลังความรู้แต่ไม่มีเอกสารที่คะแนนถึงเกณฑ์ (และไม่ใช่คุยทั่วไป) → ตอบ "ไม่มีข้อมูล" ทันที"""
    sc = scope or get_scope()
    if not sc.get("enabled") or not sc.get("require_context") or not use_kb or hits:
        return None
    if is_smalltalk(message, sc):
        return None
    return {"kind": "no_context", "rule_id": "no-context", "rule_name": "ไม่พบเอกสารที่เกี่ยวข้อง", "reply": sc["no_info_reply"]}


# ---------------------------------------------------------------- ด่าน 4: ตรวจเลขในคำตอบกับเอกสาร (0.8.5)
# เบอร์โทร (074-999-123) / เวลา (08.00, 16:30) / ตัวเลขยาว 3 หลักขึ้นไป (ช่วงสั้นๆ เช่น 7-14 วัน ไม่ตรวจ เพราะกำกวมเกินไป)
_NUM_RE = re.compile(r"\d{2,4}(?:-\d{2,4}){1,3}|\d{1,2}[.:]\d{2}|\d{3,}")


def extract_numbers(text: str) -> list[str]:
    return list(dict.fromkeys(m.group().replace(" ", "") for m in _NUM_RE.finditer(text or "")))


def _digits(x: str) -> str:
    return re.sub(r"\D", "", x)


def verify_numbers(answer: str, doc_texts: list[str], scope: dict | None = None) -> dict | None:
    """คืน {kind:'unverified_number', numbers:[...], reply} ถ้าคำตอบมีเลขที่ไม่อยู่ในเอกสาร/รายการอนุญาต; ปกติ/ปิดใช้ = None
    ไม่มีเอกสาร (doc_texts ว่าง) = ตรวจไม่ได้ จึงไม่ตัดสิน"""
    sc = scope or get_scope()
    if not sc.get("enabled") or not sc.get("verify_numbers") or not doc_texts:
        return None
    allowed_digits: set[str] = {_digits(w) for w in sc.get("number_whitelist", [])}
    for r in sc.get("rules", []):                         # เบอร์ที่เราเขียนเองในคำตอบตายตัวถือว่าอนุญาต
        allowed_digits |= {_digits(n) for n in extract_numbers(r.get("reply", ""))}
    allowed_digits |= {_digits(n) for n in extract_numbers(sc.get("no_info_reply", ""))}
    blob = " ".join(doc_texts)
    doc_digits = {_digits(n) for n in extract_numbers(blob)}
    bad = [n for n in extract_numbers(answer) if n not in blob and _digits(n) not in doc_digits and _digits(n) not in allowed_digits]
    if not bad:
        return None
    return {"kind": "unverified_number", "rule_id": "verify-numbers", "rule_name": "เลขในคำตอบไม่อยู่ในเอกสาร", "numbers": bad,
            "reply": sc.get("number_reply") or DEFAULT_SCOPE["number_reply"]}
