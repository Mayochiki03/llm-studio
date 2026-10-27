// สร้างชุดข้อมูลเทรนจาก "ตารางข้อเท็จจริง" (ไม่ต้องใช้ AI): กรอกเรื่องละแถว ระบบขยายสำนวน กันข้อสอบ และสร้างโจทย์ทดสอบให้เอง
import { useEffect, useState } from "react";
import { Plus, Trash2, Wand2, FileText, Eye, ShieldQuestion, Sparkles } from "lucide-react";
import Button from "./Button";
import { Field, Modal, Notice, TextArea, TextInput, Toggle } from "./ui";
import { toast, errText } from "./toast";
import { api, type DsQuality } from "../api/client";
import type { FactsDraft } from "../types";

export interface FactRow {
  topic: string;
  answer: string;
  questions: string; // คำถามแบบละบรรทัด
  answers_alt: string; // คำตอบสำนวนอื่น บรรทัดละแบบ (ใจความ/ตัวเลขเหมือนเดิม)
  keywords: string; // คั่นด้วย comma
  red_flag: boolean;
}

export const emptyRow = (): FactRow => ({ topic: "", answer: "", questions: "", answers_alt: "", keywords: "", red_flag: false });

/** แปลงแถวในฟอร์มเป็นรูปที่ backend ต้องการ: คำถามแยกบรรทัด, คำสำคัญแยกด้วย comma (รองรับ comma ไทย/อังกฤษ) */
export function rowsToFacts(rows: FactRow[]) {
  return rows
    .map((r) => ({
      topic: r.topic.trim(),
      answer: r.answer.trim(),
      questions: r.questions.split("\n").map((x) => x.trim()).filter(Boolean),
      answers_alt: r.answers_alt.split("\n").map((x) => x.trim()).filter(Boolean),
      keywords: r.keywords.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
      red_flag: r.red_flag,
    }))
    .filter((f) => f.answer && f.questions.length > 0);
}

export function factsToRows(facts: { topic?: string; answer?: string; questions?: string[]; answers_alt?: string[]; keywords?: string[]; red_flag?: boolean }[]): FactRow[] {
  return facts.map((f) => ({
    topic: f.topic ?? "", answer: f.answer ?? "", questions: (f.questions ?? []).join("\n"),
    answers_alt: (f.answers_alt ?? []).join("\n"),
    keywords: (f.keywords ?? []).join(", "), red_flag: !!f.red_flag,
  }));
}

/** แปลงข้อความ "บรรทัดละข้อ" เป็นรายการคำถามนอกขอบเขต (ตัดช่องว่าง/บรรทัดว่าง/ข้อซ้ำ) */
export function linesToList(text: string): string[] {
  return Array.from(new Set(text.split("\n").map((x) => x.trim()).filter(Boolean)));
}

/** สรุปความหลากหลายสั้นๆ + คำเตือน (ใช้ทั้งตอนดูตัวอย่างและในตารางแก้ไข) */
export function QualityLine({ q }: { q: DsQuality }) {
  return (
    <div className="text-xs space-y-0.5">
      <div className="text-base-300">คำถามไม่ซ้ำ {q.unique_questions}/{q.total} · คำตอบไม่ซ้ำ {q.unique_answers} แบบ · คำตอบที่ซ้ำสุดกิน {Math.round(q.top_answer_share * 100)}% · คู่คำถามคล้ายกัน {q.near_dup_pairs}</div>
      {q.warnings.map((w, i) => <div key={i} className="text-amber-300">{w}</div>)}
    </div>
  );
}

