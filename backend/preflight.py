"""Preflight: ประเมินก่อนเริ่มเทรนว่า VRAM / RAM / ดิสก์ พอหรือไม่ และบอกเป็นภาษาไทย

ผลลัพธ์เป็นสัญญาณไฟจราจร: ok (เขียว) / tight (เหลือง เสี่ยง) / no (แดง ไม่ควรเริ่ม)
ตัวเลขเป็นการ "ประมาณ" ด้วยสูตรง่ายๆ ไม่ใช่ค่าจริง จึงเผื่อไว้และเตือนเมื่อใกล้เต็ม
"""
from __future__ import annotations

import hardware

# น้ำหนัก 4-bit ≈ params_b x 0.6 GB (รวมโครงสร้างเสริม) + overhead ของ CUDA/Unsloth ≈ 1 GB
OVERHEAD_GB = 1.0


def estimate_vram_gb(params_b: float, batch_size: int, max_seq_length: int) -> float:
    """ประเมิน VRAM (GB) ที่ QLoRA จะใช้"""
    weights = params_b * 0.6 + OVERHEAD_GB
    activations = batch_size * (max_seq_length / 512.0) * (0.25 + 0.04 * params_b)
    return round(weights + activations, 1)


def estimate_export_disk_gb(params_b: float) -> float:
    """พื้นที่ดิสก์ชั่วคราวตอน merge + แปลง GGUF (fp16 + gguf + ไฟล์ระหว่างทาง)"""
    return round(params_b * 5.0, 1)


def _level_rank(level: str) -> int:
    return {"ok": 0, "tight": 1, "no": 2}[level]


def evaluate(params_b: float, batch_size: int, max_seq_length: int, hw: dict | None = None,
             export_after: bool = True) -> dict:
    """ตรวจทุกด้านแล้วคืน {level, vram_need, checks:[{key,level,title,detail}], summary}"""
    hw = hw or hardware.probe_all()
    checks: list[dict] = []

    need = estimate_vram_gb(params_b, batch_size, max_seq_length)
    gpu = hw.get("gpu")
    if not gpu:
        checks.append({"key": "gpu", "level": "no", "title": "ไม่พบการ์ดจอ NVIDIA",
                       "detail": "เทรนต้องใช้ GPU ตรวจว่าติดตั้งไดรเวอร์แล้ว และ nvidia-smi ใช้งานได้"})
    else:
        total = gpu["vram_total_gb"]
        free = gpu["vram_free_gb"]
        if need > total * 0.97:
            lvl, d = "no", (f"ต้องใช้ประมาณ {need} GB แต่การ์ดมี {total} GB "
                            "ลองลดความยาวข้อความสูงสุด ลด batch หรือเลือกโมเดลที่เล็กลง")
        elif need > free:
            lvl, d = "tight", (f"ต้องใช้ประมาณ {need} GB แต่ว่างอยู่ {free} GB "
                               "มีโปรแกรมอื่น (เช่น Ollama) ถือ VRAM อยู่ ระบบจะปลดให้ก่อนเทรนถ้าเปิดตัวเลือกไว้")
        elif need > total * 0.85:
            lvl, d = "tight", f"ต้องใช้ประมาณ {need} GB จาก {total} GB ใกล้เต็ม อาจเกิด out-of-memory ระหว่างทาง"
        else:
            lvl, d = "ok", f"ต้องใช้ประมาณ {need} GB จาก {total} GB (ว่าง {free} GB)"
        checks.append({"key": "vram", "level": lvl, "title": "หน่วยความจำการ์ดจอ (VRAM)", "detail": d})

    ram = hw.get("ram", {})
    ram_need = round(max(8.0, params_b * 2.0), 1) if export_after else 8.0
    ram_avail = ram.get("available_gb", 0)
    if ram.get("total_gb", 0) == 0:
        pass
    elif ram_avail < ram_need * 0.6:
        checks.append({"key": "ram", "level": "no", "title": "หน่วยความจำเครื่อง (RAM)",
                       "detail": f"ว่างเพียง {ram_avail} GB แต่ควรมีอย่างน้อย {ram_need} GB ปิดโปรแกรมอื่นก่อน"})
    elif ram_avail < ram_need:
        checks.append({"key": "ram", "level": "tight", "title": "หน่วยความจำเครื่อง (RAM)",
                       "detail": f"ว่าง {ram_avail} GB ควรมี {ram_need} GB ขึ้นไป อาจช้าเพราะใช้ swap"})
    else:
        checks.append({"key": "ram", "level": "ok", "title": "หน่วยความจำเครื่อง (RAM)",
                       "detail": f"ว่าง {ram_avail} GB (ต้องการประมาณ {ram_need} GB)"})

    disk = hw.get("disk", {})
    disk_need = estimate_export_disk_gb(params_b) if export_after else round(params_b * 1.0 + 2, 1)
    free_disk = disk.get("free_gb", 0)
    if disk.get("total_gb", 0) == 0:
        pass
    elif free_disk < disk_need:
        checks.append({"key": "disk", "level": "no", "title": "พื้นที่ดิสก์",
                       "detail": f"ว่าง {free_disk} GB แต่ต้องใช้ประมาณ {disk_need} GB (รวมการแปลงเป็น GGUF) ล้างไฟล์เก่าในหน้าระบบก่อน"})
    elif free_disk < disk_need * 1.5:
        checks.append({"key": "disk", "level": "tight", "title": "พื้นที่ดิสก์",
                       "detail": f"ว่าง {free_disk} GB ต้องใช้ประมาณ {disk_need} GB เหลือไม่มาก"})
    else:
        checks.append({"key": "disk", "level": "ok", "title": "พื้นที่ดิสก์",
                       "detail": f"ว่าง {free_disk} GB (ต้องการประมาณ {disk_need} GB)"})

    level = "ok"
    for c in checks:
        if _level_rank(c["level"]) > _level_rank(level):
            level = c["level"]
    summary = {"ok": "พร้อมเทรน", "tight": "เริ่มได้ แต่เสี่ยง ดูคำเตือนด้านล่าง",
               "no": "ยังไม่ควรเริ่ม มีข้อที่ไม่พอ"}[level]
    return {"level": level, "summary": summary, "vram_need_gb": need, "disk_need_gb": disk_need,
            "checks": checks}
