"""ล็อกอินแบบรหัสผ่านเดียว (ผู้ดูแลระบบ) สำหรับตอนเปิดใช้บนเซิร์ฟเวอร์

ปิดไว้เป็นค่าเริ่มต้น (เครื่อง dev ใช้คนเดียว) เปิดได้ในหน้าตั้งค่า
- เก็บเฉพาะ salt + PBKDF2 hash ใน settings.json ไม่เก็บรหัสผ่านจริง
- โทเค็นเซ็นด้วย HMAC (secret สุ่มเฉพาะเครื่อง) มีวันหมดอายุ ไม่ต้องมีตารางเซสชัน
- ใช้ไลบรารีมาตรฐานเท่านั้น
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time

import config

TOKEN_TTL_S = 12 * 3600
_ITER = 200_000


def _hash(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITER).hex()


def is_enabled() -> bool:
    return bool(config.get_settings()["auth"].get("enabled"))


def set_password(password: str) -> None:
    """ตั้ง/เปลี่ยนรหัสผ่านและเปิดการล็อกอิน (ต้องยาวอย่างน้อย 8 ตัวอักษร)"""
    if len(password) < 8:
        raise ValueError("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร")
    salt = secrets.token_bytes(16)
    config.save_settings({"auth": {"enabled": True, "salt": salt.hex(), "hash": _hash(password, salt),
                                   "secret": secrets.token_hex(32)}})


def disable() -> None:
    config.save_settings({"auth": {"enabled": False}})


def verify_password(password: str) -> bool:
    a = config.get_settings()["auth"]
    if not a.get("salt") or not a.get("hash"):
        return False
    return hmac.compare_digest(_hash(password, bytes.fromhex(a["salt"])), a["hash"])


def _sign(payload: str, secret: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def issue_token() -> str:
    secret = config.get_settings()["auth"]["secret"]
    payload = str(int(time.time()) + TOKEN_TTL_S)
    raw = f"{payload}.{_sign(payload, secret)}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def check_token(token: str | None) -> bool:
    """ถ้าไม่ได้เปิดล็อกอินถือว่าผ่านเสมอ"""
    if not is_enabled():
        return True
    if not token:
        return False
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        payload, sig = raw.split(".", 1)
        secret = config.get_settings()["auth"]["secret"]
        return hmac.compare_digest(sig, _sign(payload, secret)) and int(payload) > time.time()
    except Exception:
        return False
