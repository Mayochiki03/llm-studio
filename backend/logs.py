"""บันทึกการทำงาน (log) ลงไฟล์ เพื่อไล่หาสาเหตุตอนมีปัญหา โดยเฉพาะอาการที่เห็นแค่ "หน้าจอว่าง"

มี 2 ไฟล์ใน studio_data/logs/ (หมุนไฟล์อัตโนมัติ ไม่โตไม่จำกัด):
- backend.log : เหตุการณ์ฝั่งเซิร์ฟเวอร์ (เริ่มระบบ, request ที่ล้มเหลว/ช้า, exception พร้อม traceback)
- client.log  : error ที่หน้าเว็บส่งมารายงาน (หน้าพัง, promise ล้ม, console.error)
ไม่บันทึกเนื้อหาคำถามหรือข้อมูลผู้ป่วย บันทึกเฉพาะ path, สถานะ, เวลา และข้อความ error
"""
from __future__ import annotations

import collections
import logging
import logging.handlers
import time
from pathlib import Path

import config

_NAMES = {"backend": "backend.log", "client": "client.log"}
_loggers: dict[str, logging.Logger] = {}


def _make(name: str) -> logging.Logger:
    """สร้าง logger ที่เขียนลงไฟล์หมุนเวียน (1 MB x 3 ไฟล์) ถ้าเขียนไฟล์ไม่ได้ก็ใช้แค่หน้าจอ ไม่ทำให้ระบบล้ม"""
    lg = logging.getLogger(f"studio.{name}")
    lg.setLevel(logging.INFO)
    lg.propagate = False
    for h in list(lg.handlers):
        lg.removeHandler(h)
        h.close()
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    try:
        config.LOG_DIR.mkdir(parents=True, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(config.LOG_DIR / _NAMES[name], maxBytes=1_000_000, backupCount=3,
                                                  encoding="utf-8")
        fh.setFormatter(fmt)
        lg.addHandler(fh)
    except OSError:
        pass
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    lg.addHandler(sh)
    return lg


def get(name: str = "backend") -> logging.Logger:
    if name not in _loggers:
        _loggers[name] = _make(name)
    return _loggers[name]


def reset() -> None:
    """สร้าง logger ใหม่ (ใช้ในชุดทดสอบที่ย้ายโฟลเดอร์ข้อมูล)"""
    for lg in _loggers.values():
        for h in list(lg.handlers):
            lg.removeHandler(h)
            h.close()
    _loggers.clear()


def tail(name: str, lines: int = 200) -> list[str]:
    """อ่านบรรทัดท้ายๆ ของ log (ใหม่สุดอยู่ท้าย) คืน [] ถ้ายังไม่มีไฟล์"""
    if name not in _NAMES:
        raise ValueError("ไม่มี log ชื่อนี้")
    p: Path = config.LOG_DIR / _NAMES[name]
    if not p.exists():
        return []
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            return [ln.rstrip("\n") for ln in collections.deque(f, maxlen=max(1, min(lines, 2000)))]
    except OSError:
        return []


def path_of(name: str) -> Path:
    if name not in _NAMES:
        raise ValueError("ไม่มี log ชื่อนี้")
    return config.LOG_DIR / _NAMES[name]


# จำกัดจำนวนรายงานจากหน้าเว็บ กัน log ท่วมถ้าหน้าพังวนลูป: ไม่เกิน 60 รายการต่อนาที
_client_hits: collections.deque = collections.deque()


def write_client(entry: dict) -> bool:
    """บันทึกรายงาน error จากหน้าเว็บ คืน False ถ้าเกินโควตา (ไม่บันทึก)"""
    now = time.time()
    while _client_hits and now - _client_hits[0] > 60:
        _client_hits.popleft()
    if len(_client_hits) >= 60:
        return False
    _client_hits.append(now)
    clean = {k: str(entry.get(k, ""))[:1500] for k in ("kind", "message", "stack", "page", "ua", "viewport", "version")}
    get("client").error(" | ".join(f"{k}={v!r}" for k, v in clean.items() if v))
    return True
