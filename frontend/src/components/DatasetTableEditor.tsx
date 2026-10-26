// ตารางแก้ไขชุดข้อมูลเทรนสไตล์ Excel: ค้นหา แก้ในช่อง เพิ่ม/ลบแถว เตือนคำถามซ้ำ แล้วบันทึกเป็นเวอร์ชันใหม่ (ย้อนกลับได้)
import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Trash2, Save, Copy } from "lucide-react";
import Button from "./Button";
import { Modal, Spinner } from "./ui";
import { toast, errText } from "./toast";
import { api } from "../api/client";
import type { QAPair } from "../types";
import type { DsQuality } from "../api/client";
import { QualityLine } from "./FactsBuilderDialog";

const PAGE = 50; // แถวต่อหน้า (ชุด 800+ แถวยังลื่น)

interface Row extends QAPair {
  rid: number;       // เลขประจำแถวในหน้าจอ (ไม่ใช่ลำดับในไฟล์)
  group?: string;    // กลุ่มคำถามเดิม เก็บไว้ให้ตอนแบ่งชุดตรวจ
  o_ins: string;     // ค่าเดิมตอนโหลด ไว้เทียบว่าแถวไหนถูกแก้
  o_out: string;
  isNew?: boolean;
}

/** แปลงผลจาก API เป็นแถวในตาราง */
export function toRows(examples: (QAPair & { group?: string })[]): Row[] {
  return examples.map((e, i) => ({ ...e, rid: i + 1, o_ins: e.instruction, o_out: e.output }));
}

/** นับแถวที่ถูกแก้/เพิ่ม และหาคำถามที่ซ้ำกัน — แยกเป็นฟังก์ชันเพื่อทดสอบได้ */
export function analyze(rows: Row[], removed: number) {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = r.instruction.trim();
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const outCount = new Map<string, number>();
  for (const r of rows) { const o = r.output.trim(); if (o) outCount.set(o, (outCount.get(o) ?? 0) + 1); }
  const dupOut = new Set([...outCount].filter(([, n]) => n > 8).map(([k]) => k)); // คำตอบเดียวกันเกิน 8 แถว
  const dup = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  const edited = rows.filter((r) => !r.isNew && (r.instruction !== r.o_ins || r.output !== r.o_out)).length;
  const added = rows.filter((r) => r.isNew).length;
  const incomplete = rows.filter((r) => !!r.instruction.trim() !== !!r.output.trim()).length;
  return { dup, dupOut, edited, added, removed, incomplete, dirty: edited + added + removed > 0 };
}

