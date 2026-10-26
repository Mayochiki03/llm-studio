"""ตัวจัดการ dataset: เวอร์ชัน, ตรวจข้อมูลระบุตัวตน (PII), สร้างจากคลังความรู้

หลักการสำคัญของโครงการนี้คือข้อมูลผู้ป่วยต้องไม่หลุดเข้าโมเดล
จึงสแกนทุกชุดเทรนก่อนใช้ และบล็อกการเทรนถ้าพบข้อมูลที่ระบุตัวตนได้ จนกว่าผู้ใช้จะแก้หรือกดยืนยันเอง
"""
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

import config
import db
import kb
import store

# ---------------------------------------------------------------- สแกน PII

_RE_CID = re.compile(r"(?<!\d)(\d[\s-]?\d{4}[\s-]?\d{5}[\s-]?\d{2}[\s-]?\d)(?!\d)")
_RE_PHONE = re.compile(r"(?<!\d)(0[689]\d[\s-]?\d{3}[\s-]?\d{4}|0\d{1,2}[\s-]?\d{3}[\s-]?\d{4})(?!\d)")
_RE_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_RE_HN = re.compile(r"\b(?:HN|AN|hn|an)\s*[:.]?\s*\d{4,}")
_RE_NAME = re.compile(r"(?:นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|คุณ)\s?[ก-๙]{2,}\s+[ก-๙]{2,}")

# ชนิดที่ถือว่า "ต้องบล็อก" (แน่ใจพอ) กับชนิดที่แค่เตือน (อาจเป็นชื่อบุคคลทั่วไป/ชื่อเจ้าหน้าที่)
BLOCKING_TYPES = {"cid", "hn", "phone", "email"}


def valid_thai_cid(digits: str) -> bool:
    """ตรวจเลขบัตรประชาชนไทย 13 หลักด้วย checksum (ลดการแจ้งผิดจากตัวเลข 13 หลักทั่วไป)"""
    if len(digits) != 13 or not digits.isdigit():
        return False
    total = sum(int(digits[i]) * (13 - i) for i in range(12))
    return (11 - total % 11) % 10 == int(digits[12])


def _mask(s: str) -> str:
    s = s.strip()
    return s[:2] + "…" + s[-2:] if len(s) > 6 else "…"


def scan_text(text: str) -> list[dict]:
    """คืนรายการที่พบในข้อความเดียว [{type, sample}] (sample ถูกปิดบังบางส่วน ไม่แสดงค่าจริงเต็ม)"""
    found: list[dict] = []
    for m in _RE_CID.finditer(text):
        digits = re.sub(r"\D", "", m.group(1))
        if valid_thai_cid(digits):
            found.append({"type": "cid", "sample": _mask(digits)})
    for m in _RE_PHONE.finditer(text):
        found.append({"type": "phone", "sample": _mask(m.group(1))})
    for m in _RE_EMAIL.finditer(text):
        found.append({"type": "email", "sample": _mask(m.group(0))})
    for m in _RE_HN.finditer(text):
        found.append({"type": "hn", "sample": _mask(m.group(0))})
    for m in _RE_NAME.finditer(text):
        found.append({"type": "name", "sample": _mask(m.group(0))})
    return found


def scan_examples(examples: list[dict], max_report: int = 50) -> dict:
    """สแกนทุกตัวอย่าง คืน {total, flagged, blocking, by_type, items:[{index, field, type, sample}]}"""
    by_type: dict[str, int] = {}
    items: list[dict] = []
    flagged = 0
    blocking = 0
    for i, ex in enumerate(examples):
        hit_here = False
        block_here = False
        for field_name in ("instruction", "input", "output"):
            for f in scan_text(str(ex.get(field_name, ""))):
                by_type[f["type"]] = by_type.get(f["type"], 0) + 1
                hit_here = True
                block_here = block_here or f["type"] in BLOCKING_TYPES
                if len(items) < max_report:
                    items.append({"index": i, "field": field_name, **f})
        flagged += int(hit_here)
        blocking += int(block_here)
    return {"total": len(examples), "flagged": flagged, "blocking": blocking, "by_type": by_type, "items": items}


# ---------------------------------------------------------------- อ่านเขียนไฟล์ชุดข้อมูล

def _write_jsonl(path: Path, examples: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")


def read_jsonl(path: Path, limit: int | None = None) -> list[dict]:
    out: list[dict] = []
    if not Path(path).exists():
        return out
    with Path(path).open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
            if limit and len(out) >= limit:
                break
    return out


def normalize_example(ex: dict) -> dict | None:
    """ให้ทุกตัวอย่างมีรูป {instruction, input, output} ที่ตัวเทรนต้องการ; ตัวอย่างที่ไม่ครบคืน None"""
    ins = str(ex.get("instruction", "")).strip()
    out = str(ex.get("output", "")).strip()
    if not ins or not out:
        return None
    return {"instruction": ins, "input": str(ex.get("input", "") or "").strip(), "output": out}


def _version_path(dataset_id: str, version: int) -> Path:
    return config.CUSTOM_DATASETS_DIR / "versions" / dataset_id / f"v{version}.jsonl"


def _latest_version(dataset_id: str) -> int:
    r = db.query_one("SELECT MAX(version) AS v FROM dataset_versions WHERE dataset_id=?", (dataset_id,))
    return (r or {}).get("v") or 0


def save_version(dataset_id: str, examples: list[dict], note: str = "", source: str = "manual") -> dict:
    """บันทึกเวอร์ชันใหม่ของ dataset: เขียนไฟล์เวอร์ชัน + อัปเดตไฟล์ปัจจุบัน (<id>.jsonl) + บันทึกผลสแกน PII"""
    clean = [e for e in (normalize_example(x) for x in examples) if e]
    if not clean:
        raise ValueError("ไม่มีตัวอย่างที่ใช้ได้ (ทุกตัวอย่างต้องมี instruction และ output)")
    version = _latest_version(dataset_id) + 1
    vpath = _version_path(dataset_id, version)
    _write_jsonl(vpath, clean)
    _write_jsonl(config.CUSTOM_DATASETS_DIR / f"{dataset_id}.jsonl", clean)
    pii = scan_examples(clean)
    vid = uuid.uuid4().hex[:10]
    db.execute(
        "INSERT INTO dataset_versions (id,dataset_id,version,file,count,note,source,pii_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (vid, dataset_id, version, str(vpath), len(clean), note, source,
         json.dumps({k: pii[k] for k in ("flagged", "blocking", "by_type")}, ensure_ascii=False), time.time()),
    )
    db.audit("dataset.version", dataset_id, f"v{version} {len(clean)} ตัวอย่าง ({source})")
    return {"dataset_id": dataset_id, "version": version, "count": len(clean), "pii": pii}


