"""ตัวจัดการงานเทรน (job manager) + ตัวสร้างสคริปต์เทรน

แต่ละงานเทรนรันเป็นโปรเซสลูก (python _studio_train_<id>.py) โดย log ถูกส่งเข้าหน้าเว็บผ่าน websocket
เวอร์ชันนี้เพิ่ม:
  - คิวงาน: GPU ใบเดียวรันได้ทีละงาน งานที่เหลือรอในคิว (ลำดับ/ยกเลิก/ดันขึ้นก่อนได้)
  - ตั้งเวลาเริ่ม (start_at) เช่น เริ่มตอนกลางคืน
  - ปลดโมเดลที่ Ollama โหลดค้างใน VRAM ก่อนเทรน และโหลดกลับเมื่อจบ/ล้มเหลว/เกินเวลา
  - ตรวจฮาร์ดแวร์แล้วเลือก batch/grad-accum อัตโนมัติ (hardware.recommend_training)
  - สคริปต์เทรนใช้ chat template ของโมเดลฐานจริง (แทนรูปแบบ Gemma ที่ hardcode)
  - ปรับ performance: TF32, กรองความยาวแบบ batched, save_steps ตามจำนวน step, packing (เลือกเปิดเอง)
สถานะงานเก็บใน jobs.json (โหลดกลับเมื่อ backend รีสตาร์ท) — งานที่ยังรอคิว/ตั้งเวลาไว้จะกลับเข้าคิวเอง
"""
from __future__ import annotations

import asyncio
import codecs
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional

import config
import hardware
import ollama_client

JobStatus = Literal[
    "scheduled", "queued", "training", "exporting", "creating_ollama", "done", "failed", "stopped"
]

# ชื่อเหล่านี้ main.py / store.py นำเข้าไปใช้ — คงไว้ให้เหมือนเดิม
PROJECT_ROOT = config.PROJECT_ROOT
CUSTOM_DATASETS_DIR = config.CUSTOM_DATASETS_DIR
JOBS_FILE = config.JOBS_FILE

# สถานะที่แปลว่า "มีโปรเซสกำลังรันอยู่" — ถ้าเจอตอน backend เพิ่งเริ่ม โปรเซสนั้นหายไปแล้ว
_INFLIGHT_STATUSES = {"training", "exporting", "creating_ollama"}
# สถานะที่ "รอเริ่ม" — ยังไม่ได้รันอะไร จึงกลับเข้าคิวได้เมื่อ backend เริ่มใหม่
_WAITING_STATUSES = {"queued", "scheduled"}


def _hf_transfer_available() -> bool:
    """hf_transfer ติดตั้งอยู่ไหม (ใช้ตัดสินว่าโหมดดาวน์โหลดเร็วเปิดได้จริงหรือเปล่า)"""
    try:
        import hf_transfer  # type: ignore  # noqa: F401
        return True
    except Exception:
        return False


def _subprocess_env() -> dict:
    """ตัวแปรสภาพแวดล้อมสำหรับสคริปต์เทรน/ส่งออกที่เปิดเป็นโปรเซสลูก

    โหมด "safe" (ค่าเริ่มต้น): ปิดตัวดาวน์โหลดแบบขนาน/xet ที่เคยทำให้ค้างบนเครือข่ายที่มี firewall
    โหมด "fast" (ตั้งในหน้า Settings): เปิดตัวดาวน์โหลดเร็ว เหมาะกับเซิร์ฟเวอร์ที่เน็ตตรง
    ไม่มี stdin ให้ใคร กดตอบ จึงต้องปิดทุกอย่างที่อาจเด้งถามผู้ใช้ (wandb ฯลฯ)
    """
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("UNSLOTH_SKIP_TORCHVISION_CHECK", "1")
    env.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    env.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
    # wandb จะถามบัญชีตอนรันครั้งแรก — ไม่มี stdin จึงค้างถาวร ปิดตั้งแต่ระดับ environment
    env.setdefault("WANDB_DISABLED", "true")
    env.setdefault("WANDB_MODE", "disabled")
    env.setdefault("HF_HOME", str(PROJECT_ROOT / "hf_cache"))
    env.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
    if not config.IS_WINDOWS:
        # จัดสรร VRAM แบบขยายได้ ลดปัญหา fragmentation ตอนเทรนโมเดลใหญ่ (ใช้ได้เฉพาะ Linux)
        env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    fast = config.get_settings().get("network_mode") == "fast"
    if fast:
        env["HF_HUB_DISABLE_XET"] = "0"
        env["UNSLOTH_STABLE_DOWNLOADS"] = "0"
        # hf_transfer ต้องติดตั้งก่อนจึงเปิดได้ ถ้าไม่มีแล้วเปิด จะ error ทันทีตอนดาวน์โหลด
        env["HF_HUB_ENABLE_HF_TRANSFER"] = "1" if _hf_transfer_available() else "0"
    else:
        env.setdefault("HF_HUB_DISABLE_XET", "1")
        env.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
        env.setdefault("UNSLOTH_STABLE_DOWNLOADS", "1")
    env.setdefault("HF_ENABLE_PARALLEL_LOADING", "false")
    return env


_PARAMS_RE = re.compile(r"(\d+(?:\.\d+)?)b(?![a-z])")


def guess_params_b(model_id: str, default: float = 3.0) -> float:
    """เดาขนาดโมเดล (พันล้านพารามิเตอร์) จากชื่อ เช่น ...-14b-instruct → 14"""
    m = _PARAMS_RE.search((model_id or "").lower())
    return float(m.group(1)) if m else default


