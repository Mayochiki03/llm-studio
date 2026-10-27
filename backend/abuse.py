"""ป้องกันการถามซ้ำ/สแปม (0.8.5) — กติกาล้วน ไม่ใช้ AI ทำงานในเครื่องเท่านั้น

ปัญหา: คนถามคำถามเดิมซ้ำๆ หรือยิงถี่ๆ (สแปม/โวยวาย) ทำให้เปลืองทรัพยากร GPU ที่มีจำกัด
แนวคิด: ยิ่งซ้ำยิ่งเบาแรงลง เป็นขั้นบันได (ปรับเกณฑ์ได้ทุกขั้น)
  ขั้น 1 ใช้คำตอบเดิมจากแคช (ไม่เรียกโมเดล)  -> ครั้งที่ cache_after+1 เป็นต้นไป
  ขั้น 2 เตือนสุภาพ (ไม่เรียกโมเดล)          -> ครั้งที่ warn_after+1
  ขั้น 3 พักการใช้งานชั่วคราว (cooldown)     -> ครั้งที่ block_after+1 ; พักนานขึ้นเมื่อทำผิดซ้ำ (strikes)
  นอกจากนี้มีเพดานจำนวนครั้งต่อนาที และเพดานความยาวข้อความ
ข้อยกเว้นสำคัญ: เคสอันตราย (red_flag) และกฎตอบตายตัวไม่ถูกจำกัดเด็ดขาด — ตัวจำกัดทำงานหลังด่านกฎเสมอ
ความเป็นส่วนตัว: บันทึกเหตุการณ์เก็บแค่ความยาว + แฮช 8 ตัว ไม่เก็บตัวข้อความคำถาม
"""
from __future__ import annotations

import copy
import hashlib
import re
import threading
import time
from collections import deque

import config

# ---------------------------------------------------------------- ค่าตั้งต้น + พรีเซ็ต
DEFAULT_ABUSE: dict = {
    "enabled": True,
    "preset": "normal",
    "window_s": 600,            # นับคำถามซ้ำภายในกี่วินาที
    "cache_after": 2,           # ถามซ้ำเกินกี่ครั้ง (ครั้งที่ 3 เป็นต้นไป) -> ใช้คำตอบจากแคช
    "warn_after": 4,            # ครั้งที่ 5 เป็นต้นไป -> เตือน
    "block_after": 7,           # ครั้งที่ 8 เป็นต้นไป -> พัก
    "cooldown_s": [60, 300, 1800],   # ระยะพักตามจำนวนครั้งที่ทำผิด (ครั้งที่ 1, 2, 3+)
    "strike_decay_s": 3600,     # ไม่ทำผิดนานเท่านี้ -> ล้างประวัติทำผิด
    "rate_per_min": 20,         # ถามได้สูงสุดกี่ครั้งต่อนาที (ทุกคำถามรวมกัน)
    "max_chars": 1500,          # ข้อความยาวเกินนี้ถูกปฏิเสธ
    "exempt_playground": True,  # หน้าทดลองในระบบไม่ถูกจำกัด (เจ้าหน้าที่ทดสอบเอง)
    "cache_ttl_s": 600,         # อายุคำตอบในแคช
    "warn_reply": "ขออภัยค่ะ คำถามนี้ถูกถามซ้ำหลายครั้งแล้ว ระบบขอพักการตอบชั่วคราว หากยังไม่ได้คำตอบที่ต้องการ รบกวนติดต่อเจ้าหน้าที่โดยตรงนะคะ",
    "block_reply": "ขออภัยค่ะ มีการถามถี่หรือซ้ำมากผิดปกติ ระบบขอพักการใช้งานชั่วคราว กรุณารอสักครู่แล้วลองใหม่ หากเร่งด่วนติดต่อเจ้าหน้าที่โดยตรง",
    "rate_reply": "ขออภัยค่ะ ส่งคำถามถี่เกินไป กรุณารอสักครู่แล้วลองใหม่",
    "long_reply": "ขออภัยค่ะ ข้อความยาวเกินไป กรุณาสรุปให้สั้นลงแล้วถามใหม่",
}

