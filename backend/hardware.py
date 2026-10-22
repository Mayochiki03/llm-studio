"""ตรวจฮาร์ดแวร์ของเครื่อง (GPU / RAM / ดิสก์ / CPU) และแนะนำค่าเทรนที่เหมาะกับเครื่องนั้น

ใช้ nvidia-smi (ถ้ามี) และ psutil (ถ้ามี) — ไม่มีก็ไม่ error แค่คืนค่าว่าง
ส่วน recommend_training() เป็นฟังก์ชันล้วน (ไม่แตะเครื่อง) เพื่อให้ทดสอบได้โดยไม่ต้องมี GPU
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import config

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover
    psutil = None


def probe_gpus() -> list[dict]:
    """อ่านรายการ GPU จาก nvidia-smi: ชื่อ, VRAM รวม/ใช้/ว่าง (GB), อุณหภูมิ, % การใช้งาน"""
    if not shutil.which("nvidia-smi"):
        return []
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.total,memory.used,memory.free,temperature.gpu,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=8,
        ).stdout
    except Exception:
        return []
    gpus: list[dict] = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 7:
            continue
        try:
            gpus.append({
                "index": int(parts[0]),
                "name": parts[1],
                "vram_total_gb": round(float(parts[2]) / 1024, 2),
                "vram_used_gb": round(float(parts[3]) / 1024, 2),
                "vram_free_gb": round(float(parts[4]) / 1024, 2),
                "temp_c": int(float(parts[5])) if parts[5].replace(".", "").isdigit() else None,
                "util_pct": int(float(parts[6])) if parts[6].replace(".", "").isdigit() else None,
            })
        except ValueError:
            continue
    return gpus


def probe_ram() -> dict:
    """RAM รวม/ว่าง (GB)"""
    if psutil is None:
        return {"total_gb": 0.0, "available_gb": 0.0}
    vm = psutil.virtual_memory()
    return {"total_gb": round(vm.total / 1e9, 1), "available_gb": round(vm.available / 1e9, 1)}


def probe_disk(path: Path | None = None) -> dict:
    """ที่ว่างบนดิสก์ที่เก็บโปรเจกต์ (GB)"""
    p = Path(path or config.PROJECT_ROOT)
    while not p.exists() and p != p.parent:  # โฟลเดอร์ยังไม่ถูกสร้าง ให้ไล่ขึ้นไปหาแม่ที่มีจริง
        p = p.parent
    try:
        u = shutil.disk_usage(str(p))
        return {"path": str(config.PROJECT_ROOT), "total_gb": round(u.total / 1e9, 1),
                "free_gb": round(u.free / 1e9, 1), "used_gb": round(u.used / 1e9, 1)}
    except OSError:
        return {"path": str(config.PROJECT_ROOT), "total_gb": 0.0, "free_gb": 0.0, "used_gb": 0.0}


def probe_cpu() -> dict:
    if psutil is None:
        return {"cores": 0, "threads": 0}
    return {"cores": psutil.cpu_count(logical=False) or 0, "threads": psutil.cpu_count(logical=True) or 0}


def probe_all() -> dict:
    """รวมทุกอย่างให้หน้า System / Dashboard / Preflight ใช้"""
    gpus = probe_gpus()
    return {
        "gpus": gpus,
        "gpu": gpus[0] if gpus else None,
        "ram": probe_ram(),
        "disk": probe_disk(),
        "cpu": probe_cpu(),
        "os": "windows" if config.IS_WINDOWS else "linux",
    }


def recommend_training(vram_gb: float, params_b: float, max_seq_length: int = 1024,
                       is_linux: bool = False, cpu_threads: int = 4) -> dict:
    """แนะนำ batch size / grad accumulation / ตัวเลือกเร่งความเร็ว จาก VRAM และขนาดโมเดล

    หลักคิด: ใช้ VRAM ที่เหลือหลังโหลดน้ำหนักโมเดล 4-bit มาเพิ่ม batch ให้ GPU ทำงานเต็มที่
    แต่เก็บ effective batch (batch x accum) ไว้ราว 8-16 เพื่อให้การเรียนรู้เสถียร
    ค่าที่คืนเป็น "ค่าแนะนำ" ผู้ใช้แก้เองได้ในโหมดขั้นสูง
    """
    if vram_gb <= 0:
        # ไม่พบ GPU: ให้ค่าที่ปลอดภัยที่สุด (เทรนบน CPU แทบใช้ไม่ได้ จึงเตือนที่ Preflight)
        return {"batch_size": 1, "grad_accum": 8, "packing": False, "workers": 0,
                "note": "ไม่พบ GPU จึงใช้ค่าที่เบาที่สุด"}
    weights = params_b * 0.6 + 1.0
    free_for_act = max(0.0, vram_gb - weights - 0.5)
    # activations ต่อ 1 ตัวอย่าง (ประมาณ) ตามความยาวลำดับและขนาดโมเดล
    per_sample = (max_seq_length / 512.0) * (0.25 + 0.04 * params_b)
    batch = int(free_for_act // per_sample) if per_sample > 0 else 1
    batch = max(1, min(batch, 16))
    # ปัดลงเป็นเลขยกกำลัง 2 เพื่อให้ตารางงานสม่ำเสมอ
    p2 = 1
    while p2 * 2 <= batch:
        p2 *= 2
    batch = p2
    target_effective = 16 if vram_gb >= 20 else 8
    accum = max(1, target_effective // batch)
    # packing ช่วยให้ไม่เสียเวลากับ padding เมื่อข้อความสั้นๆ จำนวนมาก (opt-in เท่านั้น)
    packing = vram_gb >= 16
    workers = min(4, max(0, cpu_threads // 4)) if is_linux else 0  # Windows ใช้ worker หลายตัวมักพัง
    return {"batch_size": batch, "grad_accum": accum, "packing": packing, "workers": workers,
            "note": f"VRAM {vram_gb:.0f} GB: batch {batch} x accum {accum}"}
