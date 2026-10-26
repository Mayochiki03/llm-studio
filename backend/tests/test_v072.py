"""ทดสอบ 0.7.2: เก็บ val_loss ที่มาคนละ step กับ train loss และตัวสรุป AI เห็น val_loss ครบ"""
from types import SimpleNamespace
import jobs, ai_digest


def _mk():
    # สร้างงานเปล่าแบบเดียวกับเทสต์เดิมใน test_trainscript
    from tests.test_trainscript import _job as mk
    return mk()


def test_val_only_point_kept():
    j = _mk()
    j.push_log('LLM_STUDIO_LOSS {"step": 30, "loss": 1.0, "val_loss": null}')
    j.push_log('LLM_STUDIO_LOSS {"step": 32, "loss": null, "val_loss": 0.9}')  # ตรวจที่ step 32 ไม่ตรง step ที่พิมพ์ loss
    j.push_log('LLM_STUDIO_LOSS {"step": 40, "loss": 0.8, "val_loss": null}')
    assert [(p["step"], p["loss"], p.get("val_loss")) for p in j.loss_points] == [(30, 1.0, None), (32, None, 0.9), (40, 0.8, None)]


def test_digest_keeps_all_val_points():
    pts = [{"step": i, "loss": 1.0 / (i + 1)} for i in range(1, 301)]
    for i in (32, 64, 96, 128):
        pts.append({"step": i, "loss": None, "val_loss": 0.5})
    job = SimpleNamespace(base_model="x", status="done", r=16, lora_alpha=16, num_train_epochs=3, learning_rate=2e-4,
                          max_seq_length=512, batch_size=1, grad_accum=8, sample_size=10, val_ratio=0.1, loss_points=pts)
    d = ai_digest.build_digest(job)
    assert len(d["train_loss"]) + len(d["val_loss"]) <= ai_digest.MAX_POINTS + 4
    assert len(d["val_loss"]) == 4 and all(p["val_loss"] is not None for p in d["val_loss"])
    assert all(p["loss"] is not None for p in d["train_loss"])