PRESETS: dict[str, dict] = {
    "lenient": {"label": "ผ่อนปรน", "hint": "ให้ถามซ้ำได้หลายครั้ง เหมาะช่วงเริ่มใช้งานหรือผู้ใช้เป็นเจ้าหน้าที่",
                "cache_after": 3, "warn_after": 6, "block_after": 10, "cooldown_s": [30, 120, 600], "rate_per_min": 40},
    "normal": {"label": "ปกติ", "hint": "สมดุล: ซ้ำ 3 ครั้งใช้คำตอบเดิม ซ้ำ 5 ครั้งเตือน ซ้ำ 8 ครั้งพัก",
               "cache_after": 2, "warn_after": 4, "block_after": 7, "cooldown_s": [60, 300, 1800], "rate_per_min": 20},
    "strict": {"label": "เข้มงวด", "hint": "ตัดเร็ว เหมาะเมื่อเปิดให้ภายนอกใช้และ GPU ไม่พอ",
               "cache_after": 1, "warn_after": 2, "block_after": 4, "cooldown_s": [120, 900, 3600], "rate_per_min": 10},
}

_INT_LIMITS = {"window_s": (10, 86400), "cache_after": (0, 100), "warn_after": (1, 200), "block_after": (1, 500),
               "strike_decay_s": (60, 604800), "rate_per_min": (1, 1000), "max_chars": (50, 20000), "cache_ttl_s": (10, 86400)}
_TEXT_KEYS = ("warn_reply", "block_reply", "rate_reply", "long_reply")


def validate(raw: dict | None) -> dict:
    """ตรวจ/เติมค่าตั้ง; ค่าผิดรูปแบบแจ้งเป็น ValueError (ภาษาไทย) ให้ API ตอบ 400"""
    raw = raw or {}
    out = copy.deepcopy(DEFAULT_ABUSE)
    preset = raw.get("preset", out["preset"])
    if preset in PRESETS and "preset" in raw and not any(k in raw for k in ("cache_after", "warn_after", "block_after")):
        out.update({k: v for k, v in PRESETS[preset].items() if k not in ("label", "hint")})
    out["enabled"] = bool(raw.get("enabled", out["enabled"]))
    out["exempt_playground"] = bool(raw.get("exempt_playground", out["exempt_playground"]))
    out["preset"] = preset if preset in PRESETS or preset == "custom" else "custom"
    for k, (lo, hi) in _INT_LIMITS.items():
        if k in raw or k in out:
            v = raw.get(k, out[k])
            try:
                v = int(v)
            except (TypeError, ValueError):
                raise ValueError(f"ค่า {k} ต้องเป็นตัวเลข") from None
            if not lo <= v <= hi:
                raise ValueError(f"ค่า {k} ต้องอยู่ระหว่าง {lo}-{hi}")
            out[k] = v
    cd = raw.get("cooldown_s", out["cooldown_s"])
    if not isinstance(cd, list) or not cd or len(cd) > 6:
        raise ValueError("ระยะพัก (cooldown_s) ต้องเป็นรายการตัวเลข 1-6 ค่า")
    try:
        cd = [int(x) for x in cd]
    except (TypeError, ValueError):
        raise ValueError("ระยะพัก (cooldown_s) ต้องเป็นตัวเลข") from None
    if any(not 5 <= x <= 604800 for x in cd):
        raise ValueError("ระยะพักแต่ละครั้งต้องอยู่ระหว่าง 5 วินาที - 7 วัน")
    out["cooldown_s"] = cd
    if not out["cache_after"] <= out["warn_after"] <= out["block_after"]:
        raise ValueError("ลำดับต้องเป็น ใช้แคช <= เตือน <= พัก")
    for k in _TEXT_KEYS:
        t = str(raw.get(k, out[k]) or "").strip()
        out[k] = (t or DEFAULT_ABUSE[k])[:500]
    return out


def get_config() -> dict:
    try:
        return validate(config.get_settings().get("abuse") or {})
    except ValueError:
        return copy.deepcopy(DEFAULT_ABUSE)


