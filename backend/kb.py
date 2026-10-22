"""คลังความรู้ (Knowledge Base): เก็บเอกสาร ตัดเป็นชิ้น (chunk) สร้างเวกเตอร์ และค้นหา

ออกแบบให้ "เพิ่มความรู้ง่าย": วางข้อความ / คู่ถาม-ตอบ / อัปโหลดไฟล์ แล้วระบบจัดการที่เหลือ
- เก็บใน SQLite (db.py) ย้ายไป pgvector ทีหลังได้
- สร้างเวกเตอร์ด้วย Ollama (ollama_client.embed) ถ้าใช้ไม่ได้ ยังค้นด้วยคำสำคัญได้ (ไม่ล่ม)
- ไม่พึ่ง numpy: เก็บเวกเตอร์เป็น float32 ด้วย array และคำนวณ cosine ด้วย Python ล้วน
  (คลังหลักหมื่นชิ้นยังเร็วพอ ถ้าติดตั้ง numpy จะใช้ให้อัตโนมัติ)
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import time
import uuid
from array import array

import config
import db
import ollama_client

try:
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover
    np = None


# ---------------------------------------------------------------- ตัดแบ่งข้อความ

_SPLIT_RE = re.compile(r"(?<=[\.\!\?。])\s+|\n+|\s{2,}")


def chunk_text(text: str, size: int = 600, overlap: int = 80) -> list[str]:
    """ตัดข้อความเป็นชิ้นขนาดไม่เกิน size ตัวอักษร โดยพยายามตัดที่ขอบย่อหน้า/ประโยค/ช่องว่าง
    (ภาษาไทยไม่มีจุดจบประโยคชัดเจน จึงใช้ช่องว่างและบรรทัดใหม่เป็นหลัก)
    และเว้นส่วนซ้อน (overlap) ต่อชิ้น เพื่อไม่ให้ความหมายขาดตรงรอยต่อ"""
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        return []
    size = max(100, size)
    overlap = max(0, min(overlap, size // 2))

    # 1) แตกเป็นหน่วยเล็ก ไม่ให้หน่วยใดยาวเกิน size
    units: list[str] = []
    for part in _SPLIT_RE.split(text):
        part = part.strip()
        if not part:
            continue
        while len(part) > size:
            cut = part.rfind(" ", int(size * 0.6), size)
            cut = cut if cut > 0 else size
            units.append(part[:cut].strip())
            part = part[cut:].strip()
        if part:
            units.append(part)

    # 2) รวมหน่วยเล็กเข้าด้วยกันจนเต็มขนาด
    chunks: list[str] = []
    cur = ""
    for u in units:
        if not cur:
            cur = u
        elif len(cur) + 1 + len(u) <= size:
            cur = f"{cur} {u}"
        else:
            chunks.append(cur)
            cur = u
    if cur:
        chunks.append(cur)

    # 3) ใส่ส่วนซ้อนจากท้ายชิ้นก่อนหน้า
    if overlap and len(chunks) > 1:
        out = [chunks[0]]
        for i in range(1, len(chunks)):
            tail = chunks[i - 1][-overlap:]
            sp = tail.find(" ")
            tail = tail[sp + 1:] if 0 <= sp < len(tail) - 1 else tail
            out.append(f"{tail} {chunks[i]}".strip() if len(tail) + len(chunks[i]) <= size * 1.3 else chunks[i])
        return out
    return chunks


# ---------------------------------------------------------------- เวกเตอร์

def _pack(vec: list[float]) -> bytes:
    return array("f", vec).tobytes()


def _unpack(blob: bytes) -> array:
    a = array("f")
    a.frombytes(blob)
    return a


def _norm(a) -> float:
    return math.sqrt(sum(x * x for x in a)) or 1.0


def cosine(a, b) -> float:
    return sum(x * y for x, y in zip(a, b)) / (_norm(a) * _norm(b))


# ---------------------------------------------------------------- คำสำคัญ (สำรอง/ผสม)

def _ngrams(s: str, n: int = 3) -> set[str]:
    s = re.sub(r"\s+", "", (s or "").lower())
    if len(s) < n:
        return {s} if s else set()
    return {s[i:i + n] for i in range(len(s) - n + 1)}


def keyword_score(query: str, text: str) -> float:
    """สัดส่วนของ trigram ในคำถามที่พบในข้อความ (ใช้ได้กับภาษาไทยที่ไม่มีเว้นวรรคระหว่างคำ)"""
    q = _ngrams(query)
    if not q:
        return 0.0
    return len(q & _ngrams(text)) / len(q)


# ---------------------------------------------------------------- จัดการเอกสาร

def _now() -> float:
    return time.time()


def _hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def qa_text(question: str, answer: str) -> str:
    return f"ถาม: {question.strip()}\nตอบ: {answer.strip()}"


def preview_chunks(text: str, size: int | None = None, overlap: int | None = None) -> list[str]:
    s = config.get_settings()
    return chunk_text(text, size or s["kb_chunk_size"], overlap if overlap is not None else s["kb_chunk_overlap"])


def _write_chunks(conn, doc_id: str, text: str) -> int:
    conn.execute("DELETE FROM kb_chunks WHERE doc_id=?", (doc_id,))
    chunks = preview_chunks(text)
    for i, c in enumerate(chunks):
        conn.execute("INSERT INTO kb_chunks (doc_id, idx, text) VALUES (?,?,?)", (doc_id, i, c))
    return len(chunks)


def add_doc(title: str, text: str, kind: str = "text", category: str = "", tags: list[str] | None = None,
            source_name: str = "", actor: str = "admin") -> dict:
    """เพิ่มเอกสารใหม่ + ตัดเป็นชิ้น (ยังไม่สร้างเวกเตอร์ — เรียก embed_pending ต่อ)"""
    text = (text or "").strip()
    if not text:
        raise ValueError("เนื้อหาว่าง")
    doc_id = uuid.uuid4().hex[:10]
    now = _now()
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO kb_docs (id,title,kind,category,tags,enabled,version,source_name,raw_text,content_hash,created_at,updated_at)"
            " VALUES (?,?,?,?,?,1,1,?,?,?,?,?)",
            (doc_id, title.strip() or "(ไม่มีชื่อ)", kind, category.strip(), json.dumps(tags or [], ensure_ascii=False),
             source_name, text, _hash(text), now, now),
        )
        _write_chunks(conn, doc_id, text)
        conn.execute("INSERT INTO kb_history (doc_id,version,ts,action,title,raw_text,actor) VALUES (?,?,?,?,?,?,?)",
                     (doc_id, 1, now, "create", title, text, actor))
    db.audit("kb.create", doc_id, title, actor)
    return get_doc(doc_id)  # type: ignore[return-value]


def update_doc(doc_id: str, title: str | None = None, text: str | None = None, category: str | None = None,
               tags: list[str] | None = None, enabled: bool | None = None, actor: str = "admin") -> dict | None:
    cur = db.query_one("SELECT * FROM kb_docs WHERE id=?", (doc_id,))
    if not cur:
        return None
    new_title = title.strip() if title is not None else cur["title"]
    new_text = text.strip() if text is not None else cur["raw_text"]
    if not new_text:
        raise ValueError("เนื้อหาว่าง")
    text_changed = _hash(new_text) != cur["content_hash"]
    version = cur["version"] + (1 if (text_changed or new_title != cur["title"]) else 0)
    now = _now()
    with db.tx() as conn:
        conn.execute(
            "UPDATE kb_docs SET title=?, raw_text=?, content_hash=?, category=?, tags=?, enabled=?, version=?, updated_at=? WHERE id=?",
            (new_title, new_text, _hash(new_text),
             category.strip() if category is not None else cur["category"],
             json.dumps(tags, ensure_ascii=False) if tags is not None else cur["tags"],
             int(enabled) if enabled is not None else cur["enabled"], version, now, doc_id),
        )
        if text_changed:
            _write_chunks(conn, doc_id, new_text)
        if version != cur["version"]:
            conn.execute("INSERT INTO kb_history (doc_id,version,ts,action,title,raw_text,actor) VALUES (?,?,?,?,?,?,?)",
                         (doc_id, version, now, "update", new_title, new_text, actor))
        elif enabled is not None and int(enabled) != cur["enabled"]:
            conn.execute("INSERT INTO kb_history (doc_id,version,ts,action,title,raw_text,actor) VALUES (?,?,?,?,?,?,?)",
                         (doc_id, version, now, "toggle", new_title, "เปิดใช้" if enabled else "ปิดใช้", actor))
    db.audit("kb.update", doc_id, new_title, actor)
    return get_doc(doc_id)


def delete_doc(doc_id: str, actor: str = "admin") -> bool:
    cur = db.query_one("SELECT * FROM kb_docs WHERE id=?", (doc_id,))
    if not cur:
        return False
    with db.tx() as conn:
        conn.execute("INSERT INTO kb_history (doc_id,version,ts,action,title,raw_text,actor) VALUES (?,?,?,?,?,?,?)",
                     (doc_id, cur["version"], _now(), "delete", cur["title"], cur["raw_text"], actor))
        conn.execute("DELETE FROM kb_docs WHERE id=?", (doc_id,))
    db.audit("kb.delete", doc_id, cur["title"], actor)
    return True


def _decorate(row: dict) -> dict:
    row = dict(row)
    row["tags"] = json.loads(row.get("tags") or "[]")
    row["enabled"] = bool(row["enabled"])
    return row


def get_doc(doc_id: str) -> dict | None:
    row = db.query_one("SELECT * FROM kb_docs WHERE id=?", (doc_id,))
    if not row:
        return None
    d = _decorate(row)
    counts = db.query_one(
        "SELECT COUNT(*) AS n, SUM(CASE WHEN emb IS NOT NULL THEN 1 ELSE 0 END) AS e FROM kb_chunks WHERE doc_id=?", (doc_id,))
    d["chunks"] = counts["n"] or 0
    d["embedded"] = counts["e"] or 0
    return d


def list_docs(q: str = "", category: str = "", tag: str = "", kind: str = "", include_text: bool = False) -> list[dict]:
    rows = db.query(
        "SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.doc_id=d.id) AS chunks,"
        " (SELECT COUNT(*) FROM kb_chunks c WHERE c.doc_id=d.id AND c.emb IS NOT NULL) AS embedded"
        " FROM kb_docs d ORDER BY d.updated_at DESC")
    out = []
    ql = q.strip().lower()
    for r in rows:
        d = _decorate(r)
        if category and d["category"] != category:
            continue
        if kind and d["kind"] != kind:
            continue
        if tag and tag not in d["tags"]:
            continue
        if ql and ql not in d["title"].lower() and ql not in d["raw_text"].lower():
            continue
        if not include_text:
            d["preview"] = d["raw_text"][:160]
            del d["raw_text"]
        out.append(d)
    return out


def history(doc_id: str | None = None, limit: int = 100) -> list[dict]:
    if doc_id:
        return db.query("SELECT id,doc_id,version,ts,action,title,actor FROM kb_history WHERE doc_id=? ORDER BY id DESC LIMIT ?",
                        (doc_id, limit))
    return db.query("SELECT id,doc_id,version,ts,action,title,actor FROM kb_history ORDER BY id DESC LIMIT ?", (limit,))


def restore_version(doc_id: str, history_id: int, actor: str = "admin") -> dict | None:
    """ย้อนเนื้อหาเอกสารกลับไปเป็นตามบันทึกประวัติรายการนั้น"""
    h = db.query_one("SELECT * FROM kb_history WHERE id=? AND doc_id=?", (history_id, doc_id))
    if not h or h["action"] not in ("create", "update"):
        return None
    return update_doc(doc_id, title=h["title"], text=h["raw_text"], actor=actor)


def categories() -> list[str]:
    return [r["category"] for r in db.query("SELECT DISTINCT category FROM kb_docs WHERE category<>'' ORDER BY category")]


def stats() -> dict:
    r = db.query_one("SELECT COUNT(*) AS docs, SUM(enabled) AS enabled FROM kb_docs") or {}
    c = db.query_one("SELECT COUNT(*) AS chunks, SUM(CASE WHEN emb IS NOT NULL THEN 1 ELSE 0 END) AS embedded FROM kb_chunks") or {}
    return {"docs": r.get("docs") or 0, "enabled": r.get("enabled") or 0,
            "chunks": c.get("chunks") or 0, "embedded": c.get("embedded") or 0,
            "embed_model": config.get_settings()["embed_model"]}


# ---------------------------------------------------------------- สร้างเวกเตอร์

async def embed_pending(batch_size: int = 32) -> dict:
    """สร้างเวกเตอร์ให้ทุกชิ้นที่ยังไม่มี (หรือสร้างด้วยโมเดลอื่นมาก่อน)
    ประหยัดงาน: ชิ้นที่ข้อความเหมือนกับที่เคยทำแล้ว (โมเดลเดียวกัน) จะคัดลอกเวกเตอร์เดิม ไม่เรียก Ollama ซ้ำ"""
    model = config.get_settings()["embed_model"]
    rows = db.query("SELECT id, text FROM kb_chunks WHERE emb IS NULL OR emb_model IS NOT ?", (model,))
    done = reused = 0
    error = ""
    todo: list[dict] = []
    for r in rows:
        same = db.query_one(
            "SELECT emb, emb_dim FROM kb_chunks WHERE text=? AND emb_model=? AND emb IS NOT NULL LIMIT 1", (r["text"], model))
        if same:
            db.execute("UPDATE kb_chunks SET emb=?, emb_model=?, emb_dim=? WHERE id=?",
                       (same["emb"], model, same["emb_dim"], r["id"]))
            reused += 1
        else:
            todo.append(r)
    for i in range(0, len(todo), batch_size):
        part = todo[i:i + batch_size]
        vecs, err = await ollama_client.embed([p["text"] for p in part], model)
        if vecs is None:
            error = err
            break
        with db.tx() as conn:
            for p, v in zip(part, vecs):
                conn.execute("UPDATE kb_chunks SET emb=?, emb_model=?, emb_dim=? WHERE id=?",
                             (_pack(v), model, len(v), p["id"]))
        done += len(part)
    left = db.query_one("SELECT COUNT(*) AS n FROM kb_chunks WHERE emb IS NULL")["n"]  # type: ignore[index]
    return {"embedded_now": done, "reused": reused, "remaining": left, "error": error, "model": model}


# ---------------------------------------------------------------- ค้นหา

async def search(query: str, top_k: int | None = None, min_score: float | None = None,
                 category: str = "", only_enabled: bool = True) -> dict:
    """ค้นหาชิ้นความรู้ที่เกี่ยวข้อง: ผสมเวกเตอร์ (ถ้ามี) กับคำสำคัญ
    คืน {mode: 'hybrid'|'keyword', hits:[{doc_id,title,text,score,...}], note}"""
    s = config.get_settings()
    top_k = top_k or s["kb_top_k"]
    min_score = s["kb_min_score"] if min_score is None else min_score
    sql = ("SELECT c.id, c.doc_id, c.idx, c.text, c.emb, c.emb_model, d.title, d.category FROM kb_chunks c"
           " JOIN kb_docs d ON d.id=c.doc_id")
    where = []
    params: list = []
    if only_enabled:
        where.append("d.enabled=1")
    if category:
        where.append("d.category=?")
        params.append(category)
    if where:
        sql += " WHERE " + " AND ".join(where)
    rows = db.query(sql, params)
    if not rows or not (query or "").strip():
        return {"mode": "none", "hits": [], "note": "คลังความรู้ว่างหรือคำถามว่าง"}

    qvec = None
    note = ""
    if any(r["emb"] is not None for r in rows):
        vecs, err = await ollama_client.embed([query], s["embed_model"])
        if vecs:
            qvec = vecs[0]
        else:
            note = f"ค้นด้วยคำสำคัญแทน ({err})"
    else:
        note = "ยังไม่มีเวกเตอร์ในคลัง ค้นด้วยคำสำคัญ (กดปุ่ม 'สร้างเวกเตอร์' ในหน้าคลังความรู้)"

    scored: list[tuple[float, dict]] = []
    if qvec is not None and np is not None:
        qa = np.asarray(qvec, dtype="float32")
        qn = float(np.linalg.norm(qa)) or 1.0
    for r in rows:
        kw = keyword_score(query, r["text"])
        vs = None
        if qvec is not None and r["emb"] is not None and r["emb_model"] == s["embed_model"]:
            if np is not None:
                v = np.frombuffer(r["emb"], dtype="float32")
                vs = float(np.dot(qa, v) / (qn * (float(np.linalg.norm(v)) or 1.0)))
            else:
                vs = cosine(qvec, _unpack(r["emb"]))
        score = (0.75 * max(vs, 0.0) + 0.25 * kw) if vs is not None else kw
        scored.append((score, {**r, "vec_score": vs, "kw_score": kw}))
    scored.sort(key=lambda t: -t[0])
    hits = []
    for score, r in scored[: top_k * 3]:
        if score < min_score:
            continue
        hits.append({"doc_id": r["doc_id"], "title": r["title"], "category": r["category"], "chunk_idx": r["idx"],
                     "text": r["text"], "score": round(score, 3),
                     "vec_score": None if r["vec_score"] is None else round(r["vec_score"], 3),
                     "kw_score": round(r["kw_score"], 3)})
        if len(hits) >= top_k:
            break
    return {"mode": "hybrid" if qvec is not None else "keyword", "hits": hits, "note": note}


def build_context(hits: list[dict]) -> str:
    """รวมชิ้นความรู้ที่ค้นได้เป็นข้อความอ้างอิงใส่ใน system prompt"""
    if not hits:
        return ""
    parts = [f"[{i}] ({h['title']}) {h['text']}" for i, h in enumerate(hits, 1)]
    return ("ใช้ข้อมูลอ้างอิงต่อไปนี้ตอบคำถาม ถ้าข้อมูลไม่พอให้บอกตามตรงว่าไม่ทราบ ห้ามแต่งข้อมูลเอง\n\n"
            + "\n\n".join(parts))


# ---------------------------------------------------------------- นำเข้า / ส่งออก

def export_jsonl() -> str:
    """ส่งออกทุกเอกสาร (รวมที่ปิดใช้) เป็น JSONL หนึ่งเอกสารต่อบรรทัด — ไม่รวมเวกเตอร์ (สร้างใหม่ได้)"""
    lines = []
    for d in list_docs(include_text=True):
        lines.append(json.dumps({k: d[k] for k in ("id", "title", "kind", "category", "tags", "enabled", "raw_text", "source_name")},
                                ensure_ascii=False))
    return "\n".join(lines) + ("\n" if lines else "")


def import_jsonl(text: str, actor: str = "admin") -> dict:
    added = skipped = 0
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
            body = o.get("raw_text") or o.get("text")
            if not body:
                skipped += 1
                continue
            d = add_doc(o.get("title", "(นำเข้า)"), body, o.get("kind", "text"), o.get("category", ""),
                        o.get("tags", []), o.get("source_name", ""), actor)
            if o.get("enabled") is False:
                update_doc(d["id"], enabled=False, actor=actor)
            added += 1
        except (ValueError, TypeError):
            skipped += 1
    return {"added": added, "skipped": skipped}


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp874", "tis-620"):  # ไฟล์ไทยจาก Excel/Windows มักเป็น cp874
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def extract_from_file(filename: str, data: bytes) -> list[dict]:
    """แปลงไฟล์ที่อัปโหลดเป็นรายการเอกสาร [{title, text, kind}]
    - txt/md: 1 ไฟล์ = 1 เอกสาร
    - csv: ถ้ามีคอลัมน์ question/answer (หรือ ถาม/ตอบ) = 1 แถวเป็นคู่ถาม-ตอบ, ไม่งั้นรวมทุกแถวเป็นเอกสารเดียว
    - pdf / docx: ต้องมี pypdf / python-docx (ติดตั้งเพิ่ม) ถ้าไม่มีจะแจ้งวิธีติดตั้ง"""
    name = filename.rsplit("/", 1)[-1]
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    stem = name.rsplit(".", 1)[0]
    if ext in ("txt", "md", "markdown", ""):
        return [{"title": stem, "text": _decode(data), "kind": "file"}]
    if ext == "csv":
        text = _decode(data)
        rows = list(csv.DictReader(io.StringIO(text)))
        if rows:
            cols = {c.strip().lower(): c for c in rows[0].keys() if c}
            qk = next((cols[k] for k in ("question", "q", "ถาม", "คำถาม") if k in cols), None)
            ak = next((cols[k] for k in ("answer", "a", "ตอบ", "คำตอบ") if k in cols), None)
            if qk and ak:
                return [{"title": r[qk][:60], "text": qa_text(r[qk], r[ak]), "kind": "qa"}
                        for r in rows if (r.get(qk) or "").strip() and (r.get(ak) or "").strip()]
            body = "\n".join("; ".join(f"{k}: {v}" for k, v in r.items() if v) for r in rows)
            return [{"title": stem, "text": body, "kind": "file"}]
        return []
    if ext == "pdf":
        try:
            from pypdf import PdfReader  # type: ignore
        except Exception:
            raise ValueError("อ่าน PDF ต้องติดตั้งเพิ่ม: pip install pypdf")
        reader = PdfReader(io.BytesIO(data))
        body = "\n\n".join((p.extract_text() or "") for p in reader.pages)
        if not body.strip():
            raise ValueError("PDF นี้ไม่มีข้อความให้อ่าน (อาจเป็นภาพสแกน ต้องทำ OCR ก่อน)")
        return [{"title": stem, "text": body, "kind": "file"}]
    if ext == "docx":
        try:
            import docx  # type: ignore
        except Exception:
            raise ValueError("อ่าน DOCX ต้องติดตั้งเพิ่ม: pip install python-docx")
        d = docx.Document(io.BytesIO(data))
        body = "\n".join(p.text for p in d.paragraphs)
        return [{"title": stem, "text": body, "kind": "file"}]
    raise ValueError(f"ยังไม่รองรับไฟล์ .{ext} (รองรับ txt, md, csv, pdf, docx)")


# ---------------------------------------------------------------- เป็นชุดเทรน (D1)

def qa_pairs() -> list[dict]:
    """ดึงคู่ถาม-ตอบจากเอกสารชนิด qa ที่เปิดใช้ ในรูปแบบ {instruction, input, output} ที่ตัวเทรนใช้"""
    out = []
    for d in list_docs(kind="qa", include_text=True):
        if not d["enabled"]:
            continue
        m = re.match(r"ถาม:\s*(.*?)\nตอบ:\s*(.*)$", d["raw_text"], re.S)
        if m:
            out.append({"instruction": m.group(1).strip(), "input": "", "output": m.group(2).strip()})
    return out
