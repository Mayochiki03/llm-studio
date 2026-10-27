// ทะเบียนโมเดล: ทุกโมเดลที่สร้างจะเข้ามาเป็น "รอตรวจ" → ทดสอบ → อนุมัติ → ใช้งานจริง (ทีละตัว) ย้อนกลับได้
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, CheckCircle2, Rocket, Archive, RotateCcw, Trash2, FlaskConical, Plus, StickyNote, History, IdCard } from "lucide-react";
import Topbar from "../components/Topbar";
import { Card } from "../components/Card";
import Button from "../components/Button";
import { Empty, Field, Modal, Notice, Pill, Spinner, TextArea, TextInput, fmtDate, pct, timeAgo, type Tone } from "../components/ui";
import { toast, errText } from "../components/toast";
import { api } from "../api/client";
import type { ModelEvent, ModelVersion } from "../types";
import ModelCardDialog from "../components/ModelCardDialog";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  candidate: { label: "รอตรวจ", tone: "mute" },
  approved: { label: "อนุมัติแล้ว", tone: "info" },
  active: { label: "ใช้งานจริง", tone: "good" },
  archived: { label: "เก็บถาวร", tone: "warn" },
};

/** แปลงรายละเอียดเหตุการณ์ทดสอบ (JSON ดิบ) เป็นข้อความอ่านง่าย; เหตุการณ์อื่นแสดงตามเดิม */
export function fmtEventDetail(event: string, detail: string): string {
  if (event !== "eval") return detail;
  try {
    const d = JSON.parse(detail) as { pass_rate?: number | null; red_flag_recall?: number | null };
    const pct = (x?: number | null) => (x == null ? "ไม่มีข้อมูล" : `${Math.round(x * 100)}%`);
    return `ผ่านเกณฑ์ ${pct(d.pass_rate)} · จับ red flag ได้ ${pct(d.red_flag_recall)}`;
  } catch {
    return detail;
  }
}

