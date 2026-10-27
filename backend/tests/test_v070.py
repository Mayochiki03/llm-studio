"""ทดสอบรุ่น 0.7.0: ตัวสร้างชุดข้อมูลจากตารางข้อเท็จจริง และแพ็ก 2"""
import json
import faqbuilder
import evalx
import load_sample_pack
import store


FACTS = [{"topic": "เวลา", "answer": "เปิด 08.00-16.00 น.", "keywords": ["08.00"],
          "questions": ["เปิดกี่โมง", "เวลาทำการ", "เปิดวันไหน", "ปิดกี่โมง"]}]


def test_ขยายสำนวนและกันข้อสอบ():
    r = faqbuilder.build(FACTS, include_defaults=False, extra_eval=False)
    assert r["stats"]["eval"] == 1 and r["eval"][0]["text"] == "ปิดกี่โมง"
    assert all(t["instruction"] != "ปิดกี่โมง" for t in r["train"])
    assert len(r["train"]) == 3 * 2


def test_ไม่ขยายและไม่ใส่ตัวอย่างพื้นฐาน():
    r = faqbuilder.build(FACTS, augment=False, include_defaults=False)
    assert len(r["train"]) == 3


def test_แถวไม่ครบถูกข้าม():
    r = faqbuilder.build([{"topic": "x", "answer": "", "questions": ["a"]}, {"topic": "y", "answer": "z", "questions": []}])
    assert r["stats"]["skipped"] == 2


def test_คำถามน้อยกว่า3ไม่กันข้อสอบ():
    r = faqbuilder.build([{"topic": "t", "answer": "a", "keywords": ["a"], "questions": ["q1", "q2"]}], include_defaults=False)
    assert r["stats"]["eval"] == 0 and len(r["train"]) == 2 * 2


def test_แพ็ก2ครบและข้อสอบผ่านคำตอบในชุดเทรน():
    facts = json.loads((load_sample_pack.PACK2_DIR / "facts.json").read_text(encoding="utf-8"))
    r = faqbuilder.build(facts)
    train_q = {t["instruction"] for t in r["train"]}
    # 16 จากข้อเท็จจริง + 2 ทั่วไป + 8 นอกขอบเขต + 20 ข้อสอบเพิ่ม (0.8.3) + ข้อสอบเอกสารขัดความจำ
    assert r["stats"]["eval"] == 50 and r["stats"]["train"] > 250 and r["stats"]["conflict_eval"] == 4
    for p in r["eval"]:
        if p.get("context"):  # ข้อสอบเอกสารขัดความจำ: คำตอบที่คาดคือเลขใหม่ ไม่ได้อยู่ในชุดเทรนโดยตั้งใจ
            assert all(e in p["context"] for e in p["expect"]) and not any(m in p["context"] for m in p["must_not"])
            continue
        assert p["text"] not in train_q
        assert any(evalx.check_reply(p, t["output"])["passed"] for t in r["train"]), p["text"]


def test_โหลดแพ็ก2เข้าระบบ():
    res = load_sample_pack.load_pack2(reset=True, kb=True)
    assert res["examples"] > 250 and res["prompts"] == 50 and res["kb_docs"] == 16
    assert len(store.list_prompts()) == 50
    assert len([d for d in store.list_datasets() if d.get("kind") == "custom"]) == 1


def test_โหลดแพ็ก2ซ้ำไม่ทำให้คลังความรู้ซ้ำสะสม():
    import kb as kbmod
    kbmod.add_doc("เอกสารของผู้ใช้", "ข้อมูลที่ผู้ใช้เพิ่มเอง", category="ของฉัน", source_name="manual")
    load_sample_pack.load_pack2(reset=True, kb=True)
    load_sample_pack.load_pack2(reset=True, kb=True)
    docs = kbmod.list_docs()
    assert sum(1 for d in docs if d.get("source_name") == "sample-pack-02") == 16
    assert any(d["title"] == "เอกสารของผู้ใช้" for d in docs)  # ของผู้ใช้ไม่ถูกลบ
