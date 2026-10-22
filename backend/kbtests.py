"""ชุดทดสอบการค้นของคลังความรู้: "ถามคำถามนี้ ควรเจอเอกสารไหน"

ใช้ก่อนเปลี่ยนขนาดชิ้น/โมเดลสร้างเวกเตอร์ เพื่อดูว่าแม่นขึ้นหรือแย่ลงด้วยตัวเลข ไม่ใช่ความรู้สึก
ผลลัพธ์: hit_rate (เจอเอกสารที่คาดไว้ใน top_k กี่ %) และ MRR (ยิ่งใกล้ 1 ยิ่งเจอเป็นอันดับต้นๆ)
"""
from __future__ import annotations

import json
import time
import uuid

import db
import kb


def list_tests() -> list[dict]:
    rows = db.query("SELECT * FROM kb_tests ORDER BY created_at DESC")
    titles = {d["id"]: d["title"] for d in kb.list_docs()}
    for r in rows:
        r["expect_doc_ids"] = json.loads(r["expect_doc_ids"] or "[]")
        r["expect_titles"] = [titles.get(i, "(เอกสารถูกลบแล้ว)") for i in r["expect_doc_ids"]]
    return rows


def add_test(question: str, expect_doc_ids: list[str], note: str = "") -> dict:
    if not question.strip():
        raise ValueError("ต้องกรอกคำถาม")
    if not expect_doc_ids:
        raise ValueError("เลือกเอกสารที่ควรถูกดึงมาอย่างน้อย 1 รายการ")
    tid = uuid.uuid4().hex[:10]
    db.execute("INSERT INTO kb_tests (id,question,expect_doc_ids,note,created_at) VALUES (?,?,?,?,?)",
               (tid, question.strip(), json.dumps(expect_doc_ids), note, time.time()))
    return next(t for t in list_tests() if t["id"] == tid)


def delete_test(tid: str) -> bool:
    if not db.query_one("SELECT id FROM kb_tests WHERE id=?", (tid,)):
        return False
    db.execute("DELETE FROM kb_tests WHERE id=?", (tid,))
    return True


async def run_all(top_k: int | None = None) -> dict:
    """รันทุกข้อ: ค้นแล้วดูอันดับของเอกสารที่คาดไว้ (นับตามเอกสาร ไม่ใช่ตามชิ้น)"""
    results = []
    mode = "none"
    for t in list_tests():
        res = await kb.search(t["question"], top_k)
        mode = res.get("mode", mode)
        order: list[str] = []
        for h in res.get("hits", []):
            if h["doc_id"] not in order:
                order.append(h["doc_id"])
        ranks = [order.index(d) + 1 for d in t["expect_doc_ids"] if d in order]
        rank = min(ranks) if ranks else None
        results.append({"id": t["id"], "question": t["question"], "expect_titles": t["expect_titles"],
                        "hit": rank is not None, "rank": rank, "found_titles": [
                            next((h["title"] for h in res.get("hits", []) if h["doc_id"] == d), d) for d in order]})
    n = len(results)
    hits = sum(1 for r in results if r["hit"])
    mrr = sum(1 / r["rank"] for r in results if r["rank"]) / n if n else None
    return {"mode": mode, "total": n, "hits": hits, "hit_rate": round(hits / n, 3) if n else None,
            "mrr": round(mrr, 3) if mrr is not None else None, "results": results}
