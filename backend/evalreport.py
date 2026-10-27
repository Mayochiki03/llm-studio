"""รายงานผลทดสอบ (0.8.4): ส่งออก (CSV/JSON/ข้อความเฉพาะข้อที่พลาด) และวิเคราะห์ "พลาดเพราะอะไร" แบบกฎ ไม่ใช้ AI/ไม่ส่งข้อมูลออกนอกเครื่อง

รูปแบบข้อมูลที่รับ = ผลเปรียบเทียบ (compare result): {models, rows:[{prompt_id, prompt_text, category, red_flag, expect, must_not,
answers:{model:{response, passed, missing, violated, guard, sources, total_s, tokens_per_s}}}], summaries}
"""
from __future__ import annotations

import csv
import io
import json
import re

# ชนิดความผิดพลาด → (ป้าย, คำแนะนำสิ่งที่ควรทำ)
KINDS: dict[str, tuple[str, str]] = {
    "red_flag_miss": ("พลาดเคสอันตราย (red flag)",
                      "ร้ายแรงที่สุด ห้ามอนุมัติ ตรวจกฎในหน้า 'ขอบเขตการตอบ' ว่ามีคำของเคสนี้ และเติมตัวอย่างสอนเคสนี้หลายสำนวน"),
    "ignored_doc": ("ยึดความจำเก่ามากกว่าเอกสาร",
                    "โมเดลตอบเลข/ข้อมูลเดิมที่เคยเรียน ทั้งที่เอกสารบอกค่าใหม่ ลองสอนแบบมีเอกสารอ้างอิง (RAG) และอย่าฝังเลขที่เปลี่ยนบ่อยในคำตอบของชุดสอน"),
    "hallucination": ("ไม่ยอมรับว่าไม่รู้ (แต่งเอง)",
                      "ถามนอกขอบเขตแล้วตอบมั่ว เติมคำถามนอกขอบเขตแบบเกือบตรงให้มากขึ้น ตอบ 'ไม่มีข้อมูล' หลายสำนวน และเปิดด่านขอบเขต (ค้นไม่เจอ = ไม่เรียกโมเดล)"),
    "over_refusal": ("ปฏิเสธทั้งที่ควรตอบ",
                     "คำถามที่ควรตอบกลับถูกปฏิเสธ ลดสัดส่วนข้อมูลนอกขอบเขตที่คล้ายคำถามจริง ตรวจว่าคลังความรู้มีเอกสารเรื่องนี้ และลองสอนแบบมีเอกสารอ้างอิง"),
    "wrong_number": ("เลข/เวลาผิด",
                     "ตอบเลขหรือเวลาไม่ตรง อย่าหวังให้โมเดลจำเลข ให้ดึงจากคลังความรู้/เครื่องมือ และใช้คำตอบหลายสำนวนที่คงเลขเดิมไว้"),
    "missing_keyword": ("ตกคำสำคัญ",
                        "อาจตอบถูกแต่ใช้คำคนละแบบ เปิดดูคำตอบจริงก่อน ถ้าถูกให้ผ่อนเงื่อนไข (ใช้ a|b) ถ้าผิดให้เติมคำถามสำนวนนี้ในชุดสอน"),
    "forbidden": ("มีสิ่งที่ห้ามมี",
                  "คำตอบมีข้อความที่ห้ามปรากฏ ตรวจว่าเป็นการแต่งเองหรือข้อสอบเข้มเกิน"),
    "error": ("โมเดลไม่ตอบ/ผิดพลาด", "ตรวจว่า Ollama ทำงานและโมเดลโหลดอยู่ แล้วรันใหม่"),
}

_REFUSE = ("ไม่มีข้อมูล", "ไม่สามารถ", "ไม่ทราบ", "ไม่พบข้อมูล")


def classify(row: dict, ans: dict) -> str | None:
    """จัดกลุ่มความผิดพลาดของคำตอบเดียว (None = ผ่านหรือไม่มีเกณฑ์)"""
    if ans.get("passed") is not False and not str(ans.get("response", "")).startswith("(error"):
        return None
    resp = str(ans.get("response", ""))
    if resp.startswith("(error"):
        return "error"
    cat = row.get("category") or ""
    missing = ans.get("missing") or []
    violated = ans.get("violated") or []
    if row.get("red_flag"):
        return "red_flag_miss"
    if cat == "เอกสารขัดความจำ":
        return "ignored_doc"
    if cat == "นอกขอบเขต":
        return "hallucination"
    if any(w in resp for w in _REFUSE) and (missing or "ไม่มีข้อมูล" in violated):
        return "over_refusal"
    if any(re.search(r"\d", m) for m in missing):
        return "wrong_number"
    if violated and not missing:
        return "forbidden"
    return "missing_keyword"


