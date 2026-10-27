"""โหลดแพ็กตัวอย่างเข้าระบบโดยตรง: ชุดข้อมูลเทรน + โจทย์ทดสอบ (+ คลังความรู้ ถ้าใส่ --kb)

วิธีใช้ (รันในโฟลเดอร์ backend ด้วย venv เดียวกับที่รัน backend; ไม่ต้องปิด backend):
    python load_sample_pack.py --reset          # ล้างโจทย์ทดสอบ+ชุดข้อมูลเองเดิม แล้วโหลดแพ็ก 2 (แนะนำ)
    python load_sample_pack.py --reset --kb     # เหมือนกัน และใส่ข้อเท็จจริงเข้าคลังความรู้ด้วย (ไว้ลองเทียบกับ RAG)
    python load_sample_pack.py --pack 1         # แพ็กเล็กรุ่นเก่า (70 คู่)
ถ้า backend ใช้โฟลเดอร์ข้อมูลที่ตั้งด้วย LLM_STUDIO_ROOT ให้ตั้งตัวแปรเดียวกันก่อนรัน
ข้อมูลในแพ็กเป็นข้อมูลสมมติทั้งหมด ไม่ใช่ข้อมูลผู้ป่วยหรือข้อมูลจริงของโรงพยาบาลใด
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import datasets_mgr
import store

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
PACK_DIR = SAMPLES / "pack-01"
PACK2_DIR = SAMPLES / "pack-02"
PACK3_DIR = SAMPLES / "pack-03"
PACK_LABEL = "ตัวอย่าง: FAQ โรงพยาบาลสมมติ (70 คู่)"
PACK2_PREFIX = "ตัวอย่าง: FAQ โรงพยาบาลสมมติ v2"


def _clear(reset: bool, prompt_texts: set[str], label_prefix: str) -> None:
    """reset = ล้างโจทย์ทดสอบและชุดข้อมูลเองทั้งหมด; ไม่ reset = ลบเฉพาะของแพ็กเดิมที่เคยโหลด กันซ้ำ"""
    if reset:
        for p in store.list_prompts():
            store.delete_prompt(p["id"])
        for d in store.list_datasets():
            if d.get("kind") == "custom":
                store.delete_dataset(d["id"])
        return
    for d in store.list_datasets():
        if str(d.get("label", "")).startswith(label_prefix):
            store.delete_dataset(d["id"])
    for p in store.list_prompts():
        if p["text"] in prompt_texts:
            store.delete_prompt(p["id"])


def load_pack(reset: bool = False, pack_dir: Path = PACK_DIR) -> dict:
    """แพ็ก 1 (70 คู่ เขียนมือ) คืนสรุปจำนวนที่ทำ"""
    train = [json.loads(x) for x in (pack_dir / "train.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    prompts = json.loads((pack_dir / "eval-prompts.json").read_text(encoding="utf-8"))
    _clear(reset, {p["text"] for p in prompts}, PACK_LABEL)
    res = datasets_mgr.create_dataset(PACK_LABEL, "ข้อมูลสมมติ ใช้ทดลองเทรนและวัดผลกับโจทย์ทดสอบชุดเดียวกัน", train, source="sample-pack")
    for p in prompts:
        store.add_prompt(p["text"], p.get("category", ""), p.get("expect"), p.get("must_not"),
                         bool(p.get("red_flag")), bool(p.get("pinned")))
    return {"dataset_id": res["dataset_id"], "examples": res["count"], "prompts": len(prompts)}


def load_pack2(reset: bool = False, kb: bool = False, pack_dir: Path = PACK2_DIR) -> dict:
    """แพ็ก 2: สร้างจาก facts.json ผ่านตัวสร้างเดียวกับหน้าเว็บ (ขยายสำนวน + กันข้อสอบ + ตัวอย่างพื้นฐาน)"""
    import faqbuilder
    facts = json.loads((pack_dir / "facts.json").read_text(encoding="utf-8"))
    preview = faqbuilder.build(facts)
    _clear(reset, {p["text"] for p in preview["eval"]}, PACK2_PREFIX)
    label = f"{PACK2_PREFIX} ({preview['stats']['train']} คู่)"
    res = datasets_mgr.from_facts(label, "ข้อมูลสมมติ ขยายสำนวนอัตโนมัติ ข้อสอบแยกจากข้อเทรน", facts)
    kb_docs = 0
    if kb:
        import kb as kbmod
        # ลบเอกสารตัวอย่างที่เคยโหลดไว้ก่อน (รู้จากชื่อแหล่งที่มา sample-pack-02) กันเอกสารซ้ำสะสมทุกครั้งที่รันซ้ำ
        # เอกสารที่ผู้ใช้เพิ่มเองไม่ถูกแตะ และที่ลบยังย้อนกลับได้จากประวัติของคลังความรู้
        for d in kbmod.list_docs():
            if d.get("source_name") == "sample-pack-02":
                kbmod.delete_doc(d["id"])
        for f in facts:
            if f.get("answer") and f.get("topic"):
                kbmod.add_doc(f["topic"], f"หัวข้อ: {f['topic']}\nคำตอบ: {f['answer']}", kind="text",
                              category="FAQ ตัวอย่าง", source_name="sample-pack-02")
                kb_docs += 1
    return {"dataset_id": res["dataset_id"], "examples": res["examples"], "prompts": res["eval_added"], "kb_docs": kb_docs}


def load_redteam(pack_dir: Path = PACK3_DIR) -> dict:
    """แพ็ก 3: ข้อสอบแหย่โมเดล เพิ่มเข้ารายการโจทย์ (ไม่ล้างของเดิม ข้อความซ้ำข้าม) ไม่ปักหมุดเพื่อไม่ให้ปนกับชุดหลัก"""
    prompts = json.loads((pack_dir / "redteam.json").read_text(encoding="utf-8"))
    have = {p["text"] for p in store.list_prompts()}
    added = 0
    for p in prompts:
        if p["text"] in have:
            continue
        store.add_prompt(p["text"], p.get("category", ""), p.get("expect"), p.get("must_not"), bool(p.get("red_flag")), False)
        added += 1
    return {"added": added, "total": len(prompts)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reset", action="store_true", help="ล้างโจทย์ทดสอบเดิมและชุดข้อมูลเองเดิมก่อนโหลด")
    ap.add_argument("--pack", choices=["1", "2", "3"], default="2", help="เลือกแพ็ก (ค่าเริ่มต้น 2; 3 = ข้อสอบแหย่โมเดล เพิ่มเข้าไปโดยไม่ล้างของเดิม)")
    ap.add_argument("--kb", action="store_true", help="ใส่ข้อเท็จจริงเข้าคลังความรู้ด้วย (แพ็ก 2)")
    a = ap.parse_args()
    if a.pack == "3":
        r3 = load_redteam()
        print(f"เพิ่มข้อสอบแหย่โมเดล {r3['added']} ข้อ (จากทั้งหมด {r3['total']} ข้อ ที่เหลือมีอยู่แล้ว)")
        sys.exit(0)
    r = load_pack(a.reset) if a.pack == "1" else load_pack2(a.reset, a.kb)
    print(f"โหลดแล้ว: ชุดข้อมูล {r['examples']} ตัวอย่าง, โจทย์ทดสอบ {r['prompts']} ข้อ" + (f", คลังความรู้ {r['kb_docs']} เอกสาร" if r.get("kb_docs") else ""))
    sys.exit(0)