@dataclass
class Job:
    id: str
    base_model: str
    dataset: str
    output_name: str
    r: int
    lora_alpha: int
    max_seq_length: int
    num_train_epochs: float
    sample_size: int
    status: JobStatus = "queued"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    log_lines: list[str] = field(default_factory=list)
    loss_points: list[dict] = field(default_factory=list)
    last_step: int = 0               # step ล่าสุดที่เห็นจากแถบ tqdm (ใช้จับคู่กับ loss แบบ dict)
    have_loss_marker: bool = False   # เคยเห็นบรรทัด LLM_STUDIO_LOSS แล้ว → เลิกใช้วิธีเดา
    error: Optional[str] = None
    stop_requested: bool = False
    # ---- ฟิลด์ที่เพิ่มภายหลัง: ต้องมีค่าเริ่มต้นเสมอ เพื่อให้ jobs.json เก่าโหลดได้ ----
    start_at: Optional[float] = None        # ตั้งเวลาเริ่ม (epoch วินาที) None = เริ่มทันทีที่ถึงคิว
    queue_order: float = 0.0                # ค่าน้อยกว่า = ได้ก่อน (ดันขึ้นก่อนในคิว)
    preset: str = ""                        # ชื่อพรีเซ็ตที่ใช้ (เพื่อแสดงผล)
    params_b: float = 0.0                   # ขนาดโมเดล (B) 0 = เดาจากชื่อ
    batch_size: int = 0                     # 0 = ให้ระบบเลือกตามเครื่อง
    grad_accum: int = 0                     # 0 = ให้ระบบเลือกตามเครื่อง
    learning_rate: float = 2e-4
    packing: bool = False                   # รวมตัวอย่างสั้นๆ เข้าด้วยกัน (เร็วขึ้น แต่ต้องทดสอบกับโมเดลก่อน)
    val_ratio: float = 0.0                  # สัดส่วนที่แบ่งไว้ตรวจ (validation) 0 = ไม่แบ่ง
    system_prompt: str = ""                 # system prompt ที่ใส่ในข้อมูลเทรน (ว่าง = ใช้ค่าจากตั้งค่า)
    template_mode: str = "auto"             # auto = chat template ของโมเดล, legacy = รูปแบบ Gemma แบบเดิม
    dataset_version: int = 0                # เวอร์ชันของ dataset ที่ใช้ (0 = ไม่มี/จาก Hugging Face)
    pii_ack: bool = False                   # ผู้ใช้กดยืนยันแล้วว่ารับทราบผลตรวจข้อมูลระบุตัวตน
    resume_requested: bool = False          # คิวนี้ให้รันต่อจาก checkpoint
    train_config: dict = field(default_factory=dict)   # ค่าจริงที่ใช้เทรน (batch, accum ฯลฯ) บันทึกไว้ดูย้อนหลัง
    unloaded_models: list = field(default_factory=list)  # โมเดล Ollama ที่ปลดออกก่อนเทรน (ไว้โหลดกลับ)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    max_minutes: int = 0                    # เวลาเทรนสูงสุด (นาที) 0 = ใช้ค่าจากตั้งค่า
    timed_out: bool = False
    process: Optional[subprocess.Popen] = field(default=None, repr=False)
    subscribers: list[asyncio.Queue] = field(default_factory=list, repr=False)

    def to_public(self) -> dict:
        d = {
            k: v
            for k, v in self.__dict__.items()
            if k not in ("process", "subscribers", "log_lines")
        }
        d["log_tail"] = self.log_lines[-50:]
        return d

    def to_persist(self) -> dict:
        """ทุกอย่างที่ต้องใช้แสดงงานนี้อีกครั้งหลัง backend รีสตาร์ท (ตัด log ให้สั้นเพื่อไม่ให้ไฟล์โต)"""
        d = {k: v for k, v in self.__dict__.items() if k not in ("process", "subscribers")}
        d["log_lines"] = self.log_lines[-200:]
        return d

    async def broadcast(self, payload: dict):
        for q in list(self.subscribers):
            await q.put(payload)

    def push_log(self, line: str):
        self.log_lines.append(line)
        if len(self.log_lines) > 4000:
            self.log_lines = self.log_lines[-2000:]
        self._parse_loss(line)

    def _add_point(self, step: int, loss: float | None, val: float | None):
        """เพิ่มจุดบนกราฟ ถ้าเป็น step เดิมให้รวมเข้าจุดเดิม (train loss กับ validation loss มาเป็นคนละบรรทัด)"""
        if self.loss_points and self.loss_points[-1]["step"] == step:
            pt = self.loss_points[-1]
            if loss is not None:
                pt["loss"] = loss
            if val is not None:
                pt["val_loss"] = val
            return
        if loss is None:
            return  # มีแต่ validation ที่ยังไม่มีจุดรองรับ ข้าม
        pt = {"step": step, "loss": loss}
        if val is not None:
            pt["val_loss"] = val
        self.loss_points.append(pt)

    def _parse_loss(self, line: str):
        """แกะ loss จาก log แบบพยายามดีที่สุด รองรับ 3 รูปแบบ:
        1) บรรทัด LLM_STUDIO_LOSS {json} ที่สคริปต์เทรนพิมพ์เอง (แม่นที่สุด ใช้กับงานใหม่)
        2) ตารางเก่า "Step  Training Loss [Validation Loss]" ของ trl
        3) บรรทัด dict แบบ {'loss': '1.06', ...} ของ transformers รุ่นใหม่ (ไม่มีเลข step ในบรรทัด ใช้เลขจากแถบ tqdm ล่าสุด)"""
        if line.startswith("LLM_STUDIO_LOSS "):
            try:
                o = json.loads(line[len("LLM_STUDIO_LOSS "):])
                self._add_point(int(o["step"]),
                                float(o["loss"]) if o.get("loss") is not None else None,
                                float(o["val_loss"]) if o.get("val_loss") is not None else None)
            except (ValueError, KeyError, TypeError):
                pass
            self.have_loss_marker = True
            return
        m = _TQDM_STEP.search(line)
        if m:
            self.last_step = int(m.group(1))
        parts = line.split()
        if len(parts) in (2, 3) and parts[0].isdigit():
            try:
                point = {"step": int(parts[0]), "loss": float(parts[1])}
            except ValueError:
                return
            if len(parts) == 3:
                try:
                    point["val_loss"] = float(parts[2])
                except ValueError:
                    pass
            self.loss_points.append(point)
            return
        if not self.have_loss_marker and self.last_step:
            d = _DICT_LOSS.search(line)
            if d:
                self._add_point(self.last_step, float(d.group(1)), None)


