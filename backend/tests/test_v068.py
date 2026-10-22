"""ทดสอบรุ่น 0.6.8: โหลดแพ็กตัวอย่าง, โจทย์ตั้งต้นที่ลบแล้วไม่โผล่กลับ, ข้อมูลแพ็กตรงกับตัวตรวจคำตอบ"""
import json
import load_sample_pack
import store
import evalx


def test_โหลดแพ็กแบบล้างของเก่า():
    r = load_sample_pack.load_pack(reset=True)
    assert r["examples"] == 70 and r["prompts"] == 16
    prompts = store.list_prompts()
    assert len(prompts) == 16                      # โจทย์ตั้งต้นเดิมถูกล้างและไม่ถูกเติมกลับ
    customs = [d for d in store.list_datasets() if d.get("kind") == "custom"]
    assert len(customs) == 1


def test_โหลดซ้ำไม่เกิดรายการซ้ำ():
    load_sample_pack.load_pack(reset=True)
    load_sample_pack.load_pack()
    assert len(store.list_prompts()) == 16
    assert len([d for d in store.list_datasets() if d.get("kind") == "custom"]) == 1


def test_ลบโจทย์ตั้งต้นแล้วไม่โผล่กลับ():
    store.delete_prompt("rf-1")
    assert all(p["id"] != "rf-1" for p in store.list_prompts())


def test_คำตอบในชุดเทรนผ่านเงื่อนไขของโจทย์ทดสอบ():
    """ทุกโจทย์ทดสอบต้องมีคำตอบอย่างน้อยหนึ่งข้อในชุดเทรนที่มีคำ expect ครบ (ไม่งั้นโมเดลไม่มีทางรู้คำนั้น)"""
    base = load_sample_pack.PACK_DIR
    train = [json.loads(x) for x in (base / "train.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    prompts = json.loads((base / "eval-prompts.json").read_text(encoding="utf-8"))
    train_questions = {t["instruction"] for t in train}
    for p in prompts:
        assert p["text"] not in train_questions     # ข้อสอบต้องไม่ซ้ำกับข้อเทรน
        ok = any(evalx.check_reply(p, t["output"])["passed"] for t in train)
        assert ok, f"ไม่มีคำตอบในชุดเทรนที่ผ่านโจทย์: {p['text']}"