def create_dataset(label: str, notes: str, examples: list[dict], source: str = "manual") -> dict:
    """สร้างชุดข้อมูลใหม่ (ลงทะเบียนในแคตตาล็อก + เวอร์ชัน 1)"""
    dataset_id = f"custom-{uuid.uuid4().hex[:8]}"
    res = save_version(dataset_id, examples, note="เวอร์ชันแรก", source=source)
    entry = {"id": dataset_id, "label": label, "sizeHint": f"{res['count']} ตัวอย่าง",
             "notes": notes or "ชุดข้อมูลที่เพิ่มเอง", "kind": "custom",
             "file": str(config.CUSTOM_DATASETS_DIR / f"{dataset_id}.jsonl")}
    store.register_custom_entry(entry)
    return {**res, "entry": entry}


def append_examples(dataset_id: str, examples: list[dict], note: str = "", source: str = "append") -> dict:
    """เพิ่มตัวอย่างต่อท้ายของเวอร์ชันล่าสุด แล้วบันทึกเป็นเวอร์ชันใหม่ (ของเดิมยังย้อนกลับได้)"""
    current = read_jsonl(config.CUSTOM_DATASETS_DIR / f"{dataset_id}.jsonl")
    res = save_version(dataset_id, current + examples, note=note or f"เพิ่ม {len(examples)} ตัวอย่าง", source=source)
    store.update_custom_size(dataset_id, res["count"])
    return res


def list_versions(dataset_id: str) -> list[dict]:
    rows = db.query("SELECT * FROM dataset_versions WHERE dataset_id=? ORDER BY version DESC", (dataset_id,))
    for r in rows:
        try:
            r["pii"] = json.loads(r.pop("pii_json") or "{}")
        except ValueError:
            r["pii"] = {}
    return rows


def restore_version(dataset_id: str, version: int) -> dict:
    """ย้อนกลับ: นำเนื้อหาเวอร์ชันเก่ามาบันทึกเป็นเวอร์ชันใหม่ (ไม่ลบประวัติ)"""
    p = _version_path(dataset_id, version)
    if not p.exists():
        raise ValueError("ไม่พบไฟล์เวอร์ชันนี้")
    res = save_version(dataset_id, read_jsonl(p), note=f"ย้อนจาก v{version}", source="restore")
    store.update_custom_size(dataset_id, res["count"])
    return res


def preview(dataset_id: str, version: int | None = None, limit: int = 20) -> dict:
    p = _version_path(dataset_id, version) if version else config.CUSTOM_DATASETS_DIR / f"{dataset_id}.jsonl"
    rows = read_jsonl(p)
    return {"total": len(rows), "examples": rows[:limit]}


def scan_dataset(dataset_id: str) -> dict:
    return scan_examples(read_jsonl(config.CUSTOM_DATASETS_DIR / f"{dataset_id}.jsonl"))


def current_version(dataset_id: str) -> int:
    return _latest_version(dataset_id)


def from_kb(label: str, notes: str = "") -> dict:
    """สร้างชุดเทรนใหม่จากเอกสารคู่ถาม-ตอบ (kind=qa) ที่เปิดใช้ในคลังความรู้"""
    pairs = kb.qa_pairs()
    if not pairs:
        raise ValueError("ในคลังความรู้ยังไม่มีเอกสารแบบคู่ถาม-ตอบที่เปิดใช้งาน")
    return create_dataset(label, notes or "สร้างจากคู่ถาม-ตอบในคลังความรู้", pairs, source="kb")


def from_facts(label: str, notes: str, facts: list[dict], augment: bool = True,
               include_defaults: bool = True, add_eval: bool = True) -> dict:
    """สร้างชุดข้อมูลเทรน (และโจทย์ทดสอบที่ใช้คำสำคัญเดียวกัน) จากตารางข้อเท็จจริง (ดู faqbuilder.py)"""
    import faqbuilder
    r = faqbuilder.build(facts, augment=augment, include_defaults=include_defaults)
    if not r["train"]:
        raise ValueError("ไม่มีตัวอย่างให้สร้าง: แต่ละแถวต้องมีคำตอบและคำถามอย่างน้อย 1 ข้อ")
    res = create_dataset(label, notes or "สร้างจากตารางข้อเท็จจริง", r["train"], source="facts")
    added = 0
    if add_eval:
        have = {p["text"] for p in store.list_prompts()}
        for p in r["eval"]:
            if p["text"] not in have:
                store.add_prompt(p["text"], p["category"], p["expect"], p["must_not"], p["red_flag"], p["pinned"])
                added += 1
    return {"dataset_id": res["dataset_id"], "examples": res["count"], "pii": res.get("pii"),
            "eval_added": added, "stats": r["stats"]}