def analyze(result: dict) -> dict:
    """วิเคราะห์ผลเปรียบเทียบ: ต่อโมเดลแยกกลุ่มความผิดพลาด + คู่ที่โมเดลหนึ่งผ่านอีกตัวพลาด"""
    models = result.get("models", [])
    per: dict[str, dict] = {}
    for m in models:
        groups: dict[str, list[str]] = {}
        for row in result.get("rows", []):
            a = (row.get("answers") or {}).get(m)
            if not a:
                continue
            k = classify(row, a)
            if k:
                groups.setdefault(k, []).append(row["prompt_id"])
        order = list(KINDS)
        per[m] = {
            "failed": sum(len(v) for v in groups.values()),
            "groups": [{"kind": k, "label": KINDS[k][0], "advice": KINDS[k][1], "count": len(groups[k]), "prompt_ids": groups[k]}
                       for k in order if k in groups],
        }
    diffs = []
    if len(models) >= 2:
        a, b = models[0], models[1]
        for row in result.get("rows", []):
            x, y = (row.get("answers") or {}).get(a), (row.get("answers") or {}).get(b)
            if x and y and x.get("passed") is not None and y.get("passed") is not None and x["passed"] != y["passed"]:
                diffs.append({"prompt_id": row["prompt_id"], "text": row.get("prompt_text", ""),
                              "winner": a if x["passed"] else b})
    return {"models": per, "differences": diffs}


# ---------------------------------------------------------------- ส่งออก
def _cell(x) -> str:
    if isinstance(x, (list, tuple)):
        return " | ".join(str(i) for i in x)
    return "" if x is None else str(x)


def to_csv(result: dict) -> str:
    """CSV แบบกว้าง: หนึ่งแถวต่อคำถาม หลายคอลัมน์ต่อโมเดล เปิดใน Excel ได้ (ใส่ BOM ให้ภาษาไทยไม่เพี้ยน)"""
    models = result.get("models", [])
    head = ["คำถาม", "กลุ่ม", "red_flag", "คำที่ต้องมี", "คำที่ห้ามมี"]
    for m in models:
        head += [f"{m} | คำตอบ", f"{m} | ผล", f"{m} | ขาด", f"{m} | ห้ามแต่มี", f"{m} | ด่านขอบเขต", f"{m} | เอกสารที่ดึง", f"{m} | คะแนนค้นสูงสุด", f"{m} | คำตอบเดิมก่อนแก้เลข", f"{m} | เวลา(วิ)", f"{m} | กลุ่มที่พลาด"]
    out = io.StringIO()
    out.write("﻿")
    w = csv.writer(out)
    w.writerow(head)
    for row in result.get("rows", []):
        line = [row.get("prompt_text", ""), row.get("category", ""), "ใช่" if row.get("red_flag") else "", _cell(row.get("expect")), _cell(row.get("must_not"))]
        for m in models:
            a = (row.get("answers") or {}).get(m) or {}
            k = classify(row, a) if a else None
            line += [a.get("response", ""), {True: "ผ่าน", False: "ไม่ผ่าน", None: "ไม่มีเกณฑ์"}.get(a.get("passed")), _cell(a.get("missing")),
                     _cell(a.get("violated")), a.get("guard") or "", _cell(a.get("sources")), a.get("top_score") if a.get("top_score") is not None else "", a.get("reply_original") or "", a.get("total_s") or "", KINDS[k][0] if k else ""]
        w.writerow(line)
    w.writerow([])
    w.writerow(["สรุป", "โมเดล", "ผ่านเกณฑ์", "จับ red flag", "เวลาเฉลี่ย(วิ)", "ความเร็ว(tok/s)"])
    for m in models:
        s = (result.get("summaries") or {}).get(m) or {}
        w.writerow(["", m, s.get("pass_rate"), s.get("red_flag_recall"), s.get("avg_latency_s"), s.get("avg_tokens_per_s")])
    return out.getvalue()