export default function FactsBuilderDialog({ onClose, onDone, draft }: { onClose: () => void; onDone: () => void; draft?: FactsDraft | null }) {
  const [label, setLabel] = useState("");
  // draft = ร่างจากข้อที่พลาดในหน้าทดสอบ: เติมเป็นแถวให้เลย (ช่องคำตอบที่ว่างต้องกรอกก่อน ไม่งั้นแถวนั้นไม่ถูกนำไปสร้าง)
  const [rows, setRows] = useState<FactRow[]>(draft && draft.facts.length ? factsToRows(draft.facts) : [emptyRow()]);
  const [augment, setAugment] = useState(true);
  const [defaults, setDefaults] = useState(true);
  const [ragFormat, setRagFormat] = useState(false); // แนบเอกสารอ้างอิงในตัวอย่างเทรน (ตรงกับตอนใช้งานจริงที่มีคลังความรู้)
  const [busy, setBusy] = useState(false);
  // คำถามนอกขอบเขต: โหลดค่าเริ่มต้นจาก backend ให้แก้/เพิ่ม/ลบเองได้ (ว่าง = ไม่ใส่)
  const [oos, setOos] = useState("");
  const [unknownAns, setUnknownAns] = useState("");
  const [oosLoaded, setOosLoaded] = useState(false);
  const [preview, setPreview] = useState<{ stats: { train: number; eval: number; skipped: number; out_of_scope?: number; oos_eval?: number; alt_dropped?: number }; train_sample: { instruction: string }[]; quality?: DsQuality } | null>(null);
  const [suggesting, setSuggesting] = useState<string | null>(null); // "คำถาม-i" / "คำตอบ-i" ที่กำลังรอ Gemini

  useEffect(() => {
    api.dsOosDefault().then((d) => { setOos([...d.questions, ...(draft?.oos ?? [])].join("\n")); setUnknownAns(d.answer); setOosLoaded(true); }).catch(() => setOosLoaded(true));
  }, []);

  const facts = rowsToFacts(rows);
  const oosList = linesToList(oos);
  const patch = (i: number, p: Partial<FactRow>) => { setPreview(null); setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r))); };

  async function loadTemplate() {
    try {
      const t = await api.dsFactsTemplate();
      setRows(factsToRows(t)); setPreview(null);
      if (!label) setLabel("FAQ ตัวอย่าง (แก้เป็นของเรา)");
      toast("โหลดตัวอย่างแล้ว แก้ข้อความเป็นข้อมูลจริงของเราได้เลย");
    } catch (e) { toast(errText(e), "bad"); }
  }
  /** ให้ Gemini ช่วยคิดคำถาม/คำตอบเพิ่ม: ต้องยืนยันก่อนส่ง และเอาผลไปต่อท้ายช่อง (ผู้ใช้แก้/ลบต่อได้) */
  async function suggest(i: number, kind: "questions" | "answers") {
    const r = rows[i];
    if (!r.answer.trim()) { toast("ใส่คำตอบมาตรฐานของเรื่องนี้ก่อน", "bad"); return; }
    if (!confirm("ข้อความของเรื่องนี้ (หัวข้อ/คำตอบ/คำถามที่พิมพ์ไว้) จะถูกส่งให้ Gemini เพื่อช่วยคิด\nส่งเฉพาะข้อมูลที่ไม่ใช่ข้อมูลผู้ป่วยจริงเท่านั้น ส่งเลย?")) return;
    const key = `${kind}-${i}`;
    setSuggesting(key);
    try {
      const f = rowsToFacts([r])[0] ?? { questions: [] as string[] };
      const res = await api.dsSuggest({ kind, topic: r.topic, answer: r.answer, questions: f.questions ?? [], n: kind === "questions" ? 6 : 3 });
      if (!res.ok) { toast(res.error ?? "Gemini ไม่ตอบ", "bad"); return; }
      const add = (res.items ?? []).join("\n");
      if (!add) { toast("ไม่ได้ข้อเสนอใหม่"); return; }
      patch(i, kind === "questions" ? { questions: r.questions.trim() ? r.questions.trim() + "\n" + add : add } : { answers_alt: r.answers_alt.trim() ? r.answers_alt.trim() + "\n" + add : add });
      toast("เพิ่มข้อเสนอแล้ว อ่านตรวจและแก้ก่อนสร้างชุดข้อมูลนะ");
    } catch (e) { toast(errText(e), "bad"); } finally { setSuggesting(null); }
  }
  async function doPreview() {
    try { setPreview(await api.dsFactsPreview(facts, augment, defaults, oosList, unknownAns, ragFormat)); } catch (e) { toast(errText(e), "bad"); }
  }
  async function create() {
    setBusy(true);
    try {
      const r = await api.dsFromFacts(label.trim(), facts, augment, defaults, oosList, unknownAns, ragFormat);
      toast(`สร้างชุดข้อมูล ${r.examples} ตัวอย่าง และเพิ่มโจทย์ทดสอบ ${r.eval_added} ข้อแล้ว`);
      onDone();
    } catch (e) { toast(errText(e), "bad"); } finally { setBusy(false); }
  }

  return (
    <Modal title="สร้างชุดข้อมูลจากตารางข้อเท็จจริง" onClose={onClose} wide
      footer={<>
        <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
        <Button variant="secondary" onClick={doPreview} disabled={facts.length === 0}><Eye size={14} /> ดูตัวอย่าง</Button>
        <Button onClick={create} disabled={busy || !label.trim() || facts.length === 0}>{busy ? "กำลังสร้าง..." : "สร้าง"}</Button>
      </>}>
      <Notice tone="info">
        <div className="space-y-1">
          <div className="font-medium">วิธีใช้: ใส่ข้อเท็จจริงทีละเรื่อง แล้วระบบทำส่วนที่เหลือให้</div>
          <div>1) ใส่ <b>คำตอบมาตรฐาน</b> ของเรื่องนั้น  2) ใส่ <b>คำถามหลายแบบ</b> (บรรทัดละข้อ ยิ่งหลากหลายยิ่งดี อย่างน้อย 5-8 แบบ)  3) ใส่ <b>คำสำคัญ</b> ที่คำตอบต้องมี เช่นเบอร์โทร/เวลา</div>
          <div>คำถามข้อสุดท้ายของแต่ละเรื่องจะถูกกันไว้เป็นข้อสอบ (ไม่เอาไปเทรน) พร้อมเกณฑ์ตรวจจากคำสำคัญ ไม่ต้องไปสร้างโจทย์ทดสอบเอง</div>
        </div>
      </Notice>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" className="text-xs py-1.5" onClick={loadTemplate}><FileText size={13} /> โหลดตัวอย่าง (ข้อมูลสมมติ)</Button>
        <Button variant="secondary" className="text-xs py-1.5" onClick={() => setRows((r) => [...r, emptyRow()])}><Plus size={13} /> เพิ่มเรื่อง</Button>
      </div>

      <Field label="ชื่อชุดข้อมูล"><TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="เช่น FAQ บริการผู้ป่วยนอก ต.ค." /></Field>

      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="border border-base-800 rounded-lg p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <TextInput value={r.topic} onChange={(e) => patch(i, { topic: e.target.value })} placeholder={`เรื่องที่ ${i + 1}: หัวข้อ เช่น เวลาทำการ`} />
              <button className="text-base-500 hover:text-bad shrink-0 p-1.5" onClick={() => { setPreview(null); setRows((rs) => rs.length > 1 ? rs.filter((_, j) => j !== i) : [emptyRow()]); }} aria-label="ลบเรื่องนี้"><Trash2 size={15} /></button>
            </div>
            <TextArea rows={2} value={r.answer} onChange={(e) => patch(i, { answer: e.target.value })} placeholder="คำตอบมาตรฐาน เช่น OPD เปิดจันทร์-ศุกร์ 08.00-16.00 น. ค่ะ" />
            <TextArea rows={4} value={r.questions} onChange={(e) => patch(i, { questions: e.target.value })} placeholder={"คำถามบรรทัดละข้อ เช่น\nเปิดกี่โมง\nวันเสาร์เปิดไหม\nขอทราบเวลาทำการ"} />
            <TextArea rows={2} value={r.answers_alt} onChange={(e) => patch(i, { answers_alt: e.target.value })} placeholder="คำตอบสำนวนอื่น (ไม่บังคับ บรรทัดละแบบ ใจความ ตัวเลข เบอร์โทร ต้องเหมือนคำตอบหลัก) ช่วยให้โมเดลไม่ท่องประโยคเดียว" />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" className="text-xs py-1" disabled={suggesting !== null} onClick={() => suggest(i, "questions")}><Sparkles size={12} /> {suggesting === `questions-${i}` ? "กำลังคิด..." : "ช่วยคิดคำถามเพิ่ม"}</Button>
              <Button variant="secondary" className="text-xs py-1" disabled={suggesting !== null} onClick={() => suggest(i, "answers")}><Sparkles size={12} /> {suggesting === `answers-${i}` ? "กำลังเขียน..." : "ช่วยเขียนคำตอบอีกสำนวน"}</Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
              <Field label="คำสำคัญที่คำตอบต้องมี (คั่นด้วย comma)"><TextInput value={r.keywords} onChange={(e) => patch(i, { keywords: e.target.value })} placeholder="เช่น 08.00, 16.00" /></Field>
              <Toggle checked={r.red_flag} onChange={(v) => patch(i, { red_flag: v })} label="เคสอันตราย (red flag)" />
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <Toggle checked={augment} onChange={(v) => { setAugment(v); setPreview(null); }} label="ขยายสำนวนคำถามอัตโนมัติ" hint="เติมคำนำหน้า เช่น ขอสอบถามหน่อย เพื่อให้โมเดลเจอคำถามหลายสำนวน (แนะนำให้เปิด)" />
        <Toggle checked={ragFormat} onChange={(v) => { setRagFormat(v); setPreview(null); }} label="สอนแบบมีเอกสารอ้างอิง (RAG)" hint="แนบเอกสารที่ตรงเรื่องในตัวอย่างสอน ให้โมเดลเรียน 'อ่านเอกสารแล้วตอบ' เหมาะถ้าตอนใช้งานจริงเปิดคลังความรู้ (แนะนำเมื่อใช้คู่กับคลังความรู้)" />
        <Toggle checked={defaults} onChange={(v) => { setDefaults(v); setPreview(null); }} label="เติมตัวอย่างพื้นฐาน" hint="ทักทาย, ไม่วินิจฉัยโรค, ถามนอกขอบเขตให้ตอบว่าไม่ทราบ (ช่วยลดการแต่งข้อมูลเอง แนะนำให้เปิด)" />
      </div>

      <div className="border border-base-800 rounded-lg p-3 space-y-2.5">
        <div className="flex items-center gap-2 text-sm font-medium"><ShieldQuestion size={15} className="text-accent-400" /> ขอบเขต: คำถามที่ต้องตอบว่า "ไม่มีข้อมูล"</div>
        <div className="text-xs text-base-400">ใส่เรื่องที่ระบบ <b>ไม่ควรรู้</b> เช่น จำนวนชั้น ที่จอดรถ เบอร์ส่วนตัวของหมอ (บรรทัดละข้อ) โมเดลจะถูกสอนให้ตอบว่าไม่มีข้อมูล แทนที่จะเดาเอง และจะกันบางข้อไว้เป็นข้อสอบ ถ้าเรื่องไหนมีข้อมูลจริงให้ใส่ในตารางข้างบนแทน ข้อที่ซ้ำกับคำถามในตารางระบบจะตัดทิ้งให้เอง</div>
        <TextArea rows={6} value={oos} onChange={(e) => { setOos(e.target.value); setPreview(null); }} disabled={!oosLoaded} placeholder={"โรงพยาบาลมีกี่ชั้น\nมีที่จอดรถกี่คัน\nขอเบอร์ส่วนตัวของหมอ"} />
        <Field label="คำตอบเมื่อไม่มีข้อมูล"><TextInput value={unknownAns} onChange={(e) => { setUnknownAns(e.target.value); setPreview(null); }} /></Field>
        <div className="text-[11px] text-base-500">{oosList.length} ข้อ · ล้างช่องนี้ให้ว่างถ้าไม่ต้องการใส่</div>
      </div>

      {preview && (
        <Notice tone="good">
          <div className="space-y-1">
            <div className="font-medium">จะได้ตัวอย่างเทรน {preview.stats.train} ข้อ และโจทย์ทดสอบ {preview.stats.eval} ข้อ{preview.stats.oos_eval ? ` (รวมข้อสอบนอกขอบเขต ${preview.stats.oos_eval} ข้อ)` : ""}{preview.stats.skipped > 0 && ` (ข้าม ${preview.stats.skipped} แถวที่ยังกรอกไม่ครบ)`}</div>
            {preview.quality && <QualityLine q={preview.quality} />}
            {preview.train_sample.slice(0, 4).map((t, i) => <div key={i} className="text-base-300 truncate">• {t.instruction}</div>)}
          </div>
        </Notice>
      )}
      <div className="flex items-center gap-1.5 text-[11px] text-base-500"><Wand2 size={12} /> ใช้ได้โดยไม่ต้องมี Gemini key ข้อมูลทั้งหมดอยู่ในเครื่อง</div>
    </Modal>
  );
}
