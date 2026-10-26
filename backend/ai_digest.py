"""สรุปผลเทรนแบบ "ตัวเลขล้วน" เพื่อให้ AI (Gemini) ช่วยอ่านผลเป็นภาษาไทย โดยข้อมูลไม่หลุด

หลักความปลอดภัย (whitelist): ส่งได้เฉพาะ
  - ค่าตั้งต้นของการเทรน (r, alpha, epochs, learning rate, ความยาวสูงสุด, batch, จำนวนตัวอย่าง, สัดส่วนตรวจสอบ)
  - ชื่อโมเดลฐานสาธารณะ (เช่น scb10x/llama3.2-typhoon2-3b-instruct)
  - ค่า loss/val_loss รายจุด (ตัวเลข) และสถานะงาน
ไม่ส่ง: ชื่อชุดข้อมูล, ชื่อโมเดลที่เราตั้ง, เนื้อหาตัวอย่างเทรน, log, ข้อความ error, path, คลังความรู้, ข้อมูลผู้ป่วย
หน้าเว็บให้ดูข้อมูลที่จะส่ง "ก่อน" กดส่งทุกครั้ง และฟังก์ชันนี้คือตัวเดียวที่ประกอบข้อมูลที่ส่ง
"""
from __future__ import annotations

MAX_POINTS = 40  # ลดจำนวนจุดให้ข้อความสั้น (ไม่หนักและไม่ส่งเกินจำเป็น)


def _round(x, n=4):
    return round(float(x), n) if isinstance(x, (int, float)) else None


def build_digest(job) -> dict:
    pts = list(job.loss_points or [])
    if len(pts) > MAX_POINTS:
        # เก็บจุดที่มี val_loss ไว้ทั้งหมดก่อน (มีไม่มาก และสำคัญต่อการดูว่าท่องจำเกินไหม) แล้วเติมจุด train loss เว้นระยะเท่าๆ กัน
        keep = {i for i, p in enumerate(pts) if p.get("val_loss") is not None}
        rest = [i for i in range(len(pts)) if i not in keep]
        room = max(2, MAX_POINTS - len(keep))
        if len(rest) > room:
            rest = [rest[round(k * (len(rest) - 1) / (room - 1))] for k in range(room)]
        pts = [pts[i] for i in sorted(keep | set(rest))]
    return {
        "base_model": str(job.base_model),
        "status": str(job.status),
        "settings": {
            "lora_r": int(job.r), "lora_alpha": int(job.lora_alpha), "epochs": _round(job.num_train_epochs, 2),
            "learning_rate": _round(job.learning_rate, 6), "max_seq_length": int(job.max_seq_length),
            "batch_size": int(job.batch_size or 0), "grad_accum": int(job.grad_accum or 0),
            "sample_size": int(job.sample_size or 0), "val_ratio": _round(job.val_ratio, 3),
        },
        # แยก 2 รายการให้ AI อ่านง่าย: train loss (ทุกจุดที่มี) กับ val_loss (เฉพาะจุดที่ตรวจ) ไม่ปน null กัน
        "train_loss": [
            {"step": int(p.get("step", 0)), "loss": _round(p.get("loss"))}
            for p in pts if p.get("loss") is not None
        ],
        "val_loss": [
            {"step": int(p.get("step", 0)), "val_loss": _round(p.get("val_loss"))}
            for p in pts if p.get("val_loss") is not None
        ],
    }


PROMPT = """คุณเป็นผู้ช่วยด้านการเทรนโมเดลภาษา (LoRA fine-tuning) ช่วยอ่านผลการเทรนด้านล่างให้คนที่ไม่ใช่ผู้เชี่ยวชาญเข้าใจ
ข้อมูลเป็นตัวเลขล้วน ไม่มีเนื้อหาข้อมูลเทรน ตอบเป็นภาษาไทย กระชับ ไม่เกิน 8 บรรทัด ใช้หัวข้อสั้นๆ 3 หัวข้อ เขียนเป็นข้อความธรรมดา ห้ามใช้เครื่องหมาย ** หรือ markdown อื่นๆ:
1) ภาพรวม: loss ลดลงดีไหม นิ่งหรือยัง
2) ความเสี่ยง: ท่องจำเกิน (train loss ลงต่อแต่ val_loss ไม่ลง/ขึ้น), ข้อมูลน้อย/ซ้ำ ฯลฯ (ถ้าไม่มี val_loss ให้บอกว่าประเมินไม่ได้)
ข้อมูลมี train_loss (ทุกสเต็ปที่บันทึก) และ val_loss (เฉพาะสเต็ปที่ตรวจชุดตรวจสอบ) แยกกัน ถ้า val_loss ว่างแปลว่าไม่ได้ตั้งชุดตรวจสอบ
3) ข้อแนะนำรอบหน้า: ปรับ epochs / learning rate / ข้อมูล อย่างไร (ให้เหตุผลสั้นๆ)
ห้ามเดาว่าโมเดลตอบถูกหรือผิด เพราะ loss บอกไม่ได้ ให้เตือนว่าต้องดูผลทดสอบจริงด้วย

ข้อมูลผลเทรน (JSON):
{digest}
"""


def build_prompt(digest: dict) -> str:
    import json
    return PROMPT.format(digest=json.dumps(digest, ensure_ascii=False))