def to_json(result: dict) -> str:
    return json.dumps({**result, "analysis": analyze(result)}, ensure_ascii=False, indent=2)


def failed_text(result: dict, max_chars: int = 260) -> str:
    """ข้อความสั้นเฉพาะข้อที่พลาด ไว้คัดลอกส่งให้คนอื่น/ถามต่อ (ตัดคำตอบยาว)"""
    models = result.get("models", [])
    lines = [f"ผลเปรียบเทียบ {len(models)} โมเดล" + (" (มีคลังความรู้)" if result.get("use_kb") else " (ไม่มีคลังความรู้)")]
    for m in models:
        s = (result.get("summaries") or {}).get(m) or {}
        lines.append(f"- {m}: ผ่าน {_pct(s.get('pass_rate'))} red flag {_pct(s.get('red_flag_recall'))} เวลา {s.get('avg_latency_s') or '-'} วิ")
    n = 0
    for row in result.get("rows", []):
        bad = []
        for m in models:
            a = (row.get("answers") or {}).get(m)
            if a and a.get("passed") is False:
                resp = " ".join(str(a.get("response", "")).split())
                if len(resp) > max_chars:
                    resp = resp[:max_chars] + "…"
                k = classify(row, a)
                bad.append(f"  [{m}] {KINDS[k][0] if k else 'ไม่ผ่าน'} | ขาด: {_cell(a.get('missing')) or '-'} | ห้ามแต่มี: {_cell(a.get('violated')) or '-'}\n    ตอบ: {resp}")
        if bad:
            n += 1
            lines.append(f"\n{n}. ({row.get('category') or '-'}) {row.get('prompt_text', '')}")
            lines += bad
    if n == 0:
        lines.append("\nไม่มีข้อที่พลาด")
    return "\n".join(lines)


def _pct(x) -> str:
    return "-" if x is None else f"{round(float(x) * 100)}%"


def run_to_result(run: dict) -> dict:
    """แปลงผลรอบเดี่ยว (eval run) ให้อยู่ในรูปเดียวกับผลเปรียบเทียบ เพื่อใช้ตัวส่งออก/วิเคราะห์ชุดเดียวกัน"""
    m = run.get("model", "model")
    rows = []
    for r in run.get("results", []):
        rows.append({"prompt_id": r.get("prompt_id"), "prompt_text": r.get("prompt_text"), "category": r.get("category", ""),
                     "red_flag": r.get("red_flag"), "expect": r.get("expect", []), "must_not": r.get("must_not", []),
                     "answers": {m: {k: r.get(k) for k in ("response", "passed", "missing", "violated", "guard", "sources", "top_score", "reply_original", "total_s", "tokens_per_s")}}})
    return {"models": [m], "rows": rows, "summaries": {m: run.get("summary", {})}, "use_kb": run.get("use_kb", False)}


# ---------------------------------------------------------------- รายงานความมั่นใจ (0.8.6) สำหรับให้หัวหน้า/ผู้ตัดสินใจอ่าน
LIMITS = [
    "ข้อสอบตรวจด้วยคำสำคัญ ผ่านข้อสอบไม่ได้แปลว่าตอบถูกในทุกสำนวน และบางข้อที่ตัดสินว่าพลาดอาจเป็นคำตอบถูกที่ใช้คำอื่น",
    "ข้อสอบเขียนโดยทีมพัฒนา ผู้ใช้จริงจะถามในแบบที่เราคาดไม่ถึงได้เสมอ ยังไม่เคยทดสอบกับคำถามผู้ป่วยจริง",
    "โมเดลขนาดเล็กอาจแต่งข้อมูลได้ แม้มีชั้นป้องกัน (ตรวจเลข, ขอบเขต, เคสอันตราย) ช่วยลดความเสี่ยงได้แต่ไม่ได้ขจัดทั้งหมด",
    "ชั้นเคสอันตรายอาศัยคำสำคัญ ผู้ใช้ที่พูดอ้อมมากอาจไม่ตรงกฎ ต้องหมั่นเพิ่มคำจากกรณีจริง",
    "ข้อมูลในคลังความรู้ตอนนี้เป็นข้อมูลสมมติ ต้องให้เจ้าหน้าที่ตรวจข้อมูลจริงก่อนใช้งาน",
    "ระบบนี้เป็นผู้ช่วยตอบคำถามเบื้องต้น ไม่ใช่การวินิจฉัยหรือแทนที่เจ้าหน้าที่ ควรมีช่องทางส่งต่อคนเสมอ",
]


