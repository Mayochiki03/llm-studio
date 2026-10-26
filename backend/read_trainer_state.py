"""อ่านประวัติ loss (train และ validation) จาก trainer_state.json ใน checkpoint ของงานเทรน

ใช้กู้ค่า val_loss ของงานเก่าที่หน้าเว็บบันทึกไม่ครบ (บั๊กที่แก้ใน 0.7.3) หรือดูผลของงานใดก็ได้
อ่านอย่างเดียว ไม่แก้ไขไฟล์ใดๆ และไม่ส่งข้อมูลออกนอกเครื่อง

วิธีใช้:  python read_trainer_state.py E:\\AiProject\\outputs_xxx\\checkpoint-328\\trainer_state.json
"""
from __future__ import annotations
import json
import sys


def read_history(path: str) -> dict:
    """อ่านไฟล์แล้วแยกเป็นรายการ train loss และ eval loss ตาม step"""
    with open(path, encoding="utf-8") as f:
        state = json.load(f)
    train, val = [], []
    for h in state.get("log_history", []):
        step = h.get("step")
        if step is None:
            continue
        if "loss" in h:
            train.append((int(step), float(h["loss"])))
        if "eval_loss" in h:
            val.append((int(step), float(h["eval_loss"])))
    return {"train": train, "val": val, "max_steps": state.get("max_steps"), "epoch": state.get("epoch")}


def verdict(val: list[tuple[int, float]]) -> str:
    """สรุปแนวโน้ม val_loss แบบง่ายๆ: ลงต่อ / ลงแล้วนิ่ง / เริ่มขึ้น (สัญญาณท่องจำเกิน)"""
    if len(val) < 3:
        return "จุด validation น้อยเกินไปที่จะสรุป"
    best = min(val, key=lambda x: x[1])
    last = val[-1]
    if best[0] == last[0]:
        return "val_loss ยังลดลงจนจบ (ยังไม่เห็นสัญญาณท่องจำเกิน)"
    if last[1] > best[1] * 1.10:
        return f"val_loss ต่ำสุดที่ step {best[0]} ({best[1]:.4f}) แล้วเริ่มสูงขึ้นเป็น {last[1]:.4f} → มีสัญญาณท่องจำเกิน ควรลด epochs"
    return f"val_loss ต่ำสุดที่ step {best[0]} ({best[1]:.4f}) แล้วนิ่ง ({last[1]:.4f}) → เทรนต่อไม่ได้ช่วยเพิ่ม ลด epochs ได้"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 1
    r = read_history(argv[1])
    print(f"max_steps={r['max_steps']}  epoch={r['epoch']}  จุด train={len(r['train'])}  จุด validation={len(r['val'])}\n")
    print("step    eval_loss (validation)")
    for s, v in r["val"]:
        print(f"{s:<7} {v:.4f}")
    if r["train"]:
        print(f"\ntrain loss: เริ่ม {r['train'][0][1]:.4f} → จบ {r['train'][-1][1]:.4f}")
    print("\nสรุป:", verdict(r["val"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
