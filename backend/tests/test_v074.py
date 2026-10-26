"""ทดสอบ 0.7.4: แบ่งชุดตรวจตามกลุ่ม, คำถามนอกขอบเขต, ส่ง group ผ่านชุดข้อมูล"""
import json
import jobs
import faqbuilder
import datasets_mgr
from fastapi.testclient import TestClient

FACTS = [{"topic": f"t{i}", "answer": f"ตอบ{i} 08.00", "questions": [f"คำถาม{i}-{j}" for j in range(4)], "keywords": ["08.00"]} for i in range(6)]


def _split():
    t = jobs._TRAIN_TEMPLATE
    ns: dict = {}
    exec(t[t.index("def _group_split"):t.index('eval_dataset = None\nif CFG["val_ratio"]')], ns)  # noqa: S102
    return ns["_group_split"]


def test_group_split_keeps_groups_together():
    r = faqbuilder.build(FACTS)
    groups = [x["group"] for x in r["train"]]
    tr, va, chosen = _split()(groups, 0.1, 3407)
    assert va and tr and set(tr).isdisjoint(va) and len(tr) + len(va) == len(groups)
    # ไม่มีกลุ่มไหนข้ามฝั่ง
    assert {groups[i] for i in tr}.isdisjoint({groups[i] for i in va})
    assert {groups[i] for i in va} == chosen
    # เสมอสำนวน: prefix ทุกแบบของคำถามเดียวกันอยู่ฝั่งเดียวกัน
    assert len(va) >= int(len(groups) * 0.1)


def test_out_of_scope_in_train_and_eval():
    r = faqbuilder.build(FACTS)
    assert r["stats"]["oos_eval"] >= 3
    outs = [x for x in r["train"] if x["group"].startswith("oos|")]
    assert outs and all("ไม่มีข้อมูล" in x["output"] for x in outs)
    held = [e for e in r["eval"] if e["category"] == "นอกขอบเขต"]
    assert held and all("ไม่มีข้อมูล" in e["expect"][0] for e in held)
    train_text = {x["instruction"] for x in r["train"]}
    assert all(e["text"] not in train_text for e in held)  # ข้อสอบต้องไม่เคยถูกสอน


def test_out_of_scope_custom_and_empty():
    assert faqbuilder.build(FACTS, out_of_scope=[])["stats"]["out_of_scope"] == 0
    r = faqbuilder.build(FACTS, out_of_scope=["มีสระว่ายน้ำไหม", "คำถาม0-0"], unknown_answer="ยังไม่ทราบค่ะ")
    assert r["stats"]["out_of_scope"] == 1  # ข้อที่ซ้ำกับคำถามจริงถูกกรองออก
    assert any(x["output"] == "ยังไม่ทราบค่ะ" for x in r["train"])


def test_oos_defaults_do_not_collide_with_pack02_facts():
    f = json.load(open(faqbuilder.__file__.replace("backend/faqbuilder.py", "samples/pack-02/facts.json"), encoding="utf-8"))
    real = {q for x in f for q in x["questions"]}
    assert not (set(faqbuilder.DEFAULT_OUT_OF_SCOPE) & real)


def test_group_survives_dataset_save():
    res = datasets_mgr.from_facts("g", "", FACTS)
    rows = datasets_mgr.read_jsonl(datasets_mgr.config.CUSTOM_DATASETS_DIR / f"{res['dataset_id']}.jsonl")
    assert rows and all(r.get("group") for r in rows)


def test_api_default_and_preview():
    import main
    c = TestClient(main.app)
    d = c.get("/api/datasets/out-of-scope-default").json()
    assert len(d["questions"]) >= 20 and "ไม่มีข้อมูล" in d["answer"]
    r = c.post("/api/datasets/facts-preview", json={"label": "x", "facts": FACTS, "out_of_scope": []}).json()
    assert r["stats"]["out_of_scope"] == 0
