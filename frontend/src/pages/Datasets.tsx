// ชุดข้อมูลเทรนของเรา: ดูตัวอย่าง ตรวจข้อมูลระบุตัวตน (PII) เพิ่มตัวอย่าง ดู/ย้อนเวอร์ชัน และสร้างจากคลังความรู้
import { useCallback, useEffect, useState } from "react";
import { Database, Plus, ShieldAlert, ShieldCheck, History, Eye, BookOpen, PlusCircle, Table2 } from "lucide-react";
import Topbar from "../components/Topbar";
import { Card } from "../components/Card";
import Button from "../components/Button";
import CustomDatasetDialog from "../components/CustomDatasetDialog";
import FactsBuilderDialog from "../components/FactsBuilderDialog";
import { Empty, Field, Modal, Notice, Pill, Spinner, TextArea, TextInput, fmtDate } from "../components/ui";
import { toast, errText } from "../components/toast";
import { api } from "../api/client";
import type { DatasetOption, DatasetVersion, PiiScan, QAPair } from "../types";

const PII_LABEL: Record<string, string> = { cid: "เลขบัตรประชาชน", hn: "เลข HN", phone: "เบอร์โทร", email: "อีเมล", name: "ชื่อ-นามสกุล (อาจใช่)" };

export default function Datasets() {
  const [items, setItems] = useState<DatasetOption[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [fromKb, setFromKb] = useState(false);
  const [facts, setFacts] = useState(false);
  const [detail, setDetail] = useState<DatasetOption | null>(null);

  const load = useCallback(() => {
    api.datasets().then((d) => setItems(d.filter((x) => x.kind === "custom"))).catch((e) => toast(errText(e), "bad"));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="ชุดข้อมูลเทรน" subtitle="ข้อมูลที่ใช้สอนโมเดล มีเวอร์ชันและตรวจข้อมูลระบุตัวตนให้" />
      <div className="p-4 md:p-8 max-w-5xl space-y-5">
        <Notice tone="info">
          <div>ชุดข้อมูลของโรงพยาบาลต้องไม่มีข้อมูลระบุตัวตนผู้ป่วยจริง (เลขบัตร, HN, เบอร์โทร, อีเมล) ระบบจะสแกนให้ทุกครั้งและบล็อกการเทรนถ้าพบ</div>
        </Notice>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setFacts(true)}><Table2 size={15} /> สร้างจากตารางข้อเท็จจริง (แนะนำ)</Button>
          <Button variant="secondary" onClick={() => setCreating(true)}><Plus size={15} /> สร้างชุดข้อมูลใหม่</Button>
          <Button variant="secondary" onClick={() => setFromKb(true)}><BookOpen size={14} /> สร้างจากคู่ถาม-ตอบในคลังความรู้</Button>
        </div>

        <Card>
          {items === null ? <Spinner /> : items.length === 0 ? (
            <Empty icon={<Database size={32} />} title="ยังไม่มีชุดข้อมูลของเรา" hint="สร้างจากการพิมพ์/ให้ AI ช่วยแปลงข้อความ หรือดึงจากคู่ถาม-ตอบที่เก็บไว้ในคลังความรู้" />
          ) : items.map((d) => (
            <div key={d.id} className="px-4 md:px-5 py-3.5 border-b border-base-800 last:border-0 flex items-center gap-3">
              <Database size={18} className="text-base-500 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{d.label}</div>
                <div className="text-xs text-base-400 truncate">{d.notes}</div>
                <div className="text-[11px] text-base-500 font-mono-log">{d.id}</div>
              </div>
              <Button variant="secondary" className="text-xs py-1.5" onClick={() => setDetail(d)}><Eye size={13} /> เปิด</Button>
            </div>
          ))}
        </Card>
      </div>

      {creating && <CustomDatasetDialog onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {facts && <FactsBuilderDialog onClose={() => setFacts(false)} onDone={() => { setFacts(false); load(); }} />}
      {fromKb && <FromKbDialog onClose={() => setFromKb(false)} onDone={() => { setFromKb(false); load(); }} />}
      {detail && <DetailDialog ds={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

export function PiiSummary({ scan }: { scan: PiiScan }) {
  if (scan.flagged === 0)
    return <Notice tone="good"><div className="flex items-center gap-1.5"><ShieldCheck size={13} /> ไม่พบข้อมูลระบุตัวตนใน {scan.total} ตัวอย่าง</div></Notice>;
  return (
    <Notice tone={scan.blocking > 0 ? "bad" : "warn"}>
      <div className="font-medium flex items-center gap-1.5"><ShieldAlert size={13} /> พบสิ่งที่อาจเป็นข้อมูลระบุตัวตน {scan.flagged} ตัวอย่าง{scan.blocking > 0 && ` (ร้ายแรง ${scan.blocking})`}</div>
      <div>{Object.entries(scan.by_type).map(([k, n]) => `${PII_LABEL[k] ?? k} ${n}`).join(" · ")}</div>
      <div className="space-y-0.5 pt-1">
        {scan.items.slice(0, 5).map((it, i) => (
          <div key={i} className="text-base-300">ตัวอย่างที่ {it.index + 1} ({it.field}): <code>{it.sample}</code></div>
        ))}
        {scan.items.length > 5 && <div className="text-base-400">และอีก {scan.items.length - 5} รายการ</div>}
      </div>
    </Notice>
  );
}

function DetailDialog({ ds, onClose }: { ds: DatasetOption; onClose: () => void }) {
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [preview, setPreview] = useState<{ total: number; examples: QAPair[] } | null>(null);
  const [scan, setScan] = useState<PiiScan | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.dsVersions(ds.id).then(setVersions).catch(() => {});
    api.dsPreview(ds.id).then(setPreview).catch((e) => toast(errText(e), "bad"));
    api.dsScanOne(ds.id).then(setScan).catch(() => {});
  }, [ds.id]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    setBusy(true);
    try {
      const examples = [{ instruction: q.trim(), output: a.trim() }];
      const sc = await api.dsScan(examples);
      if (sc.blocking > 0 && !confirm("ตัวอย่างนี้ดูเหมือนมีข้อมูลระบุตัวตนจริง ยืนยันว่าเป็นข้อมูลสมมติและจะเพิ่มต่อ?")) return;
      await api.dsAppend(ds.id, examples, "เพิ่มจากหน้าเว็บ");
      toast("เพิ่มตัวอย่างแล้ว (เกิดเวอร์ชันใหม่)");
      setAdding(false); setQ(""); setA("");
      load();
    } catch (e) { toast(errText(e), "bad"); } finally { setBusy(false); }
  }

  async function restore(v: DatasetVersion) {
    if (!confirm(`ย้อนกลับไปเวอร์ชัน ${v.version} (${v.count} ตัวอย่าง)? ระบบจะสร้างเป็นเวอร์ชันใหม่ ไม่ลบของเดิม`)) return;
    try { await api.dsRestore(ds.id, v.version); toast("ย้อนกลับแล้ว"); load(); } catch (e) { toast(errText(e), "bad"); }
  }

  return (
    <Modal title={ds.label} onClose={onClose} wide>
      {scan && <PiiSummary scan={scan} />}

      <div className="flex items-center justify-between">
        <div className="text-xs text-base-400">ตัวอย่างล่าสุด ({preview?.total ?? "-"} ทั้งหมด แสดง 20 แรก)</div>
        <Button variant="secondary" className="text-xs py-1.5" onClick={() => setAdding((s) => !s)}><PlusCircle size={13} /> เพิ่มตัวอย่าง</Button>
      </div>
      {adding && (
        <div className="border border-base-800 rounded-lg p-3 space-y-2">
          <Field label="คำถาม / คำสั่ง"><TextInput value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label="คำตอบที่ถูกต้อง"><TextArea rows={4} value={a} onChange={(e) => setA(e.target.value)} /></Field>
          <div className="flex justify-end"><Button onClick={add} disabled={busy || !q.trim() || !a.trim()}>{busy ? "กำลังเพิ่ม..." : "เพิ่ม"}</Button></div>
        </div>
      )}
      {!preview ? <Spinner /> : (
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {preview.examples.map((e, i) => (
            <div key={i} className="border border-base-800 rounded-lg px-3 py-2 text-xs">
              <div className="text-base-100 font-medium">{e.instruction}</div>
              <div className="text-base-300 mt-1 whitespace-pre-wrap">{e.output}</div>
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 text-xs text-base-400 mb-2"><History size={13} /> เวอร์ชัน</div>
        <div className="divide-y divide-base-800 border border-base-800 rounded-lg">
          {versions.map((v, i) => (
            <div key={v.id} className="flex items-center justify-between px-3 py-2 text-xs gap-2">
              <span className="text-base-300 min-w-0">
                v{v.version} · {v.count} ตัวอย่าง · {fmtDate(v.created_at)} {v.note && <span className="text-base-500">· {v.note}</span>}
              </span>
              {i === 0 ? <Pill tone="good">ล่าสุด</Pill> : <button className="text-accent-400 hover:underline shrink-0" onClick={() => restore(v)}>ย้อนกลับมาที่นี่</button>}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function FromKbDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await api.dsFromKb(label.trim()); toast("สร้างชุดข้อมูลแล้ว"); onDone(); } catch (e) { toast(errText(e), "bad"); } finally { setBusy(false); }
  }
  return (
    <Modal title="สร้างจากคลังความรู้" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>ยกเลิก</Button><Button onClick={go} disabled={busy || !label.trim()}>{busy ? "กำลังสร้าง..." : "สร้าง"}</Button></>}>
      <p className="text-xs text-base-400">ดึงเฉพาะเอกสารชนิด "ถาม-ตอบ" ที่เปิดใช้งานอยู่ในคลังความรู้ มาทำเป็นชุดข้อมูลสำหรับเทรน</p>
      <Field label="ชื่อชุดข้อมูล"><TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="เช่น ถาม-ตอบการติดตามหลังจำหน่าย ต.ค." /></Field>
    </Modal>
  );
}