_TQDM_STEP = re.compile(r"(\d+)/\d+ \[")
_DICT_LOSS = re.compile(r"['\"]loss['\"]\s*:\s*['\"]?([0-9]+(?:\.[0-9]+)?(?:e-?[0-9]+)?)")

_SPLIT_LINES = re.compile(r"[\r\n]+")


async def pump_process(job: "Job", proc: subprocess.Popen, loop: asyncio.AbstractEventLoop, heartbeat_s: int = 25):
    """ส่ง stdout ของโปรเซสลูกเข้า log ของงาน และถ้าเงียบเกิน heartbeat_s วินาทีจะแจ้งเตือนที่มองเห็นได้

    สองอย่างที่ทำให้คำเตือนเชื่อถือได้ (ไม่ใช่เดา):
    - ตัวอ่านถือทั้ง '\\n' และ '\\r' เป็นจุดขึ้นบรรทัด เพราะแถบ progress ของ tqdm (ดาวน์โหลดโมเดล,
      แปลง GGUF) วาดทับบรรทัดเดิมด้วย '\\r' ไม่มี '\\n' — ถ้ารอ '\\n' อย่างเดียวจะดูเหมือนค้างทั้งที่ยังทำงานอยู่
    - ถ้ามี psutil จะเช็กตัวนับ I/O ของโปรเซสลูกทุกครั้งที่เงียบ ถ้าไบต์ยังเพิ่มแปลว่ายังอ่าน/เขียนจริง
      (เช่น กำลังดาวน์โหลด) จึงบอกว่า "ไม่ได้ค้าง" และเรียกว่าค้างจริงเมื่อ I/O นิ่งด้วยเท่านั้น

    ปรับปรุง performance: อ่านทีละก้อน (read1) แล้วแยกบรรทัดเอง แทนการอ่านทีละตัวอักษร
    ลดการสลับเธรด/เรียก call_soon_threadsafe หลายหมื่นครั้งต่อ log หนึ่งชุด
    """
    try:
        import psutil
        _ps_proc = psutil.Process(proc.pid)
    except Exception:
        _ps_proc = None

    assert proc.stdout is not None
    line_queue: asyncio.Queue = asyncio.Queue()

    def reader():
        raw = getattr(proc.stdout, "buffer", None)
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        tail = ""
        try:
            while True:
                if raw is not None:
                    chunk = raw.read1(8192)  # type: ignore[attr-defined]
                    if not chunk:
                        break
                    text = decoder.decode(chunk)
                else:  # สำรอง: stdout ไม่มี buffer (กรณีทดสอบ) อ่านทีละตัวอักษรแบบเดิม
                    ch = proc.stdout.read(1)
                    if ch == "":
                        break
                    text = ch
                if not text:
                    continue
                pieces = _SPLIT_LINES.split(tail + text)
                tail = pieces.pop()  # ชิ้นสุดท้ายอาจยังไม่จบบรรทัด เก็บไว้ต่อรอบหน้า
                lines = [p for p in pieces if p]
                if lines:
                    loop.call_soon_threadsafe(line_queue.put_nowait, lines)
            tail += decoder.decode(b"", final=True)
        finally:
            if tail.strip():
                loop.call_soon_threadsafe(line_queue.put_nowait, [tail])
            loop.call_soon_threadsafe(line_queue.put_nowait, None)

    threading.Thread(target=reader, daemon=True).start()

    def _io_bytes() -> Optional[int]:
        """ไบต์ที่โปรเซสลูกอ่าน+เขียนสะสม (จากระบบปฏิบัติการ) None = ไม่มี psutil จึงใช้เวลาอย่างเดียวตัดสิน"""
        if _ps_proc is None:
            return None
        try:
            io = _ps_proc.io_counters()
            return io.read_bytes + io.write_bytes
        except Exception:
            return None

    last_output = time.time()
    quiet_count = 0
    stuck_msg_count = 0
    last_io = _io_bytes()
    while True:
        try:
            batch = await asyncio.wait_for(line_queue.get(), timeout=heartbeat_s)
        except asyncio.TimeoutError:
            quiet_count += 1
            idle = int(time.time() - last_output)
            io_now = _io_bytes()
            io_active = last_io is not None and io_now is not None and io_now > last_io
            last_io = io_now if io_now is not None else last_io

            if io_active:
                if quiet_count == 2 or quiet_count % 4 == 0:
                    job.push_log(f"⏳ ยังเงียบอยู่ ({idle} วินาที) แต่ตรวจพบว่ามีการอ่าน/เขียนข้อมูลต่อเนื่อง — กำลังทำงานอยู่จริง ไม่ได้ค้าง")
                    await job.broadcast({"type": "log", "line": job.log_lines[-1]})
                continue

            if quiet_count <= 2:
                msg = (
                    f"⚠️ ยังไม่มี log ใหม่มา {idle} วินาที — ปกติถ้ากำลังโหลด/ดาวน์โหลดโมเดลไฟล์ใหญ่ "
                    "จะเงียบแบบนี้ได้ชั่วคราว แต่ถ้าเงียบยาวต่อเนื่องหลายนาทีแบบไม่ขยับเลย มักเป็นเพราะดาวน์โหลด "
                    "จาก Hugging Face ค้าง (เช่น ปัญหาเครือข่าย/ไฟร์วอลล์) ไม่ใช่กำลังทำงานอยู่เงียบๆ"
                )
            elif idle >= 600:
                stuck_msg_count += 1
                if stuck_msg_count != 1 and stuck_msg_count % 5 != 0:
                    continue
                msg = (
                    f"⏳ เงียบมา {idle // 60} นาทีแล้ว และไม่พบการอ่าน/เขียนข้อมูลเลย — ค้างจริงแล้ว แนะนำกด \"หยุดงาน\" "
                    'แล้วกด "กลับมารันต่อ" ใหม่ (รันต่อจาก checkpoint ล่าสุดได้ ไม่เริ่มใหม่จากศูนย์)'
                )
            else:
                msg = f"⏳ ยังเงียบอยู่ ({idle} วินาที)..."
            job.push_log(msg)
            await job.broadcast({"type": "log", "line": job.log_lines[-1]})
            continue
        if batch is None:
            break
        last_output = time.time()
        quiet_count = 0
        stuck_msg_count = 0
        last_io = _io_bytes()
        for line in batch:
            n_loss = len(job.loss_points)
            prev_last = dict(job.loss_points[-1]) if job.loss_points else None
            job.push_log(line)
            await job.broadcast({"type": "log", "line": line})
            # ส่งจุด loss เฉพาะเมื่อบรรทัดนี้ทำให้มีจุดใหม่ หรือจุดล่าสุดเปลี่ยน (เช่น เติม validation loss)
            if job.loss_points and (len(job.loss_points) > n_loss or job.loss_points[-1] != prev_last):
                await job.broadcast({"type": "loss", "point": job.loss_points[-1]})
        job.updated_at = time.time()