export default function Registry() {
  const [list, setList] = useState<ModelVersion[] | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [notesFor, setNotesFor] = useState<ModelVersion | null>(null);
  const [eventsFor, setEventsFor] = useState<ModelVersion | null>(null);
  const [cardFor, setCardFor] = useState<ModelVersion | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(() => api.registry().then(setList).catch((e) => toast(errText(e), "bad")), []);
  useEffect(() => { load(); }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast(ok);
      await load();
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy("");
    }
  }

  const active = list?.find((v) => v.status === "active");
  const shown = (list ?? []).filter((v) => showArchived || v.status !== "archived");

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="โมเดลที่ใช้งานจริง" subtitle="เลือกว่าโมเดลตัวไหนให้ระบบอื่นเรียกใช้ ต้องผ่านการตรวจก่อน และย้อนกลับได้ทุกเมื่อ" />
      <div className="p-4 md:p-8 space-y-5 max-w-5xl">
        <Card className="p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-lg bg-good/15 flex items-center justify-center shrink-0"><ShieldCheck size={18} className="text-good" /></div>
              <div className="min-w-0">
                <div className="text-xs text-base-400">โมเดลที่ใช้งานจริงตอนนี้</div>
                <div className="text-sm font-medium truncate">{active ? active.name : "ยังไม่มี"}</div>
                {active && <div className="text-[11px] text-base-500">เปิดใช้ {timeAgo(active.activated_at)} · ระบบอื่นเรียก <code>/api/registry/active</code> เพื่อรู้ชื่อโมเดลนี้</div>}
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button variant="secondary" disabled={!!busy} onClick={() => confirm("ย้อนกลับไปใช้โมเดลที่ใช้ก่อนหน้า?") && run("rb", api.registryRollback, "ย้อนกลับแล้ว")}>
                <RotateCcw size={14} /> ย้อนกลับเวอร์ชันก่อนหน้า
              </Button>
              <Button variant="secondary" onClick={() => setAdding(true)}><Plus size={14} /> เพิ่มโมเดลเอง</Button>
            </div>
          </div>
        </Card>

        <Notice tone="info">
          <div>ลำดับที่แนะนำ: รันทดสอบ (ใช้โจทย์ที่ตรึงไว้ในหน้า "ทดสอบและเปรียบเทียบ") → ดูผล → อนุมัติ → เปิดใช้งานจริง</div>
          <div className="text-base-400">โมเดลที่ยังไม่อนุมัติจะเปิดใช้งานจริงไม่ได้ เพื่อกันเผลอปล่อยโมเดลที่ยังไม่ผ่านการตรวจ</div>
        </Notice>

        <label className="flex items-center gap-2 text-xs text-base-400 cursor-pointer w-fit">
          <input type="checkbox" className="accent-accent-500" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> แสดงที่เก็บถาวร
        </label>

        {list === null ? <Spinner /> : shown.length === 0 ? (
          <Card><Empty icon={<ShieldCheck size={32} />} title="ยังไม่มีโมเดลในรายการนี้"
            hint="โมเดลที่สร้างเข้า Ollama จากหน้างานเทรนจะมาลงทะเบียนที่นี่เอง หรือกด 'เพิ่มโมเดลเอง' สำหรับโมเดลที่มีอยู่แล้ว" /></Card>
        ) : (
          <div className="space-y-3">
            {shown.map((v) => {
              const st = STATUS[v.status] ?? STATUS.candidate;
              const ev = v.eval ?? {};
              const hasEval = ev.count !== undefined;
              return (
                <Card key={v.id} className="p-4 md:p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold break-all">{v.name}</span>
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </div>
                  <div className="text-[11px] text-base-500 mt-1 flex flex-wrap gap-x-3">
                    {v.base_model && <span>ฐาน: {v.base_model.split("/").pop()}</span>}
                    {v.dataset_id && <span>ข้อมูล: {v.dataset_id}{v.dataset_version ? ` v${v.dataset_version}` : ""}</span>}
                    <span>สร้าง {fmtDate(v.created_at)}</span>
                    {v.approved_at && <span>อนุมัติ {fmtDate(v.approved_at)}</span>}
                  </div>
                  {v.notes && <p className="text-xs text-base-300 mt-2 whitespace-pre-wrap">{v.notes}</p>}

                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Metric label="ผ่านเกณฑ์" value={hasEval ? pct(ev.pass_rate) : "-"} />
                    <Metric label="จับ red flag ได้" value={hasEval ? pct(ev.red_flag_recall) : "-"} warn={hasEval && ev.red_flag_recall !== null && ev.red_flag_recall !== undefined && ev.red_flag_recall < 1} />
                    <Metric label="เวลาตอบเฉลี่ย" value={hasEval && ev.avg_latency_s ? `${ev.avg_latency_s} วิ` : "-"} />
                    <Metric label="ความเร็ว" value={hasEval && ev.avg_tokens_per_s ? `${ev.avg_tokens_per_s} tok/s` : "-"} />
                  </div>
                  {!hasEval && v.status !== "archived" && <p className="text-[11px] text-base-500 mt-2">ยังไม่เคยทดสอบ</p>}
                  {hasEval && ev.red_flag_recall !== null && ev.red_flag_recall !== undefined && ev.red_flag_recall < 1 && (
                    <div className="mt-2"><Notice tone="warn">พลาดเคสสำคัญ (red flag) บางข้อ ดูรายละเอียดในหน้าทดสอบก่อนอนุมัติ</Notice></div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {v.status !== "archived" && (
                      <Button variant="secondary" className="text-xs py-1.5" disabled={!!busy} onClick={() => run("e" + v.id, () => api.registryEval(v.id), "ทดสอบเสร็จแล้ว")}>
                        <FlaskConical size={13} /> {busy === "e" + v.id ? "กำลังทดสอบ..." : "รันทดสอบ"}
                      </Button>
                    )}
                    {v.status === "candidate" && (
                      <Button className="text-xs py-1.5" disabled={!!busy} onClick={() => run("a" + v.id, () => api.registryApprove(v.id), "อนุมัติแล้ว")}><CheckCircle2 size={13} /> อนุมัติ</Button>
                    )}
                    {v.status === "approved" && (
                      <Button className="text-xs py-1.5" disabled={!!busy}
                        onClick={() => confirm(`เปิดใช้ "${v.name}" เป็นโมเดลใช้งานจริง? ตัวที่ใช้อยู่จะถูกแทนที่ (ย้อนกลับได้)`) && run("c" + v.id, () => api.registryActivate(v.id), "เปิดใช้งานจริงแล้ว")}>
                        <Rocket size={13} /> เปิดใช้งานจริง
                      </Button>
                    )}
                    <Button variant="ghost" className="text-xs py-1.5" onClick={() => setCardFor(v)}><IdCard size={13} /> การ์ดโมเดล</Button>
                    <Button variant="ghost" className="text-xs py-1.5" onClick={() => setNotesFor(v)}><StickyNote size={13} /> บันทึก</Button>
                    <Button variant="ghost" className="text-xs py-1.5" onClick={() => setEventsFor(v)}><History size={13} /> ประวัติ</Button>
                    {v.status !== "active" && v.status !== "archived" && (
                      <Button variant="ghost" className="text-xs py-1.5" disabled={!!busy} onClick={() => run("r" + v.id, () => api.registryArchive(v.id), "เก็บถาวรแล้ว")}><Archive size={13} /> เก็บถาวร</Button>
                    )}
                    {v.status !== "active" && (
                      <Button variant="ghost" className="text-xs py-1.5 hover:text-bad" disabled={!!busy}
                        onClick={() => confirm("ลบออกจากรายการนี้? (ไม่ลบโมเดลใน Ollama)") && run("d" + v.id, () => api.registryDelete(v.id), "ลบแล้ว")}><Trash2 size={13} /> ลบ</Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {adding && <AddDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {notesFor && <NotesDialog v={notesFor} onClose={() => setNotesFor(null)} onDone={() => { setNotesFor(null); load(); }} />}
      {cardFor && <ModelCardDialog v={cardFor} onClose={() => setCardFor(null)} />}
      {eventsFor && <EventsDialog v={eventsFor} onClose={() => setEventsFor(null)} />}
    </div>
  );
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="bg-base-850 rounded-lg px-3 py-2">
      <div className="text-[11px] text-base-500">{label}</div>
      <div className={`text-sm font-medium ${warn ? "text-warn" : ""}`}>{value}</div>
    </div>
  );
}

function AddDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [models, setModels] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => { api.ollamaModels().then((r) => setModels((r.models ?? []).map((m) => m.name))).catch(() => {}); }, []);
  async function save() {
    try {
      await api.registryAdd(name.trim(), "", notes);
      toast("เพิ่มโมเดลแล้ว");
      onDone();
    } catch (e) { toast(errText(e), "bad"); }
  }
  return (
    <Modal title="เพิ่มโมเดลเข้ารายการ" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>ยกเลิก</Button><Button onClick={save} disabled={!name.trim()}>เพิ่ม</Button></>}>
      <Field label="ชื่อโมเดลใน Ollama" hint="เลือกจากรายการหรือพิมพ์เอง">
        <TextInput list="ollama-names" value={name} onChange={(e) => setName(e.target.value)} />
        <datalist id="ollama-names">{models.map((m) => <option key={m} value={m} />)}</datalist>
      </Field>
      <Field label="บันทึก (ไม่บังคับ)"><TextArea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </Modal>
  );
}

function NotesDialog({ v, onClose, onDone }: { v: ModelVersion; onClose: () => void; onDone: () => void }) {
  const [notes, setNotes] = useState(v.notes);
  async function save() {
    try { await api.registryNotes(v.id, notes); toast("บันทึกแล้ว"); onDone(); } catch (e) { toast(errText(e), "bad"); }
  }
  return (
    <Modal title={`บันทึกของ ${v.name}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>ยกเลิก</Button><Button onClick={save}>บันทึก</Button></>}>
      <TextArea rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="เช่น เทรนด้วยข้อมูลรอบเดือนตุลา แก้ปัญหาตอบเบอร์ฉุกเฉินผิด" />
    </Modal>
  );
}

const EVENT_LABEL: Record<string, string> = {
  register: "เพิ่มเข้ารายการ", approve: "อนุมัติ", activate: "เปิดใช้งานจริง", archive: "เก็บถาวร", rollback: "ย้อนกลับ", eval: "ทดสอบ", notes: "แก้บันทึก",
};

function EventsDialog({ v, onClose }: { v: ModelVersion; onClose: () => void }) {
  const [ev, setEv] = useState<ModelEvent[] | null>(null);
  useEffect(() => { api.registryEvents(v.id).then(setEv).catch((e) => toast(errText(e), "bad")); }, [v.id]);
  return (
    <Modal title={`ประวัติของ ${v.name}`} onClose={onClose}>
      {ev === null ? <Spinner /> : ev.length === 0 ? <p className="text-sm text-base-500">ยังไม่มีเหตุการณ์</p> : (
        <div className="divide-y divide-base-800">
          {ev.map((e) => (
            <div key={e.id} className="py-2 text-xs flex justify-between gap-3">
              <span className="text-base-200">{EVENT_LABEL[e.event] ?? e.event}{e.detail ? ` · ${fmtEventDetail(e.event, e.detail)}` : ""}</span>
              <span className="text-base-500 shrink-0">{fmtDate(e.ts)}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
