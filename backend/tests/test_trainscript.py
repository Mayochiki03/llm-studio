"""ทดสอบส่วนแปลงคอลัมน์ชุดข้อมูลในสคริปต์เทรน (ไม่ต้องใช้ GPU/unsloth: ดึงเฉพาะฟังก์ชันช่วยออกมารัน)"""
import jobs


def _helpers():
    t = jobs._TRAIN_TEMPLATE
    a = t.index("def _norm_key")
    b = t.index('print("LLM_STUDIO: dataset columns')
    ns: dict = {}
    exec(t[a:b], ns)  # noqa: S102 — โค้ดของโปรเจกต์เอง
    return ns


def test_standard_columns():
    g = _helpers()["_get_pair"]
    assert g({"instruction": "ถาม", "input": "", "output": "ตอบ"}) == ("ถาม", "ตอบ")
    assert g({"instruction": "ถาม", "input": "บริบท", "output": "ตอบ"}) == ("ถาม\n\nบริบท", "ตอบ")


def test_other_names_and_case():
    g = _helpers()["_get_pair"]
    assert g({"Instruction": "q", "Output": "a"}) == ("q", "a")
    assert g({"prompt": "q", "response": "a"}) == ("q", "a")
    assert g({"Question": "q", "Answer": "a"}) == ("q", "a")
    assert g({"instruction": "q", "output": None}) == ("q", "")


def test_messages_format():
    g = _helpers()["_get_pair"]
    ex = {"messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]}
    assert g(ex) == ("q", "a")
    ex2 = {"conversations": [{"from": "human", "value": "q"}, {"from": "gpt", "value": "a"}]}
    assert g(ex2) == ("q", "a")


def test_unknown_columns_returns_none():
    g = _helpers()["_get_pair"]
    assert g({"foo": "x", "bar": "y"}) is None


def test_template_still_valid_python_after_fill():
    # แม่แบบต้องไม่มีตัวแทน @@..@@ ที่ไม่รู้จักค้างอยู่ในส่วนที่เพิ่ม และต้องคอมไพล์ได้เมื่อแทนค่าตัวอย่าง
    import re
    t = jobs._TRAIN_TEMPLATE
    t = re.sub(r"@@[A-Z_]+@@", "1", t)
    compile(t, "train.py", "exec")


# ---------------------------------------------------------------- การอ่าน loss จาก log (กราฟ "Loss ระหว่างเทรน")
def _job():
    return jobs.Job(id="t", base_model="b", dataset="d", output_name="o", r=8, lora_alpha=16,
                    max_seq_length=512, num_train_epochs=1, sample_size=10)


def test_loss_from_marker_line():
    j = _job()
    j.push_log('LLM_STUDIO_LOSS {"step": 10, "loss": 1.061, "val_loss": null}')
    j.push_log('LLM_STUDIO_LOSS {"step": 10, "loss": null, "val_loss": 0.9}')  # validation มาทีหลังที่ step เดิม
    assert j.loss_points == [{"step": 10, "loss": 1.061, "val_loss": 0.9}]


def test_loss_from_new_transformers_dict_line():
    # log จริงจากเครื่องผู้ใช้: ค่าเป็นสตริงในเครื่องหมายคำพูด และไม่มีเลข step ในบรรทัด
    j = _job()
    j.push_log("  22%|██        | 10/45 [01:39<04:48,  8.25s/it]")
    j.push_log("{'loss': '1.061', 'grad_norm': '0.3445', 'learning_rate': '8.78e-05', 'epoch': '0.708'}")
    j.push_log("  31%|███       | 14/45 [02:10<04:07,  7.98s/it]")
    j.push_log("{'loss': '1.065', 'grad_norm': '0.2633', 'learning_rate': '7.805e-05', 'epoch': '0.9912'}")
    assert [(p["step"], p["loss"]) for p in j.loss_points] == [(10, 1.061), (14, 1.065)]


def test_marker_disables_guessing():
    j = _job()
    j.push_log("10/45 [00:10<00:40, 8s/it]")
    j.push_log('LLM_STUDIO_LOSS {"step": 10, "loss": 1.0, "val_loss": null}')
    j.push_log("{'loss': '9.9'}")  # ต้องไม่ถูกนับซ้ำเมื่อมีบรรทัดตัวจริงแล้ว
    assert len(j.loss_points) == 1


def test_old_table_format_still_works():
    j = _job()
    j.push_log("20 1.234 1.5")
    assert j.loss_points == [{"step": 20, "loss": 1.234, "val_loss": 1.5}]


def test_script_has_loss_callback():
    assert "LLM_STUDIO_LOSS" in jobs._TRAIN_TEMPLATE and "add_callback" in jobs._TRAIN_TEMPLATE