class JobManager:
    def __init__(self):
        self.jobs: dict[str, Job] = {}
        self.current: Optional[Job] = None       # งานที่กำลังใช้ GPU อยู่ (มีได้ทีละงาน)
        self._task: Optional[asyncio.Task] = None
        self._wake: Optional[asyncio.Event] = None
        self._load()

    # ---------------------------------------------------------------- บันทึก/โหลด
    def _load(self):
        """โหลดงานที่ backend รอบก่อนบันทึกไว้ — ไม่งั้นรีสตาร์ทแล้วงานหายหมด เปิดหน้ารายละเอียดไม่ได้"""
        if not JOBS_FILE.exists():
            return
        try:
            records = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        for rec in records:
            # งานที่บันทึกก่อนมีตัวเลือกรูปแบบ prompt ถูกเทรนด้วยรูปแบบ Gemma เดิมทั้งหมด จึงต้องใช้ template เดิมตอนสร้างเข้า Ollama
            if isinstance(rec, dict) and "template_mode" not in rec:
                rec["template_mode"] = "legacy"
            try:
                job = Job(**rec)
            except TypeError:
                continue  # ข้ามเรคอร์ดจากเวอร์ชันเก่าที่เข้ากันไม่ได้ แทนที่จะให้ startup พัง
            if job.status in _INFLIGHT_STATUSES:
                # โปรเซสที่รันงานนี้หายไปแล้ว บอกตามจริงแทนที่จะปล่อยให้ดูเหมือนยังรันอยู่
                job.status = "stopped"
                job.push_log(
                    "⚠️ backend ถูกปิด/รีสตาร์ทระหว่างงานนี้กำลังรันอยู่ — ปรับสถานะเป็น "
                    '"หยุดแล้ว" ให้ ถ้ามี checkpoint บันทึกไว้ กด "กลับมารันต่อ" ที่ด้านล่างได้'
                )
            self.jobs[job.id] = job

    def _save(self):
        try:
            JOBS_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = JOBS_FILE.with_suffix(".tmp")
            tmp.write_text(
                json.dumps([j.to_persist() for j in self.jobs.values()], ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            tmp.replace(JOBS_FILE)
        except OSError:
            pass  # บันทึกไม่ได้ต้องไม่ทำให้งานเทรนที่กำลังรันล้ม

    # ---------------------------------------------------------------- เรียกดู
    def list(self) -> list[dict]:
        return [j.to_public() for j in sorted(self.jobs.values(), key=lambda j: -j.created_at)]

    def get(self, job_id: str) -> Optional[Job]:
        return self.jobs.get(job_id)

    def create(self, **kwargs) -> Job:
        job_id = uuid.uuid4().hex[:10]
        job = Job(id=job_id, **kwargs)
        self.jobs[job_id] = job
        self._save()
        return job

    def waiting(self) -> list[Job]:
        """งานที่รออยู่ เรียงตามลำดับที่จะได้รัน"""
        w = [j for j in self.jobs.values() if j.status in _WAITING_STATUSES]
        return sorted(w, key=lambda j: (j.queue_order, j.created_at))

    def queue_info(self) -> dict:
        return {
            "running": self.current.to_public() if self.current else None,
            "waiting": [
                {"id": j.id, "output_name": j.output_name, "base_model": j.base_model, "status": j.status,
                 "start_at": j.start_at, "position": i + 1}
                for i, j in enumerate(self.waiting())
            ],
        }

    # ---------------------------------------------------------------- คิว
    def start(self):
        """เริ่มตัวทำงานคิว (เรียกซ้ำได้ ไม่เริ่มซ้อน) ต้องเรียกตอนมี event loop รันอยู่"""
        if self._task is not None and not self._task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._wake = asyncio.Event()
        self._task = loop.create_task(self._worker())
        self._wake.set()  # ให้ตรวจงานที่ค้างอยู่ในคิวทันที

    def stop_worker(self):
        if self._task is not None:
            self._task.cancel()
            self._task = None

    def _kick(self):
        if self._wake is not None:
            self._wake.set()

    def enqueue(self, job: Job, resume: bool = False):
        """ใส่งานเข้าคิว: ถ้าตั้งเวลาไว้ในอนาคตจะเป็น scheduled ไม่งั้น queued"""
        job.resume_requested = resume
        job.stop_requested = False
        job.error = None
        job.timed_out = False
        now = time.time()
        job.status = "scheduled" if (job.start_at and job.start_at > now) else "queued"
        job.updated_at = now
        self._save()
        self.start()
        self._kick()

    def prioritize(self, job: Job):
        """ดันงานนี้ขึ้นหน้าสุดของคิว"""
        others = [j.queue_order for j in self.waiting() if j.id != job.id]
        job.queue_order = (min(others) - 1) if others else 0.0
        self._save()

    def _next_ready(self) -> Optional[Job]:
        now = time.time()
        for j in self.waiting():
            if j.start_at and j.start_at > now:
                continue
            return j
        return None

    async def _worker(self):
        """วนตรวจคิว: ถ้า GPU ว่างและมีงานถึงเวลา ก็หยิบมารัน (ทีละงาน)"""
        assert self._wake is not None
        while True:
            try:
                if self.current is None:
                    job = self._next_ready()
                    if job is not None:
                        self.current = job
                        try:
                            await self._execute(job, asyncio.get_running_loop(), job.resume_requested)
                        except Exception as e:  # noqa: BLE001 — งานเดียวพังต้องไม่ล้มตัวทำงานคิวทั้งตัว
                            job.status = "failed"
                            job.error = f"ระบบเริ่มงานไม่สำเร็จ: {e}"
                            job.push_log(f"❌ {job.error}")
                            self._save()
                            await job.broadcast({"type": "status", "status": job.status, "error": job.error})
                        finally:
                            self.current = None
                        continue
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=10)
                except asyncio.TimeoutError:
                    pass
                self._wake.clear()
            except asyncio.CancelledError:
                raise

    async def run_training(self, job: Job, loop: asyncio.AbstractEventLoop | None = None):
        """คงชื่อเดิมไว้ให้โค้ดเก่าเรียกได้ — ตอนนี้แค่ใส่เข้าคิว"""
        self.enqueue(job, resume=False)

    async def resume_training(self, job: Job, loop: asyncio.AbstractEventLoop | None = None):
        job.push_log("▶️ กลับมารันต่อจาก checkpoint ล่าสุด (ถ้ามี) — เข้าคิวแล้ว")
        self.enqueue(job, resume=True)

    # ---------------------------------------------------------------- รันงาน
    async def _free_vram(self, job: Job):
        """ปลดโมเดลที่ Ollama ถืออยู่ใน VRAM เพื่อให้การเทรนได้ VRAM เต็มที่"""
        if not config.get_settings().get("unload_before_train", True):
            return
        running = await ollama_client.running_models()
        names = [m.get("name") or m.get("model") for m in running if (m.get("name") or m.get("model"))]
        if not names:
            return
        job.unloaded_models = names
        for n in names:
            ok = await ollama_client.unload(n)
            job.push_log(f"🧹 ปลดโมเดล {n} ออกจาก VRAM ก่อนเทรน" if ok else f"⚠️ ปลดโมเดล {n} ไม่สำเร็จ")
        await asyncio.sleep(2)  # รอให้คืน VRAM จริง

    async def _restore_models(self, job: Job):
        """โหลดโมเดลที่ปลดไว้กลับเข้า VRAM (ทำเบื้องหลัง ไม่ให้งานค้างรอ)"""
        if not job.unloaded_models or not config.get_settings().get("reload_after_train", True):
            return
        names, job.unloaded_models = list(job.unloaded_models), []

        async def _go():
            for n in names:
                await ollama_client.warm(n)

        asyncio.get_running_loop().create_task(_go())
        job.push_log("♻️ สั่งโหลดโมเดลบริการกลับเข้า VRAM: " + ", ".join(names))

    def resolve_config(self, job: Job) -> dict:
        """ตัดสินค่าที่ใช้เทรนจริง: ค่าที่ผู้ใช้กำหนดมาก่อน ถ้าเป็น 0 ใช้ค่าที่แนะนำจากฮาร์ดแวร์"""
        hw = hardware.probe_all()
        gpu = hw.get("gpu")
        vram = gpu["vram_total_gb"] if gpu else 0.0
        params_b = job.params_b or guess_params_b(job.base_model)
        rec = hardware.recommend_training(
            vram, params_b, job.max_seq_length, is_linux=not config.IS_WINDOWS,
            cpu_threads=hw.get("cpu", {}).get("threads", 4))
        fast = config.get_settings().get("network_mode") == "fast"
        return {
            "batch": job.batch_size or rec["batch_size"],
            "accum": job.grad_accum or rec["grad_accum"],
            "workers": rec["workers"],
            "packing": bool(job.packing),
            "vram_gb": vram,
            "params_b": params_b,
            "recommended": f'{rec["batch_size"]}x{rec["grad_accum"]}',
            "parallel_loading": (not config.IS_WINDOWS) and fast,
            "gpu_name": gpu["name"] if gpu else "",
        }

    async def _watchdog(self, job: Job, proc: subprocess.Popen, minutes: int):
        """ตัวเฝ้าเวลา: เทรนเกินกำหนดให้หยุด (กันงานค้างยึด GPU ทั้งคืน)"""
        deadline = time.time() + minutes * 60
        while proc.poll() is None:
            await asyncio.sleep(15)
            if time.time() > deadline and proc.poll() is None:
                job.timed_out = True
                job.push_log(f"⏱️ เทรนเกินเวลาที่กำหนด ({minutes} นาที) — สั่งหยุดงานนี้")
                proc.terminate()
                return

    async def _execute(self, job: Job, loop: asyncio.AbstractEventLoop, resume: bool):
        PROJECT_ROOT.mkdir(parents=True, exist_ok=True)
        job.started_at = time.time()
        job.finished_at = None
        job.status = "training"
        job.resume_requested = False
        self._save()
        await job.broadcast({"type": "status", "status": job.status})

        job.train_config = self.resolve_config(job)
        tc = job.train_config
        job.push_log(
            f"⚙️ ค่าที่ใช้เทรน: batch {tc['batch']} x accum {tc['accum']} "
            f"(ระบบแนะนำ {tc['recommended']}) | GPU: {tc['gpu_name'] or 'ไม่พบ'} {tc['vram_gb']} GB"
        )
        await self._free_vram(job)

        script_path = PROJECT_ROOT / f"_studio_train_{job.id}.py"
        script_path.write_text(_render_train_script(job, resume=resume), encoding="utf-8")

        proc = subprocess.Popen(
            [sys.executable, str(script_path)],
            cwd=str(PROJECT_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,  # prompt หลงเหลือจะได้ EOF ทันที ไม่ค้างถาวร
            encoding="utf-8",
            errors="replace",
            text=True,
            bufsize=1,
            env=_subprocess_env(),
        )
        job.process = proc
        minutes = job.max_minutes or int(config.get_settings().get("max_train_minutes", 0) or 0)
        dog = loop.create_task(self._watchdog(job, proc, minutes)) if minutes > 0 else None
        try:
            await pump_process(job, proc, loop)
            code = proc.wait()
        finally:
            if dog:
                dog.cancel()
        # stop() ตั้ง stop_requested + status="stopped" ก่อน terminate() ซึ่งทำให้โปรเซสจบด้วยโค้ดไม่เป็นศูนย์
        # จึงต้องเช็ก stop_requested ก่อน ไม่งั้นจะถูกเปลี่ยนเป็น "ล้มเหลว" ทันทีหลังบอกว่า "หยุดแล้ว"
        if job.stop_requested:
            job.status = "stopped"
        elif job.timed_out:
            job.status = "failed"
            job.error = f"เทรนเกินเวลาที่กำหนด ({minutes} นาที) ระบบหยุดให้ รันต่อจาก checkpoint ได้"
        elif code == 0:
            job.status = "done"
        else:
            job.status = "failed"
            job.error = f"กระบวนการเทรนจบด้วย exit code {code} — ดู log ด้านบนสำหรับรายละเอียด"
        job.finished_at = time.time()
        job.updated_at = job.finished_at
        job.process = None
        await self._restore_models(job)
        self._save()
        await job.broadcast({"type": "status", "status": job.status, "error": job.error})

    def stop(self, job: Job):
        """หยุดงาน: ถ้ากำลังรันให้ปิดโปรเซส ถ้ายังรอคิว/ตั้งเวลาไว้ก็ยกเลิกออกจากคิว"""
        if job.process and job.process.poll() is None:
            job.stop_requested = True
            job.process.terminate()
            job.status = "stopped"
            self._save()
        elif job.status in _WAITING_STATUSES:
            job.status = "stopped"
            job.stop_requested = True
            job.push_log("🛑 ยกเลิกงานนี้ออกจากคิวแล้ว")
            self._save()


# ====================================================================== สคริปต์เทรน
# แม่แบบสคริปต์ใช้ตัวแทน @@...@@ แล้วแทนที่ด้วย str.replace (ไม่ใช้ f-string เพื่อไม่ต้อง escape วงเล็บปีกกาทั้งสคริปต์)
_TRAIN_TEMPLATE = r'''# Auto-generated by LLM Studio — safe to delete after the run.
import os as _os_env_guard
# transformers โหลด shard ของโมเดลหลายเธรดพร้อมกันได้ (HF_ENABLE_PARALLEL_LOADING) แต่บน Windows การเริ่ม CUDA
# จากหลายเธรดพร้อมกันอาจค้างถาวร จึงปิดไว้ (เปิดเฉพาะ Linux + โหมดดาวน์โหลดเร็ว) ต้องตั้งก่อน import unsloth/transformers
_os_env_guard.environ["HF_ENABLE_PARALLEL_LOADING"] = "@@PARALLEL@@"
import inspect, json, math
from unsloth import FastLanguageModel
from datasets import load_dataset, Dataset
from trl import SFTTrainer
from transformers import TrainingArguments
from huggingface_hub import snapshot_download
import torch

CFG = json.loads(@@CFG_STR@@)
max_seq_length = CFG["max_seq"]

# เร่งความเร็วบนการ์ดตระกูล Ampere ขึ้นไป (RTX 30/40) โดยคุณภาพแทบไม่ต่าง
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True
if torch.cuda.is_available():
    _p = torch.cuda.get_device_properties(0)
    print(f"LLM_STUDIO: GPU {_p.name} | VRAM {_p.total_memory / 1e9:.1f} GB | batch {CFG['batch']} x accum {CFG['accum']}")

print("LLM_STUDIO: downloading base model to local folder (one-time, cached after)...")
_local_model_dir = snapshot_download(repo_id=CFG["base_model"])
print(f"LLM_STUDIO: model ready at {_local_model_dir}")

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=_local_model_dir,
    max_seq_length=max_seq_length,
    dtype=None,
    load_in_4bit=True,
)

model = FastLanguageModel.get_peft_model(
    model,
    r=CFG["r"],
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                     "gate_proj", "up_proj", "down_proj"],
    lora_alpha=CFG["alpha"],
    lora_dropout=0,
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=3407,
)

# ---------------------------------------------------------------- ข้อมูล
if CFG["dataset_kind"] == "custom":
    _examples = []
    with open(CFG["dataset_ref"], encoding="utf-8") as f:
        for _line in f:
            _line = _line.strip()
            if _line:
                _examples.append(json.loads(_line))
    dataset = Dataset.from_list(_examples)
else:
    dataset = load_dataset(CFG["dataset_ref"], split="train")
dataset = dataset.select(range(min(CFG["sample_size"], len(dataset))))

_use_template = CFG["template_mode"] == "auto" and bool(getattr(tokenizer, "chat_template", None))
print("LLM_STUDIO: prompt format = " + ("tokenizer chat template" if _use_template else "legacy (Gemma-style)"))

# ชุดข้อมูลบน Hugging Face ตั้งชื่อคอลัมน์ไม่เหมือนกัน (Instruction/instruction/prompt/question ... ) จึงเดาชื่อให้ก่อน
# และถ้าเดาไม่ได้จะหยุดพร้อมบอกชื่อคอลัมน์ที่มี แทนที่จะล้มด้วย KeyError ที่ไม่บอกอะไร
def _norm_key(k):
    return "".join(ch for ch in str(k).lower() if ch.isalnum())

_INSTR_KEYS = ["instruction", "instructions", "prompt", "question", "query", "task", "problem", "user", "human"]
_INPUT_KEYS = ["input", "inputs", "context", "additionalinput"]
_OUT_KEYS = ["output", "outputs", "response", "answer", "completion", "target", "reply", "assistant", "gpt"]

def _pick(example, names):
    low = {_norm_key(k): k for k in example.keys()}
    for n in names:
        if n in low:
            v = example[low[n]]
            if v is None:
                return ""
            return v if isinstance(v, str) else str(v)
    return None

def _from_messages(example):
    # รูปแบบแชท: messages / conversations เป็นลิสต์ของ {role, content} หรือ {from, value}
    for key in ("messages", "conversations", "conversation"):
        msgs = example.get(key)
        if isinstance(msgs, list) and msgs:
            u = a = None
            for m in msgs:
                if not isinstance(m, dict):
                    continue
                role = str(m.get("role", m.get("from", ""))).lower()
                text = m.get("content", m.get("value", ""))
                if u is None and role in ("user", "human"):
                    u = text
                elif a is None and role in ("assistant", "gpt", "model", "bot"):
                    a = text
            if u is not None and a is not None:
                return u, a
    return None

def _get_pair(example):
    ins = _pick(example, _INSTR_KEYS)
    out = _pick(example, _OUT_KEYS)
    if ins is not None and out is not None:
        inp = _pick(example, _INPUT_KEYS) or ""
        return (f"{ins}\n\n{inp}" if inp.strip() else ins), out
    pair = _from_messages(example)
    if pair:
        return pair
    return None

print("LLM_STUDIO: dataset columns = " + ", ".join(dataset.column_names))
if _get_pair(dataset[0]) is None:
    raise SystemExit("ไม่รู้จักรูปแบบคอลัมน์ของชุดข้อมูลนี้ (มีคอลัมน์: " + ", ".join(dataset.column_names) + ") "
                     "ต้องมีคู่ instruction/output (หรือ prompt/response, question/answer, messages) ลองชุดข้อมูลอื่น หรือสร้างชุดข้อมูลของตัวเองในหน้า 'ชุดข้อมูลเทรน'")

def format_prompt(example):
    user_text, answer = _get_pair(example) or ("", "")
    if _use_template:
        msgs = []
        if CFG["system_prompt"]:
            msgs.append({"role": "system", "content": CFG["system_prompt"]})
        msgs.append({"role": "user", "content": user_text})
        msgs.append({"role": "assistant", "content": answer})
        text = tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
    else:
        text = f"<start_of_turn>user\n{user_text}<end_of_turn>\n<start_of_turn>model\n{answer}<end_of_turn>"
    return {"text": text}

dataset = dataset.map(format_prompt)

# กรองตัวอย่างที่ยาวเกิน แบบ batched (เร็วกว่าไล่ทีละตัวอย่างหลายเท่า)
def _add_len(batch):
    ids = tokenizer(batch["text"], truncation=False, add_special_tokens=False)["input_ids"]
    return {"_len": [len(x) for x in ids]}

_before = len(dataset)
dataset = dataset.map(_add_len, batched=True, batch_size=1000)
dataset = dataset.filter(lambda ex: ex["_len"] <= max_seq_length)
dataset = dataset.remove_columns(["_len"])
print(f"LLM_STUDIO: examples kept {len(dataset)} / {_before} (dropped {_before - len(dataset)} too long)")
if len(dataset) == 0:
    raise SystemExit("ไม่เหลือตัวอย่างหลังกรองความยาว ลองเพิ่มความยาวข้อความสูงสุด")

eval_dataset = None
if CFG["val_ratio"] > 0 and len(dataset) >= 20:
    _split = dataset.train_test_split(test_size=CFG["val_ratio"], seed=3407)
    dataset, eval_dataset = _split["train"], _split["test"]
    print(f"LLM_STUDIO: train {len(dataset)} / validation {len(eval_dataset)}")

# ---------------------------------------------------------------- ตั้งค่าเทรน
_steps_per_epoch = max(1, math.ceil(len(dataset) / (CFG["batch"] * CFG["accum"])))
_total_steps = max(1, math.ceil(_steps_per_epoch * CFG["epochs"]))
_save_steps = max(20, min(500, _total_steps // 10))     # บันทึก checkpoint ราว 10 ครั้งต่อการเทรน ไม่ถี่เกินจนเสียเวลาเขียนดิสก์
_log_steps = max(1, min(10, _total_steps // 20))
print(f"LLM_STUDIO: total steps ~{_total_steps}, save every {_save_steps}")

_ta_params = inspect.signature(TrainingArguments.__init__).parameters
_ta_kwargs = dict(
    per_device_train_batch_size=CFG["batch"],
    gradient_accumulation_steps=CFG["accum"],
    warmup_steps=min(10, max(1, _total_steps // 10)),
    num_train_epochs=CFG["epochs"],
    learning_rate=CFG["lr"],
    fp16=not torch.cuda.is_bf16_supported(),
    bf16=torch.cuda.is_bf16_supported(),
    logging_steps=_log_steps,
    optim="adamw_8bit",
    weight_decay=0.01,
    lr_scheduler_type="linear",
    seed=3407,
    report_to="none",  # ไม่ให้ wandb/tensorboard เด้งถามตอนรันครั้งแรก — ไม่มี stdin จึงค้างถาวร
    output_dir="outputs_" + CFG["job_id"],
    save_strategy="steps",
    save_steps=_save_steps,
    save_total_limit=3,
)
if CFG["workers"] > 0 and "dataloader_num_workers" in _ta_params:
    _ta_kwargs["dataloader_num_workers"] = CFG["workers"]
if eval_dataset is not None:
    _key = "eval_strategy" if "eval_strategy" in _ta_params else "evaluation_strategy"  # trl/transformers แต่ละเวอร์ชันชื่อไม่เหมือนกัน
    _ta_kwargs[_key] = "steps"
    _ta_kwargs["eval_steps"] = _save_steps
    _ta_kwargs["per_device_eval_batch_size"] = CFG["batch"]

_sft_params = inspect.signature(SFTTrainer.__init__).parameters
_sft_kwargs = dict(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    dataset_text_field="text",
    max_seq_length=max_seq_length,
    args=TrainingArguments(**_ta_kwargs),
)
if eval_dataset is not None:
    _sft_kwargs["eval_dataset"] = eval_dataset
if CFG["packing"]:
    if "packing" in _sft_params:
        _sft_kwargs["packing"] = True
        print("LLM_STUDIO: packing enabled")
    else:
        print("LLM_STUDIO: packing not supported by this trl version — skipped")

trainer = SFTTrainer(**_sft_kwargs)

# ส่ง loss ออกเป็นบรรทัดที่อ่านง่ายและคงที่ทุกเวอร์ชันของ transformers (ตัวเลขใน log ปกติเปลี่ยนรูปแบบไปเรื่อยๆ จนกราฟอ่านไม่ได้)
from transformers import TrainerCallback
class _LossPrinter(TrainerCallback):
    def on_log(self, args, state, control, logs=None, **kwargs):
        if not logs:
            return
        _l, _v = logs.get("loss"), logs.get("eval_loss")
        if _l is None and _v is None:
            return
        try:
            print("LLM_STUDIO_LOSS " + json.dumps({"step": int(state.global_step),
                  "loss": float(_l) if _l is not None else None,
                  "val_loss": float(_v) if _v is not None else None}), flush=True)
        except (TypeError, ValueError):
            pass
trainer.add_callback(_LossPrinter())

import os as _os
_resume_checkpoint = None
if CFG["resume"]:
    _ckpt_dir = "outputs_" + CFG["job_id"]
    if _os.path.isdir(_ckpt_dir):
        _ckpts = [d for d in _os.listdir(_ckpt_dir) if d.startswith("checkpoint-")]
        if _ckpts:
            _ckpts.sort(key=lambda d: int(d.split("-")[-1]))
            _resume_checkpoint = _os.path.join(_ckpt_dir, _ckpts[-1])
            print(f"RESUME_FROM: {_resume_checkpoint}")
    if _resume_checkpoint is None:
        print("RESUME_REQUESTED but no checkpoint found — starting from scratch instead")

trainer.train(resume_from_checkpoint=_resume_checkpoint)

model.save_pretrained(CFG["output_name"])
tokenizer.save_pretrained(CFG["output_name"])
print("JOB_DONE: saved to " + CFG["output_name"])
'''


def dataset_file_for(job: Job) -> Path:
    """ไฟล์ชุดข้อมูล custom ที่งานนี้ใช้: ถ้าระบุเวอร์ชันและมีไฟล์เวอร์ชันนั้นอยู่ ใช้ตัวนั้น (กันข้อมูลเปลี่ยนระหว่างรอคิว)"""
    if job.dataset_version:
        p = CUSTOM_DATASETS_DIR / "versions" / job.dataset / f"v{job.dataset_version}.jsonl"
        if p.exists():
            return p
    return CUSTOM_DATASETS_DIR / f"{job.dataset}.jsonl"


def _render_train_script(job: Job, resume: bool = False) -> str:
    """สร้างสคริปต์เทรนจากแม่แบบ + ค่าของงานนี้"""
    tc = job.train_config or {}
    is_custom = job.dataset.startswith("custom-")
    system_prompt = job.system_prompt or config.get_settings().get("default_system_prompt", "")
    cfg = {
        "job_id": job.id,
        "base_model": job.base_model,
        "output_name": job.output_name,
        "max_seq": job.max_seq_length,
        "epochs": job.num_train_epochs,
        "sample_size": job.sample_size,
        "r": job.r,
        "alpha": job.lora_alpha,
        "lr": job.learning_rate,
        "batch": int(tc.get("batch") or job.batch_size or 1),
        "accum": int(tc.get("accum") or job.grad_accum or 8),
        "workers": int(tc.get("workers") or 0),
        "packing": bool(job.packing),
        "val_ratio": float(job.val_ratio or 0),
        "system_prompt": system_prompt,
        "template_mode": job.template_mode,
        "dataset_kind": "custom" if is_custom else "hf",
        "dataset_ref": str(dataset_file_for(job)) if is_custom else job.dataset,
        "resume": bool(resume),
    }
    parallel = "true" if tc.get("parallel_loading") else "false"
    return (_TRAIN_TEMPLATE
            .replace("@@PARALLEL@@", parallel)
            .replace("@@CFG_STR@@", json.dumps(json.dumps(cfg, ensure_ascii=True))))


manager = JobManager()