def save_config(raw: dict) -> dict:
    cfg = validate(raw)
    # ตรวจว่าตรงพรีเซ็ตไหน ถ้าไม่ตรงถือเป็น custom
    cfg["preset"] = _match_preset(cfg)
    config.save_settings({"abuse": cfg})
    return cfg


def _match_preset(cfg: dict) -> str:
    for name, p in PRESETS.items():
        if all(cfg.get(k) == v for k, v in p.items() if k not in ("label", "hint")):
            return name
    return "custom"


# ---------------------------------------------------------------- สถานะต่อผู้ใช้ (ในหน่วยความจำ)
_lock = threading.Lock()
_clients: dict[str, dict] = {}
_cache: dict[str, tuple[float, str, str]] = {}      # key -> (หมดอายุ, คำตอบ, mode)
_events: deque = deque(maxlen=200)
_counters = {"allow": 0, "cached": 0, "warn": 0, "block": 0, "rate": 0, "long": 0}


def normalize(text: str) -> str:
    """ทำให้คำถามที่ต่างแค่ช่องว่าง/วรรคตอน/ตัวพิมพ์ ถือเป็นข้อเดียวกัน"""
    t = re.sub(r"[\s​]+", "", (text or "").lower())
    return re.sub(r"[?!.,;:\"'()\[\]{}\-_~*/\\|<>…ๆฯ]+", "", t)


def _h(text: str) -> str:
    return hashlib.sha1(normalize(text).encode("utf-8")).hexdigest()[:8]


def _new_state() -> dict:
    return {"hist": deque(maxlen=300), "strikes": 0, "last_strike": 0.0, "cooldown_until": 0.0, "stamps": deque(maxlen=300)}


def _log(client: str, action: str, reason: str, text: str, count: int, now: float, record: bool) -> None:
    if record:
        _events.appendleft({"t": now, "client": client, "action": action, "reason": reason, "len": len(text or ""),
                            "hash": _h(text), "count": count})


def check(client: str, text: str, now: float | None = None, state: dict | None = None, cfg: dict | None = None) -> dict:
    """ตัดสินคำถามหนึ่งข้อ แล้วบันทึกลงสถานะ
    คืน {action: allow|cached|warn|block, reason, count, retry_after, reply}
    state/cfg ส่งมาเองได้ (ใช้ตอนจำลอง ไม่แตะสถานะจริง); ถ้าไม่ส่งใช้ของจริงและบันทึกเหตุการณ์"""
    cfg = cfg or get_config()
    now = time.time() if now is None else now
    real = state is None
    out = {"action": "allow", "reason": "", "count": 1, "retry_after": 0, "reply": ""}
    if not cfg.get("enabled"):
        return out
    with _lock:
        st = state if state is not None else _clients.setdefault(client, _new_state())

        def done(action: str, reason: str, reply: str = "", retry: int = 0, count: int = 1) -> dict:
            if real:
                _counters[{"rate": "rate", "long": "long"}.get(reason, action)] += 1
                if action != "allow":
                    _log(client, action, reason, text, count, now, True)
            return {"action": action, "reason": reason, "count": count, "retry_after": retry, "reply": reply}

        # 1) ยังอยู่ในช่วงพัก
        if st["cooldown_until"] > now:
            return done("block", "cooldown", cfg["block_reply"], int(st["cooldown_until"] - now) + 1)
        # ล้างประวัติทำผิดเมื่อสงบนานพอ
        if st["strikes"] and now - st["last_strike"] > cfg["strike_decay_s"]:
            st["strikes"] = 0
        # 2) ข้อความยาวเกิน (ไม่นับเป็นถามซ้ำ)
        if len(text or "") > cfg["max_chars"]:
            return done("block", "long", cfg["long_reply"])
        # 3) ถามถี่เกินต่อนาที
        st["stamps"].append(now)
        recent = sum(1 for s in st["stamps"] if now - s <= 60)
        if recent > cfg["rate_per_min"]:
            return done("block", "rate", cfg["rate_reply"], 60 - int(now - min(s for s in st["stamps"] if now - s <= 60)))
        # 4) นับคำถามซ้ำในหน้าต่างเวลา
        key = _h(text)
        st["hist"].append((key, now))
        count = sum(1 for k, t in st["hist"] if k == key and now - t <= cfg["window_s"])
        if count > cfg["block_after"]:
            idx = min(st["strikes"], len(cfg["cooldown_s"]) - 1)
            dur = cfg["cooldown_s"][idx]
            st["strikes"] += 1
            st["last_strike"] = now
            st["cooldown_until"] = now + dur
            st["hist"].clear()                       # เริ่มนับใหม่หลังพักจบ
            return done("block", "repeat", cfg["block_reply"], dur, count)
        if count > cfg["warn_after"]:
            return done("warn", "repeat", cfg["warn_reply"], 0, count)
        if count > cfg["cache_after"]:
            ans = cache_get(text, now) if real else "(คำตอบจากแคช)"
            if ans:
                return done("cached", "repeat", ans[0] if isinstance(ans, tuple) else ans, 0, count)
        return done("allow", "", "", 0, count)


