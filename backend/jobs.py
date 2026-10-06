"""In-process job manager.

Each training job runs as a child process (python train_<job_id>.py),
with stdout/stderr captured into an in-memory ring buffer that the
websocket endpoint streams to the frontend. State is kept in memory
only (a local single-user tool does not need a database) but could be
swapped for sqlite later without touching the API shape.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional

JobStatus = Literal[
    "queued", "training", "exporting", "creating_ollama", "done", "failed", "stopped"
]

_E_DRIVE_PROJECT = Path("E:/AiProject")
PROJECT_ROOT = _E_DRIVE_PROJECT if _E_DRIVE_PROJECT.exists() else Path.home() / "AiProject"
CUSTOM_DATASETS_DIR = PROJECT_ROOT / "studio_data" / "custom_datasets"
SCRIPTS_DIR = Path(__file__).parent / "script_templates"
JOBS_FILE = PROJECT_ROOT / "studio_data" / "jobs.json"

# Statuses that mean "a subprocess was actively running" — if a job is still
# in one of these when the backend starts up, the process that was running it
# is gone (this is a fresh Python process; it holds no Popen handle to
# anything from before), so pretending it's still in progress would leave
# the job looking "stuck running" forever with no way to act on it.
_INFLIGHT_STATUSES = {"queued", "training", "exporting", "creating_ollama"}


def _subprocess_env() -> dict:
    """Env for spawned train/export scripts — suppresses the handful of
    Windows dialogs (xformers DLL compat warning, HF symlink notice) that
    need a manual click when run interactively. A background subprocess
    has no window for anyone to click, so left unset these can hang the
    job forever with no visible error.
    """
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("UNSLOTH_SKIP_TORCHVISION_CHECK", "1")
    env.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    env.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
    # transformers'/trl's Trainer auto-detects any tracking integration that
    # happens to be installed (wandb above all) and will try to initialize
    # it — which means wandb's first-run interactive prompt ("Create a W&B
    # account / use existing / don't visualize"). Typed at a real terminal
    # that's a 2-second answer; here, with no stdin attached, it blocks
    # forever with zero CPU/network/memory growth — looks exactly like a
    # dead hang because it is one, just not the kind "dead" implies. Force
    # it off at the environment level as a second layer under the explicit
    # report_to="none" in the generated script, so even a training script
    # that forgets that argument can't hit this.
    env.setdefault("WANDB_DISABLED", "true")
    env.setdefault("WANDB_MODE", "disabled")
    # "Xet" is Hugging Face's newer chunked-transfer download backend (Rust
    # extension). It's implicated in real stalls we've seen in practice
    # (logs showing "Download stalled ... retrying with HF_HUB_DISABLE_XET=1",
    # then going quiet for many minutes with no further output at all) — and
    # when it does stall, its progress reporting doesn't reliably flush
    # through a non-interactive pipe the way plain-Python tqdm does, so the
    # job looks frozen with zero information instead of showing a stuck
    # percentage. Disabling it by default trades a little download speed for
    # downloads that actually show live progress and fail loudly instead of
    # hanging silently. Remove this line (or set HF_HUB_DISABLE_XET=0) if a
    # future Xet release fixes this and you want the speed back.
    env.setdefault("HF_HUB_DISABLE_XET", "1")
    # Unsloth's own "fast downloading" path (logs show "Unsloth: Fast
    # downloading is enabled") uses hf_transfer, a Rust extension that opens
    # several parallel HTTP range-requests per file instead of one plain
    # request. On a network behind deep-packet-inspection firewalls (e.g. a
    # school's FortiGate), some of those parallel connections can be dropped
    # silently — no RST, no error — leaving the extension blocked forever on
    # a read() that will never return. That hang is indistinguishable from a
    # dead process: 0% CPU, 0 disk, 0 network, and it reproduces at the same
    # early point in "Loading weights" every retry, which is the signature of
    # a stuck connection rather than a slow/loaded machine. Force the plain,
    # single-connection downloader instead — slower per file, but it actually
    # times out and retries instead of hanging silently. Remove this line (or
    # set HF_HUB_ENABLE_HF_TRANSFER=1) if this turns out not to be the cause.
    env.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
    # Unsloth ships its own flag for exactly this symptom — official docs say
    # it's "useful when model downloads get stuck at 90-95%". Unsloth's own
    # downloader isn't fully governed by the HF_HUB_* flags above (it's a
    # separate async path inside unsloth_zoo), which is why those alone
    # weren't enough in practice.
    env.setdefault("UNSLOTH_STABLE_DOWNLOADS", "1")
    # See the matching, more authoritative os.environ[...] set at the top of
    # the generated training script itself (_render_train_script) for why —
    # this copy here is just so a quick manual run of the generated script
    # with a hand-edited env still gets a sane default.
    env.setdefault("HF_ENABLE_PARALLEL_LOADING", "false")
    env.setdefault("HF_HOME", str(PROJECT_ROOT / "hf_cache"))
    env.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
    return env


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
    error: Optional[str] = None
    stop_requested: bool = False
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
        """Everything needed to show this job again and to resume/cleanup it,
        after a backend restart threw away the in-memory copy. Trims the log
        to keep the file small — recent tail is enough context, full history
        isn't needed to act on a job.
        """
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
        # best-effort parse of "Step  Training Loss" rows from trl logs
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit():
            try:
                self.loss_points.append({"step": int(parts[0]), "loss": float(parts[1])})
            except ValueError:
                pass


async def pump_process(job: "Job", proc: subprocess.Popen, loop: asyncio.AbstractEventLoop, heartbeat_s: int = 25):
    """Stream a subprocess's stdout into the job log, and if nothing comes
    through for `heartbeat_s` seconds, push a visible warning instead of
    silently looking stuck.

    Two things make the warning trustworthy instead of a guess:
    - The reader treats both '\\n' and bare '\\r' as a line boundary, not
      just '\\n'. tqdm-style progress bars (model download %, GGUF export)
      redraw in place with '\\r' and no '\\n' between updates — waiting for
      a real '\\n' can mean many minutes of genuine progress with zero
      visible output, indistinguishable from an actual hang.
    - When psutil is available, each heartbeat also checks the child
      process's OS-level I/O byte counters. If they're still climbing,
      something is really reading/writing (e.g. download chunks landing in
      the HF cache) even though no log line has arrived — so we say that,
      instead of guessing "stuck" from silence alone. Only when I/O has
      also gone flat do we call it a real hang.
    """
    import threading

    try:
        import psutil
        _ps_proc = psutil.Process(proc.pid)
    except Exception:
        _ps_proc = None

    assert proc.stdout is not None
    line_queue: asyncio.Queue = asyncio.Queue()

    def reader():
        buf = ""
        while True:
            ch = proc.stdout.read(1)
            if ch == "":
                break
            if ch in ("\n", "\r"):
                if buf:
                    loop.call_soon_threadsafe(line_queue.put_nowait, buf)
                    buf = ""
            else:
                buf += ch
        if buf:
            loop.call_soon_threadsafe(line_queue.put_nowait, buf)
        loop.call_soon_threadsafe(line_queue.put_nowait, None)

    threading.Thread(target=reader, daemon=True).start()

    def _io_bytes() -> Optional[int]:
        """Total bytes read+written by the child process so far, via the OS.
        Returns None if psutil isn't installed or the counters aren't
        available, so callers fall back to the old time-only heuristic."""
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
            line = await asyncio.wait_for(line_queue.get(), timeout=heartbeat_s)
        except asyncio.TimeoutError:
            quiet_count += 1
            idle = int(time.time() - last_output)
            io_now = _io_bytes()
            io_active = last_io is not None and io_now is not None and io_now > last_io
            last_io = io_now if io_now is not None else last_io

            if io_active:
                if quiet_count == 2 or quiet_count % 4 == 0:
                    msg = f"⏳ ยังเงียบอยู่ ({idle} วินาที) แต่ตรวจพบว่ามีการอ่าน/เขียนข้อมูลต่อเนื่อง — กำลังทำงานอยู่จริง ไม่ได้ค้าง"
                    job.push_log(msg)
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
        if line is None:
            break
        last_output = time.time()
        quiet_count = 0
        stuck_msg_count = 0
        last_io = _io_bytes()
        line = line.rstrip("\n")
        job.push_log(line)
        job.updated_at = time.time()
        await job.broadcast({"type": "log", "line": line})
        if job.loss_points:
            await job.broadcast({"type": "loss", "point": job.loss_points[-1]})


class JobManager:
    def __init__(self):
        self.jobs: dict[str, Job] = {}
        self._load()

    def _load(self):
        """Restore job records saved by a previous run of this backend.
        Without this, restarting the backend (crash, manual restart, or an
        auto-reload) wiped every job from memory — the job detail page would
        404 forever, with no way to see history, stop/resume, or delete its
        files, even though the files themselves were still on disk.
        """
        if not JOBS_FILE.exists():
            return
        try:
            records = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        for rec in records:
            try:
                job = Job(**rec)
            except TypeError:
                continue  # skip a record from an incompatible older version rather than crash startup
            if job.status in _INFLIGHT_STATUSES:
                # The subprocess that was running this is gone — this is a new
                # Python process with no handle to it. Say so honestly instead
                # of leaving the job looking like it's still progressing.
                job.status = "stopped"
                job.push_log(
                    "⚠️ backend ถูกปิด/รีสตาร์ทระหว่างงานนี้กำลังรันอยู่ — ปรับสถานะเป็น "
                    '"หยุดแล้ว" ให้ ถ้ามี checkpoint บันทึกไว้ กด "กลับมารันต่อ" ที่ด้านล่างได้'
                )
            self.jobs[job.id] = job

    def _save(self):
        try:
            JOBS_FILE.parent.mkdir(parents=True, exist_ok=True)
            JOBS_FILE.write_text(
                json.dumps([j.to_persist() for j in self.jobs.values()], ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass  # best-effort — a failed save shouldn't take down a training run

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

    async def run_training(self, job: Job, loop: asyncio.AbstractEventLoop):
        await self._execute(job, loop, resume=False)

    async def resume_training(self, job: Job, loop: asyncio.AbstractEventLoop):
        job.stop_requested = False
        job.error = None
        job.push_log('▶️ กลับมารันต่อจาก checkpoint ล่าสุด (ถ้ามี)')
        await self._execute(job, loop, resume=True)

    async def _execute(self, job: Job, loop: asyncio.AbstractEventLoop, resume: bool):
        PROJECT_ROOT.mkdir(parents=True, exist_ok=True)
        script_path = PROJECT_ROOT / f"_studio_train_{job.id}.py"
        script_path.write_text(_render_train_script(job, resume=resume), encoding="utf-8")

        job.status = "training"
        self._save()
        await job.broadcast({"type": "status", "status": job.status})

        python_exe = sys.executable
        proc = subprocess.Popen(
            [python_exe, str(script_path)],
            cwd=str(PROJECT_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,  # any stray interactive prompt gets instant EOF instead of hanging forever
            encoding="utf-8",
            text=True,
            bufsize=1,
            env=_subprocess_env(),
        )
        job.process = proc
        await pump_process(job, proc, loop)
        code = proc.wait()
        # A user-requested stop() sets stop_requested + status="stopped" before
        # terminate()ing the process, but terminate() makes it exit with a
        # non-zero code — check stop_requested first so that doesn't get
        # relabeled "failed" right after we just said "stopped".
        if job.stop_requested:
            job.status = "stopped"
        elif code == 0:
            job.status = "done"
        else:
            job.status = "failed"
            job.error = f"กระบวนการเทรนจบด้วย exit code {code} — ดู log ด้านบนสำหรับรายละเอียด"
        job.updated_at = time.time()
        self._save()
        await job.broadcast({"type": "status", "status": job.status, "error": job.error})

    def stop(self, job: Job):
        if job.process and job.process.poll() is None:
            job.stop_requested = True
            job.process.terminate()
            job.status = "stopped"
            self._save()


def _render_train_script(job: Job, resume: bool = False) -> str:
    if job.dataset.startswith("custom-"):
        jsonl_path = str(CUSTOM_DATASETS_DIR / f"{job.dataset}.jsonl").replace("\\", "\\\\")
        dataset_block = f'''import json
from datasets import Dataset
_examples = []
with open(r"{jsonl_path}", encoding="utf-8") as f:
    for _line in f:
        _line = _line.strip()
        if _line:
            _examples.append(json.loads(_line))
dataset = Dataset.from_list(_examples)
dataset = dataset.select(range(min({job.sample_size}, len(dataset))))'''
    else:
        dataset_block = f'''dataset = load_dataset("{job.dataset}", split="train")
dataset = dataset.select(range(min({job.sample_size}, len(dataset))))'''

    return f'''# Auto-generated by LLM Studio — safe to delete after the run.
import os as _os_env_guard
# transformers can load checkpoint shards across several threads at once
# (HF_ENABLE_PARALLEL_LOADING). On Windows, CUDA's context/driver init isn't
# safe to trigger from multiple threads simultaneously — if two loader
# threads both touch CUDA for the first time at once, one can block forever
# waiting on the other's driver lock. Must be set before unsloth/transformers
# are imported (not just in the parent process' environment) since Unsloth's
# own import-time patching can otherwise turn this back on.
_os_env_guard.environ["HF_ENABLE_PARALLEL_LOADING"] = "false"
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer
from transformers import TrainingArguments, BitsAndBytesConfig
from huggingface_hub import snapshot_download
import torch

max_seq_length = {job.max_seq_length}

print("LLM_STUDIO: downloading base model to local folder (one-time, cached after)...")
_local_model_dir = snapshot_download(repo_id="{job.base_model}")
print(f"LLM_STUDIO: model ready at {{_local_model_dir}}")

_bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,
    bnb_4bit_quant_type="nf4",
    llm_int8_enable_fp32_cpu_offload=True,
)
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=_local_model_dir,
    max_seq_length=max_seq_length,
    dtype=None,
    quantization_config=_bnb_config,
    device_map="auto",
)



model = FastLanguageModel.get_peft_model(
    model,
    r={job.r},
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                     "gate_proj", "up_proj", "down_proj"],
    lora_alpha={job.lora_alpha},
    lora_dropout=0,
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=3407,
)

{dataset_block}

def format_prompt(example):
    if example.get("input", "").strip():
        user_text = f"{{example['instruction']}}\\n\\n{{example['input']}}"
    else:
        user_text = example["instruction"]
    text = f"<start_of_turn>user\\n{{user_text}}<end_of_turn>\\n<start_of_turn>model\\n{{example['output']}}<end_of_turn>"
    return {{"text": text}}

dataset = dataset.map(format_prompt)

def is_not_too_long(example):
    tokens = tokenizer(example["text"], truncation=False)["input_ids"]
    return len(tokens) <= max_seq_length

dataset = dataset.filter(is_not_too_long)

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    dataset_text_field="text",
    max_seq_length=max_seq_length,
    args=TrainingArguments(
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        warmup_steps=10,
        num_train_epochs={job.num_train_epochs},
        learning_rate=2e-4,
        fp16=not torch.cuda.is_bf16_supported(),
        bf16=torch.cuda.is_bf16_supported(),
        logging_steps=10,
        optim="adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="linear",
        seed=3407,
        report_to="none",  # don't auto-init wandb/tensorboard/etc — their first-run prompts block forever with no stdin
        output_dir="outputs_{job.id}",
        save_strategy="steps",
        save_steps=20,
        save_total_limit=3,
    ),
)

import os as _os
_resume_checkpoint = None
if {"True" if resume else "False"}:
    _ckpt_dir = "outputs_{job.id}"
    if _os.path.isdir(_ckpt_dir):
        _ckpts = [d for d in _os.listdir(_ckpt_dir) if d.startswith("checkpoint-")]
        if _ckpts:
            _ckpts.sort(key=lambda d: int(d.split("-")[-1]))
            _resume_checkpoint = _os.path.join(_ckpt_dir, _ckpts[-1])
            print(f"RESUME_FROM: {{_resume_checkpoint}}")
    if _resume_checkpoint is None:
        print("RESUME_REQUESTED but no checkpoint found — starting from scratch instead")

trainer.train(resume_from_checkpoint=_resume_checkpoint)

model.save_pretrained("{job.output_name}")
tokenizer.save_pretrained("{job.output_name}")
print("JOB_DONE: saved to {job.output_name}")
'''


manager = JobManager()