def _pct_s(a: int, b: int) -> str:
    return f"{a}/{b} ({round(100 * a / b)}%)" if b else "-"


def confidence_report(result: dict, title: str = "") -> str:
    """รายงาน Markdown: ผลรวม, ผลรายกลุ่ม, ข้อที่ห้ามพลาด (red flag), ข้อที่พลาดในกลุ่มแหย่โมเดล, ข้อจำกัดที่ระบบรับประกันไม่ได้
    เขียนให้คนที่ไม่ใช่นักพัฒนาอ่านเข้าใจ ไม่ใช้ศัพท์เทคนิคเกินจำเป็น"""
    models = result.get("models", [])
    rows = result.get("rows", [])
    out = [f"# รายงานความมั่นใจของโมเดล{(' — ' + title) if title else ''}", ""]
    out.append(f"ทดสอบ {len(rows)} ข้อ {'แบบมีคลังความรู้ (เหมือนใช้งานจริง)' if result.get('use_kb') else 'แบบไม่มีคลังความรู้'}")
    out += ["", "## สรุปรายโมเดล", "", "| โมเดล | ผ่านเกณฑ์ | จับเคสอันตรายได้ | พลาดเคสอันตราย |", "|---|---|---|---|"]
    rf_rows = [r for r in rows if r.get("red_flag")]
    for m in models:
        graded = [r for r in rows if (r.get("answers") or {}).get(m, {}).get("passed") is not None]
        ok = sum(1 for r in graded if r["answers"][m]["passed"])
        rf_ok = sum(1 for r in rf_rows if (r.get("answers") or {}).get(m, {}).get("passed"))
        out.append(f"| {m} | {_pct_s(ok, len(graded))} | {_pct_s(rf_ok, len(rf_rows))} | {len(rf_rows) - rf_ok} ข้อ |")

    cats: dict[str, list[dict]] = {}
    for r in rows:
        cats.setdefault(r.get("category") or "ทั่วไป", []).append(r)
    out += ["", "## ผ่านกี่ข้อในแต่ละกลุ่มคำถาม", "", "| กลุ่ม | " + " | ".join(models) + " |", "|---|" + "---|" * len(models)]
    for c, rs in cats.items():
        cells = []
        for m in models:
            g = [r for r in rs if (r.get("answers") or {}).get(m, {}).get("passed") is not None]
            cells.append(_pct_s(sum(1 for r in g if r["answers"][m]["passed"]), len(g)))
        out.append(f"| {c} | " + " | ".join(cells) + " |")

    out += ["", "## ข้อที่ห้ามพลาด (เคสอันตราย)", ""]
    for m in models:
        bad = [r for r in rf_rows if not (r.get("answers") or {}).get(m, {}).get("passed")]
        if not rf_rows:
            out.append(f"- {m}: ไม่มีข้อสอบเคสอันตรายในรอบนี้")
        elif not bad:
            out.append(f"- {m}: ตอบถูกครบทุกข้อ ({len(rf_rows)} ข้อ)")
        else:
            out.append(f"- {m}: **พลาด {len(bad)} ข้อ** ต้องแก้ก่อนใช้งานจริง")
            for r in bad[:10]:
                out.append(f"  - \"{r.get('prompt_text', '')}\"")

    probe = [r for r in rows if str(r.get("category", "")).startswith("แหย่")]
    if probe:
        out += ["", "## ข้อที่พลาดในกลุ่มแหย่โมเดล", ""]
        for m in models:
            bad = [r for r in probe if (r.get("answers") or {}).get(m, {}).get("passed") is False]
            out.append(f"### {m}: พลาด {len(bad)} จาก {len(probe)} ข้อ")
            for r in bad[:15]:
                a = r["answers"][m]
                k = classify(r, a)
                resp = " ".join(str(a.get("response", "")).split())[:160]
                out.append(f"- ({str(r.get('category', '')).replace('แหย่: ', '')}) \"{r.get('prompt_text', '')}\" → {KINDS[k][0] if k else 'ไม่ผ่าน'}: {resp}")
            out.append("")

    out += ["## สิ่งที่ระบบนี้ยังรับประกันไม่ได้", ""] + [f"- {x}" for x in LIMITS]
    return "\n".join(out).rstrip() + "\n"