# ---------------------------------------------------------------- แคชคำตอบ
def cache_put(text: str, answer: str, mode: str = "") -> None:
    cfg = get_config()
    if not cfg.get("enabled") or not answer:
        return
    with _lock:
        if len(_cache) > 500:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
                _cache.pop(k, None)
        _cache[normalize(text)] = (time.time() + cfg["cache_ttl_s"], answer, mode)


def cache_get(text: str, now: float | None = None) -> tuple[str, str] | None:
    """คืน (คำตอบ, mode) ถ้ามีและยังไม่หมดอายุ (เรียกภายใน lock แล้ว จึงไม่ล็อกซ้ำ)"""
    now = time.time() if now is None else now
    v = _cache.get(normalize(text))
    if v and v[0] > now:
        return v[1], v[2]
    return None


# ---------------------------------------------------------------- สถานะ/ปลดล็อก/จำลอง
def status() -> dict:
    now = time.time()
    with _lock:
        cooling = [{"client": c, "retry_after": int(s["cooldown_until"] - now) + 1, "strikes": s["strikes"]}
                   for c, s in _clients.items() if s["cooldown_until"] > now]
        return {"cooling": cooling, "clients": len(_clients), "cache_size": len(_cache), "counters": dict(_counters),
                "events": [dict(e, age_s=int(now - e["t"])) for e in list(_events)[:50]]}


def unlock(client: str) -> bool:
    with _lock:
        s = _clients.get(client)
        if not s:
            return False
        s.update(cooldown_until=0.0, strikes=0)
        s["hist"].clear()
        return True


def reset() -> None:
    with _lock:
        _clients.clear()
        _cache.clear()
        _events.clear()
        for k in _counters:
            _counters[k] = 0


def simulate(cfg_raw: dict | None, question: str, repeats: int = 12, interval_s: float = 5.0) -> dict:
    """จำลองการถามข้อเดียวซ้ำ N ครั้งห่างกัน interval_s วินาที ด้วยค่าตั้งที่กำลังแก้ (ไม่แตะสถานะจริง ไม่เรียกโมเดล)
    คืนตารางผลทีละครั้ง + สรุปว่าประหยัดการเรียกโมเดลได้กี่ครั้ง"""
    cfg = validate(cfg_raw if cfg_raw is not None else get_config())
    repeats = max(1, min(int(repeats), 60))
    interval_s = max(0.0, min(float(interval_s), 3600.0))
    st = _new_state()
    t0, rows, model_calls = 1_000_000.0, [], 0
    for i in range(repeats):
        now = t0 + i * interval_s
        r = check("sim", question, now=now, state=st, cfg=cfg)
        if r["action"] == "allow":
            model_calls += 1
        rows.append({"n": i + 1, "at_s": round(i * interval_s, 1), **{k: r[k] for k in ("action", "reason", "retry_after", "count")}})
    return {"rows": rows, "model_calls": model_calls, "saved": repeats - model_calls, "total": repeats}
