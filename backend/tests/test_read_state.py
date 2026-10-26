"""ทดสอบตัวอ่าน trainer_state.json"""
import json
import read_trainer_state as r


def test_read_and_verdict(tmp_path):
    hist = [{"step": s, "loss": 1.0 / s} for s in (10, 20, 30)] + [{"step": 32, "eval_loss": 0.9}, {"step": 64, "eval_loss": 0.5},
            {"step": 96, "eval_loss": 0.6}, {"step": 128, "eval_loss": 0.7}]
    p = tmp_path / "trainer_state.json"
    p.write_text(json.dumps({"log_history": hist, "max_steps": 328, "epoch": 4.0}), encoding="utf-8")
    d = r.read_history(str(p))
    assert len(d["train"]) == 3 and len(d["val"]) == 4
    assert "ท่องจำ" in r.verdict(d["val"])
    assert "ลดลงจนจบ" in r.verdict([(1, 3.0), (2, 2.0), (3, 1.0)])
