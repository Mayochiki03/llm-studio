"""งานระบบ: ดูการใช้ดิสก์, ล้างไฟล์เก่า, สำรอง/กู้คืนข้อมูล, คำแนะนำตั้งค่า Ollama

ทุกการลบจำกัดอยู่ในโฟลเดอร์โปรเจกต์และตรงตามรูปแบบชื่อที่ระบบสร้างเองเท่านั้น
(ไม่ลบอะไรที่ผู้ใช้วางไว้เอง และไม่ลบของงานที่กำลังรัน)
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
import time
import zipfile
from pathlib import Path

import config
import db


def dir_size(path: Path) -> int:
    """ขนาดรวมของโฟลเดอร์/ไฟล์ (ไบต์) ข้ามลิงก์สัญลักษณ์เพื่อกันนับซ้ำ"""
    p = Path(path)
    if p.is_file():
        return p.stat().st_size
    total = 0
    for root, _dirs, files in os.walk(p, followlinks=False):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return total


def _gb(b: int) -> float:
    return round(b / 1e9, 2)


def disk_breakdown(running_job_ids: set[str] | None = None) -> dict:
    """แยกว่าดิสก์ถูกใช้ไปกับอะไร: cache โมเดล, โมเดลที่เทรนเสร็จ, GGUF, checkpoint, ข้อมูลระบบ, ไฟล์สำรอง"""
    root = config.PROJECT_ROOT
    running_job_ids = running_job_ids or set()
    items: list[dict] = []
    if not root.exists():
        return {"total_gb": 0.0, "items": []}

    def add(name: str, kind: str, deletable: bool, label: str = ""):
        p = root / name
        if p.exists():
            items.append({"name": name, "label": label or name, "kind": kind, "deletable": deletable,
                          "size_gb": _gb(dir_size(p))})

    add("hf_cache", "cache", False, "แคชโมเดลที่ดาวน์โหลด (hf_cache)")
    for p in sorted(root.iterdir()):
        n = p.name
        if n.startswith("outputs_") and p.is_dir():
            jid = n[len("outputs_"):]
            add(n, "checkpoint", jid not in running_job_ids, f"checkpoint ของงาน {jid}")
        elif n.endswith("_gguf") and p.is_dir():
            add(n, "gguf", True, f"ไฟล์ GGUF: {n}")
        elif n.endswith("-gguf") and p.is_dir():
            add(n, "gguf", True, f"ไฟล์ GGUF: {n}")
        elif p.is_dir() and (p / "adapter_config.json").exists():
            add(n, "model", True, f"โมเดลที่เทรนเสร็จ (LoRA): {n}")
    add("studio_data", "data", False, "ข้อมูลระบบ (คลังความรู้ ทะเบียนโมเดล ตั้งค่า)")
    add("backups", "backup", True, "ไฟล์สำรอง")
    items.sort(key=lambda x: -x["size_gb"])
    return {"total_gb": round(sum(i["size_gb"] for i in items), 2), "items": items}


def delete_item(name: str, running_job_ids: set[str] | None = None) -> dict:
    """ลบรายการที่ disk_breakdown() ระบุว่า deletable เท่านั้น (ตรวจชื่อซ้ำอีกชั้นกันถูกเรียกมั่ว)"""
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("ชื่อไม่ถูกต้อง")
    info = next((i for i in disk_breakdown(running_job_ids)["items"] if i["name"] == name), None)
    if not info or not info["deletable"]:
        raise ValueError("รายการนี้ลบไม่ได้ (ไม่พบ หรือเป็นของงานที่กำลังรัน หรือเป็นข้อมูลระบบ)")
    p = config.PROJECT_ROOT / name
    shutil.rmtree(p, ignore_errors=True)
    db.audit("system.delete", name, f"{info['size_gb']} GB")
    return {"ok": True, "freed_gb": info["size_gb"]}


def cleanup_scripts() -> int:
    """ลบสคริปต์ชั่วคราวที่ระบบสร้าง (_studio_train_*.py, _studio_export_*.py, Modelfile.*) คืนจำนวนไฟล์ที่ลบ"""
    n = 0
    for pat in ("_studio_train_*.py", "_studio_export_*.py"):
        for p in config.PROJECT_ROOT.glob(pat):
            try:
                p.unlink()
                n += 1
            except OSError:
                pass
    return n


# ---------------------------------------------------------------- สำรอง / กู้คืน

def _safe_db_copy(dest: Path) -> bool:
    """คัดลอกฐานข้อมูลอย่างปลอดภัยด้วย sqlite backup API (ไม่ต้องหยุดระบบ ไม่ได้ไฟล์ครึ่งๆ กลางๆ)"""
    if not config.DB_FILE.exists():
        return False
    src = sqlite3.connect(str(config.DB_FILE))
    try:
        dst = sqlite3.connect(str(dest))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return True


def create_backup(auto: bool = False) -> dict:
    """สร้างไฟล์ zip สำรองของ studio_data (ฐานข้อมูล, ตั้งค่า, ชุดข้อมูล, แคตตาล็อก) ไว้ที่ backups/"""
    config.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    prefix = "studio-backup-auto-" if auto else "studio-backup-"
    name = f"{prefix}{stamp}.zip"
    n = 2
    while (config.BACKUP_DIR / name).exists():  # สำรองสองครั้งในวินาทีเดียวกันต้องไม่ทับกัน (เช่น สำรองจุดย้อนกลับตอนกู้คืน)
        name = f"{prefix}{stamp}-{n}.zip"
        n += 1
    out = config.BACKUP_DIR / name
    with tempfile.TemporaryDirectory() as td:
        snap = Path(td) / "studio.db"
        has_db = _safe_db_copy(snap)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            if has_db:
                z.write(snap, "studio_data/studio.db")
            for p in config.DATA_DIR.rglob("*"):
                if not p.is_file() or p.name.startswith("studio.db") or p.suffix == ".tmp":
                    continue
                z.write(p, "studio_data/" + p.relative_to(config.DATA_DIR).as_posix())
    db.audit("system.backup", name, f"{round(out.stat().st_size / 1e6, 1)} MB")
    return {"name": name, "size_mb": round(out.stat().st_size / 1e6, 1)}


def auto_backup_due(max_age_h: float = 24.0) -> bool:
    """True ถ้ายังไม่เคยสำรองอัตโนมัติ หรือครั้งล่าสุดเก่ากว่า max_age_h ชั่วโมง"""
    if not config.BACKUP_DIR.exists():
        return True
    autos = list(config.BACKUP_DIR.glob("studio-backup-auto-*.zip"))
    if not autos:
        return True
    return time.time() - max(p.stat().st_mtime for p in autos) > max_age_h * 3600


def prune_auto_backups(keep: int) -> int:
    """เก็บเฉพาะไฟล์สำรองอัตโนมัติล่าสุด keep ไฟล์ ลบที่เหลือ (ไฟล์ที่กดสำรองเองไม่แตะ) คืนจำนวนที่ลบ"""
    keep = max(1, keep)
    autos = sorted(config.BACKUP_DIR.glob("studio-backup-auto-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    removed = 0
    for p in autos[keep:]:
        try:
            p.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def list_backups() -> list[dict]:
    if not config.BACKUP_DIR.exists():
        return []
    out = []
    for p in sorted(config.BACKUP_DIR.glob("studio-backup-*.zip"), reverse=True):
        out.append({"name": p.name, "size_mb": round(p.stat().st_size / 1e6, 1), "created_at": p.stat().st_mtime})
    return out


def backup_path(name: str) -> Path:
    if "/" in name or "\\" in name or not name.startswith("studio-backup-") or not name.endswith(".zip"):
        raise ValueError("ชื่อไฟล์สำรองไม่ถูกต้อง")
    p = config.BACKUP_DIR / name
    if not p.exists():
        raise ValueError("ไม่พบไฟล์สำรองนี้")
    return p


def restore_backup(zip_path: Path) -> dict:
    """กู้คืนจากไฟล์สำรอง: สำรองสถานะปัจจุบันไว้ก่อนเสมอ, ตรวจ path ใน zip กัน zip-slip, แล้วค่อยเขียนทับ"""
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        for n in names:
            if n.startswith("/") or ".." in Path(n).parts or not n.startswith("studio_data/"):
                raise ValueError("ไฟล์สำรองนี้ไม่ถูกต้องหรือไม่ปลอดภัย")
        if not any(n.endswith("studio.db") or n.endswith(".json") for n in names):
            raise ValueError("ไม่พบข้อมูลของ LLM Studio ในไฟล์นี้")
        pre = create_backup()  # จุดย้อนกลับ ถ้ากู้แล้วไม่ถูกใจ
        db.close()
        for f in ("studio.db", "studio.db-wal", "studio.db-shm"):
            (config.DATA_DIR / f).unlink(missing_ok=True)
        for n in names:
            if n.endswith("/"):
                continue
            target = config.DATA_DIR / Path(n).relative_to("studio_data")
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(n) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
    config.save_settings({})  # ล้าง cache ตั้งค่า
    db.audit("system.restore", zip_path.name, f"safety={pre['name']}")
    return {"ok": True, "restored": zip_path.name, "safety_backup": pre["name"]}


# ---------------------------------------------------------------- คำแนะนำ Ollama

def ollama_tuning(vram_gb: float, is_windows: bool) -> list[dict]:
    """ตัวแปรสภาพแวดล้อมของ Ollama ที่ควรตั้งให้เหมาะกับการ์ดจอ + วิธีตั้งตามระบบปฏิบัติการ"""
    big = vram_gb >= 20
    recs = [
        {"key": "OLLAMA_FLASH_ATTENTION", "value": "1",
         "why": "ลดการใช้ VRAM ของ context ยาวและเร็วขึ้นบนการ์ด RTX"},
        {"key": "OLLAMA_KV_CACHE_TYPE", "value": "q8_0",
         "why": "บีบ KV cache ครึ่งหนึ่ง (ต้องเปิด flash attention) ใส่ context ได้ยาวขึ้นในการ์ดเดิม คุณภาพแทบไม่ต่าง"},
        {"key": "OLLAMA_NUM_PARALLEL", "value": "4" if big else "1",
         "why": "จำนวนคำถามที่ตอบพร้อมกัน เซิร์ฟเวอร์ใช้งานหลายคนควรมากกว่า 1 แต่กิน VRAM เพิ่มตามจำนวน"},
        {"key": "OLLAMA_MAX_LOADED_MODELS", "value": "2" if big else "1",
         "why": "เซิร์ฟเวอร์ต้องถือโมเดลตอบคำถามกับโมเดลสร้างเวกเตอร์พร้อมกัน; การ์ดเล็กให้ถือตัวเดียว"},
        {"key": "OLLAMA_KEEP_ALIVE", "value": "30m",
         "why": "เก็บโมเดลไว้ใน VRAM หลังใช้ ไม่ต้องโหลดใหม่ทุกคำถาม (ระบบจะปลดให้เองก่อนเทรน)"},
    ]
    how = ("Linux (systemd): sudo systemctl edit ollama แล้วเพิ่ม [Service] Environment=\"KEY=VALUE\" จากนั้น sudo systemctl restart ollama"
           if not is_windows else
           "Windows: ตั้ง Environment Variable ของผู้ใช้ (setx KEY VALUE) แล้วปิดและเปิด Ollama ใหม่")
    for r in recs:
        r["how"] = how
    return recs
