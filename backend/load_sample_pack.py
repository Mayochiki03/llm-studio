"""โหลดแพ็กตัวอย่าง (samples/pack-01) เข้าระบบโดยตรง: ชุดข้อมูลเทรน + โจทย์ทดสอบ

วิธีใช้ (รันในโฟลเดอร์ backend ด้วย venv เดียวกับที่รัน backend; ไม่ต้องปิด backend):
    python load_sample_pack.py            # เพิ่มแพ็กเข้าไป
    python load_sample_pack.py --reset    # ล้างโจทย์ทดสอบเดิมทั้งหมดและชุดข้อมูลเทรนที่สร้างเองเดิมก่อน แล้วโหลดแพ็ก
ข้อมูลในแพ็กเป็นข้อมูลสมมติทั้งหมด ไม่ใช่ข้อมูลผู้ป่วยหรือข้อมูลจริงของโรงพยาบาลใด
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import datasets_mgr
import store

PACK_DIR = Path(__file__).resolve().parent.parent / "samples" / "pack-01"
PACK_LABEL = "ตัวอย่าง: FAQ โรงพยาบาลสมมติ (70 คู่)"


def load_pack(reset: bool = False, pack_dir: Path = PACK_DIR) -> dict:
    """โหลดแพ็ก คืนสรุปจำนวนที่ทำ (ฟังก์ชันแยกไว้ให้ทดสอบได้)"""
    train = [json.loads(x) for x in (pack_dir / "train.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    prompts = json.loads((pack_dir / "eval-prompts.json").read_text(encoding="utf-8"))

    if reset:
        for p in store.list_prompts():
            store.delete_prompt(p["id"])
        for d in store.list_datasets():
            if d.get("kind") == "custom":
                store.delete_dataset(d["id"])
    else:  # ไม่ล้าง: ลบเฉพาะแพ็กเดิมที่เคยโหลด กันซ้ำ
        for d in store.list_datasets():
            if d.get("label") == PACK_LABEL:
                store.delete_dataset(d["id"])
        texts = {p["text"] for p in prompts}
        for p in store.list_prompts():
            if p["text"] in texts:
                store.delete_prompt(p["id"])

    res = datasets_mgr.create_dataset(PACK_LABEL, "ข้อมูลสมมติ ใช้ทดลองเทรนและวัดผลกับโจทย์ทดสอบชุดเดียวกัน", train, source="sample-pack")
    for p in prompts:
        store.add_prompt(p["text"], p.get("category", ""), p.get("expect"), p.get("must_not"),
                         bool(p.get("red_flag")), bool(p.get("pinned")))
    return {"dataset_id": res["dataset_id"], "examples": res["count"], "prompts": len(prompts)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reset", action="store_true", help="ล้างโจทย์ทดสอบเดิมและชุดข้อมูลเองเดิมก่อนโหลด")
    a = ap.parse_args()
    r = load_pack(a.reset)
    print(f"โหลดแล้ว: ชุดข้อมูล {r['examples']} ตัวอย่าง, โจทย์ทดสอบ {r['prompts']} ข้อ")
    sys.exit(0)
