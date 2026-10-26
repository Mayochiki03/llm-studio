"""ตั้งค่ากลางของ backend: ที่เก็บไฟล์ + ไฟล์ settings.json

ไฟล์นี้เป็นที่เดียวที่รู้ว่า "โปรเจกต์อยู่ที่ไหน" และ "ผู้ใช้ตั้งค่าอะไรไว้"
โมดูลอื่นนำเข้า PROJECT_ROOT / DATA_DIR / get_settings() จากที่นี่ เพื่อไม่ให้ path
กระจายอยู่หลายที่ (เดิมกระจายอยู่ใน jobs.py และ store.py)

ลำดับการหาโฟลเดอร์โปรเจกต์ (PROJECT_ROOT):
  1. ตัวแปรสภาพแวดล้อม LLM_STUDIO_ROOT (ใช้บนเซิร์ฟเวอร์ Linux หรือเมื่ออยากกำหนดเอง)
  2. บน Windows ถ้ามี E:/AiProject ให้ใช้ (พฤติกรรมเดิมของเครื่อง dev)
  3. ~/AiProject
"""
from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path


def _detect_root() -> Path:
    """หาโฟลเดอร์โปรเจกต์ตามลำดับที่อธิบายไว้ด้านบน"""
    env = os.environ.get("LLM_STUDIO_ROOT", "").strip()
    if env:
        return Path(env).expanduser()
    if os.name == "nt":
        e_drive = Path("E:/AiProject")
        if e_drive.exists():
            return e_drive
    return Path.home() / "AiProject"


PROJECT_ROOT: Path = _detect_root()
DATA_DIR: Path = PROJECT_ROOT / "studio_data"
CUSTOM_DATASETS_DIR: Path = DATA_DIR / "custom_datasets"
JOBS_FILE: Path = DATA_DIR / "jobs.json"
SETTINGS_FILE: Path = DATA_DIR / "settings.json"
DB_FILE: Path = DATA_DIR / "studio.db"
BACKUP_DIR: Path = PROJECT_ROOT / "backups"
LOG_DIR: Path = DATA_DIR / "logs"

IS_WINDOWS: bool = os.name == "nt"

# ค่าเริ่มต้นของการตั้งค่าทั้งหมด — ผู้ใช้แก้ผ่านหน้า "ตั้งค่า" ได้ (ไม่ต้องแก้โค้ด)
DEFAULT_SETTINGS: dict = {
    # ที่อยู่ Ollama
    "ollama_url": "http://localhost:11434",
    # โมเดลสำหรับสร้างเวกเตอร์ของคลังความรู้ (ต้อง ollama pull ก่อน)
    "embed_model": "bge-m3",
    # โหมดดาวน์โหลดโมเดลจาก Hugging Face: "safe" = ช้าแต่ไม่ค้างบนเครือข่ายที่มี firewall,
    # "fast" = เปิด hf_transfer/xet เหมาะกับเซิร์ฟเวอร์ที่เน็ตตรง
    "network_mode": "safe",
    # ปลดโมเดลที่ Ollama โหลดค้างใน VRAM ก่อนเริ่มเทรน (กัน VRAM เต็ม) และโหลดกลับเมื่อจบ
    "unload_before_train": True,
    "reload_after_train": True,
    # ให้ Ollama เก็บโมเดลไว้ใน VRAM นานแค่ไหนหลังใช้งาน (เช่น "30m", "-1" = ตลอด)
    "keep_alive": "30m",
    # system prompt เริ่มต้นตอนสร้างโมเดลเข้า Ollama และตอนทดลองใน Playground
    "default_system_prompt": "คุณเป็นผู้ช่วยที่พูดภาษาไทยเป็นธรรมชาติ อบอุ่น และเข้าใจบริบทของผู้ใช้",
    # คลังความรู้
    "kb_chunk_size": 600,
    "kb_chunk_overlap": 80,
    "kb_top_k": 4,
    "kb_min_score": 0.2,
    # เวลาเทรนสูงสุดต่อ 1 งาน (นาที) 0 = ไม่จำกัด — ถ้าเกินระบบจะหยุดงานและโหลดโมเดลบริการกลับ
    "max_train_minutes": 0,
    # origin ที่อนุญาตให้เรียก API (ใส่ที่อยู่เว็บเมื่อเปิดจากเครื่องอื่นในเครือข่าย)
    "cors_origins": ["http://localhost:5173"],
    # สำรองข้อมูลระบบอัตโนมัติวันละครั้ง (เก็บไฟล์ล่าสุดตามจำนวนที่กำหนด ไฟล์ที่กดสำรองเองไม่ถูกลบ)
    "auto_backup": True,
    "backup_keep": 7,
    # บล็อกการเพิ่มความรู้ที่มีข้อมูลระบุตัวตน (เลขบัตร/HN/เบอร์/อีเมล) จนกว่าผู้ใช้ยืนยัน
    "kb_pii_block": True,
    # ธงภายใน: เพิ่มโมเดล 14B ลงแคตตาล็อกครั้งเดียวสำหรับผู้ใช้เดิม
    "seed_v2_applied": False,
    # ขอบเขตการตอบ (ตั้งจากหน้า "ควบคุมและเชื่อมต่อ"): ค่าเริ่มต้นอยู่ใน guard.py ว่าง = ใช้ค่าเริ่มต้นนั้น
    "scope": {},
    # การล็อกอิน (เก็บเฉพาะค่า hash ไม่เก็บรหัสผ่านจริง)
    "auth": {"enabled": False, "salt": "", "hash": "", "secret": ""},
}

_lock = threading.RLock()
_cache: dict | None = None
_cache_mtime: float = -1.0


def _deep_merge(base: dict, patch: dict) -> dict:
    """รวม dict แบบลึก: ค่าใน patch ทับค่าใน base (ไม่แก้ base ต้นฉบับ)"""
    out = copy.deepcopy(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def get_settings() -> dict:
    """อ่านการตั้งค่าปัจจุบัน (รวมกับค่าเริ่มต้น) — มี cache ตามเวลาแก้ไขไฟล์"""
    global _cache, _cache_mtime
    with _lock:
        mtime = SETTINGS_FILE.stat().st_mtime if SETTINGS_FILE.exists() else 0.0
        if _cache is not None and mtime == _cache_mtime:
            return copy.deepcopy(_cache)
        data: dict = {}
        if SETTINGS_FILE.exists():
            try:
                data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                data = {}
        _cache = _deep_merge(DEFAULT_SETTINGS, data if isinstance(data, dict) else {})
        _cache_mtime = mtime
        return copy.deepcopy(_cache)


def save_settings(patch: dict) -> dict:
    """บันทึกการตั้งค่าบางส่วน (patch) ลงไฟล์ แล้วคืนค่าทั้งหมดหลังรวม"""
    global _cache, _cache_mtime
    with _lock:
        current = get_settings()
        merged = _deep_merge(current, patch)
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(SETTINGS_FILE)  # เขียนไฟล์ชั่วคราวก่อนแล้วสลับ กันไฟล์พังถ้าดับกลางคัน
        _cache = None
        _cache_mtime = -1.0
        return get_settings()


def public_settings() -> dict:
    """การตั้งค่าที่ปลอดภัยจะส่งให้หน้าเว็บ (ตัดค่า hash/secret ของการล็อกอินออก)"""
    s = get_settings()
    auth = s.get("auth", {})
    s["auth"] = {"enabled": bool(auth.get("enabled"))}
    return s


def ollama_url() -> str:
    return get_settings()["ollama_url"].rstrip("/")