export default function DatasetTableEditor({ id, label, onClose, onSaved }: { id: string; label: string; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [removed, setRemoved] = useState(0);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [quality, setQuality] = useState<DsQuality | null>(null);
  const [saving, setSaving] = useState(false);
  const [nextId, setNextId] = useState(1);

  useEffect(() => {
    api.dsExamples(id).then((r) => { setRows(toRows(r.examples)); setNextId(r.examples.length + 1); }).catch((e) => toast(errText(e), "bad"));
  }, [id]);
  useEffect(() => { api.dsQuality(id).then(setQuality).catch(() => {}); }, [id]);

  const info = useMemo(() => analyze(rows ?? [], removed), [rows, removed]);
  const visible = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (onlyIssues && !(info.dup.has(r.instruction.trim()) || info.dupOut.has(r.output.trim()) || !r.instruction.trim() !== !r.output.trim())) return false;
      return !k || r.instruction.toLowerCase().includes(k) || r.output.toLowerCase().includes(k);
    });
  }, [rows, q, onlyIssues, info]);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const shown = visible.slice(cur * PAGE, (cur + 1) * PAGE);

  function patch(rid: number, p: Partial<Row>) {
    setRows((rs) => (rs ?? []).map((r) => (r.rid === rid ? { ...r, ...p } : r)));
  }
  function del(r: Row) {
    setRows((rs) => (rs ?? []).filter((x) => x.rid !== r.rid));
    if (!r.isNew) setRemoved((n) => n + 1);
  }
  function dupRow(r: Row) {
    setRows((rs) => {
      const list = rs ?? [];
      const i = list.findIndex((x) => x.rid === r.rid);
      const copy: Row = { ...r, rid: nextId, isNew: true, o_ins: "", o_out: "" };
      return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)];
    });
    setNextId((n) => n + 1);
  }
  function addRow() {
    setRows((rs) => [{ rid: nextId, instruction: "", output: "", o_ins: "", o_out: "", isNew: true }, ...(rs ?? [])]);
    setNextId((n) => n + 1);
    setQ(""); setOnlyIssues(false); setPage(0);
  }

  async function save() {
    if (!rows) return;
    if (info.incomplete > 0) { toast(`มี ${info.incomplete} แถวกรอกไม่ครบ (ต้องมีทั้งคำถามและคำตอบ หรือลบแถวทิ้ง)`, "bad"); setOnlyIssues(true); return; }
    setSaving(true);
    try {
      const examples = rows.filter((r) => r.instruction.trim() && r.output.trim()).map(({ instruction, output, input, group }) => ({ instruction, output, input, group }));
      // ตรวจข้อมูลระบุตัวตนเฉพาะแถวที่แก้/เพิ่ม ก่อนบันทึกจริง
      const changed = rows.filter((r) => r.isNew || r.instruction !== r.o_ins || r.output !== r.o_out).map((r) => ({ instruction: r.instruction, output: r.output }));
      if (changed.length) {
        const sc = await api.dsScan(changed);
        if (sc.blocking > 0 && !confirm("แถวที่แก้ดูเหมือนมีข้อมูลระบุตัวตนจริง ยืนยันว่าเป็นข้อมูลสมมติและจะบันทึกต่อ?")) return;
      }
      await api.dsReplace(id, examples, "แก้ไขจากตาราง");
      toast("บันทึกแล้ว (เกิดเวอร์ชันใหม่ ย้อนกลับได้)");
      onSaved();
    } catch (e) { toast(errText(e), "bad"); } finally { setSaving(false); }
  }

  function close() {
    if (info.dirty && !confirm("มีการแก้ไขที่ยังไม่บันทึก ปิดแล้วจะหายทั้งหมด ปิดเลย?")) return;
    onClose();
  }

  return (
    <Modal
      title={`แก้ไขตาราง · ${label}`} onClose={close} wide
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2 w-full">
          <span className="text-xs text-base-400">
            {rows ? `${rows.length} แถว` : ""}{info.edited ? ` · แก้ ${info.edited}` : ""}{info.added ? ` · เพิ่ม ${info.added}` : ""}{info.removed ? ` · ลบ ${info.removed}` : ""}
            {info.dup.size ? ` · คำถามซ้ำ ${info.dup.size} ข้อ` : ""}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={close}>ปิด</Button>
            <Button onClick={save} disabled={saving || !info.dirty}><Save size={14} /> {saving ? "กำลังบันทึก..." : "บันทึกเป็นเวอร์ชันใหม่"}</Button>
          </div>
        </div>
      }
    >
      {!rows ? <Spinner /> : (
        <div className="space-y-3">
          {quality && <div className="border border-base-800 rounded-lg px-3 py-2"><QualityLine q={quality} /></div>}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-500" />
              <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="ค้นหาในคำถามหรือคำตอบ"
                className="w-full bg-base-850 border border-base-800 rounded-lg pl-9 pr-3 py-2 text-sm text-base-100 outline-none focus:border-accent-500" />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-base-300">
              <input type="checkbox" checked={onlyIssues} onChange={(e) => { setOnlyIssues(e.target.checked); setPage(0); }} /> เฉพาะแถวมีปัญหา (คำถามซ้ำ/คำตอบซ้ำเกิน 8 แถว/ไม่ครบ)
            </label>
            <Button variant="secondary" className="text-xs py-1.5" onClick={addRow}><Plus size={13} /> เพิ่มแถว</Button>
          </div>

          <div className="border border-base-800 rounded-lg overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead className="bg-base-850 text-base-400">
                <tr>
                  <th className="w-10 px-2 py-2 text-left font-normal">#</th>
                  <th className="px-2 py-2 text-left font-normal w-[38%]">คำถาม</th>
                  <th className="px-2 py-2 text-left font-normal">คำตอบ</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-base-800">
                {shown.map((r) => {
                  const isDup = info.dup.has(r.instruction.trim());
                  const half = !r.instruction.trim() !== !r.output.trim();
                  const edited = !r.isNew && (r.instruction !== r.o_ins || r.output !== r.o_out);
                  return (
                    <tr key={r.rid} className={r.isNew ? "bg-accent-500/5" : edited ? "bg-amber-400/5" : ""}>
                      <td className="px-2 py-1.5 align-top text-base-500">{r.rid}</td>
                      <td className="px-1 py-1 align-top">
                        <textarea value={r.instruction} rows={Math.min(4, Math.max(2, Math.ceil(r.instruction.length / 28)))} onChange={(e) => patch(r.rid, { instruction: e.target.value })}
                          className={`w-full bg-transparent border rounded px-2 py-1 text-base-100 outline-none resize-y focus:border-accent-500 ${isDup || half ? "border-red-400/60" : "border-transparent hover:border-base-700"}`} />
                        {isDup && <div className="text-[10px] text-red-300 px-2">คำถามซ้ำกับแถวอื่น</div>}
                      </td>
                      <td className="px-1 py-1 align-top">
                        <textarea value={r.output} rows={Math.min(6, Math.max(2, Math.ceil(r.output.length / 60)))} onChange={(e) => patch(r.rid, { output: e.target.value })}
                          className={`w-full bg-transparent border rounded px-2 py-1 text-base-200 outline-none resize-y focus:border-accent-500 ${half ? "border-red-400/60" : "border-transparent hover:border-base-700"}`} />
                      </td>
                      <td className="px-1 py-1.5 align-top whitespace-nowrap">
                        <button title="ทำซ้ำแถวนี้" className="p-1 text-base-500 hover:text-base-100" onClick={() => dupRow(r)}><Copy size={13} /></button>
                        <button title="ลบแถว" className="p-1 text-base-500 hover:text-red-300" onClick={() => del(r)}><Trash2 size={13} /></button>
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-base-500">ไม่พบแถวที่ตรงเงื่อนไข</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-base-400">
            <span>{visible.length} แถว · หน้า {cur + 1}/{pages}</span>
            <div className="flex gap-2">
              <Button variant="secondary" className="text-xs py-1" disabled={cur === 0} onClick={() => setPage(cur - 1)}>ก่อนหน้า</Button>
              <Button variant="secondary" className="text-xs py-1" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>ถัดไป</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
