// เปรียบเทียบหลายโมเดลด้วยชุดโจทย์เดียวกัน (0.8.4): รันเป็นงานเบื้องหลังที่ backend
// กดแล้วเปลี่ยนหน้า/ปิดเบราว์เซอร์ได้ กลับมาจะต่อจากเดิมอัตโนมัติ (จำเลขงานและตัวเลือกไว้ใน localStorage) และดูย้อนหลังได้จากรายการประวัติ
import { useCallback, useEffect, useRef, useState } from "react";
import { GitCompare, Square, History, Eye } from "lucide-react";
import { Card, CardHeader } from "./Card";
import Button from "./Button";
import CompareResultView from "./CompareResultView";
import { Notice, Pill, fmtDate } from "./ui";
import { toast, errText } from "./toast";
import { api } from "../api/client";
import type { CompareJob } from "../types";

const KEY = "llmstudio.compare.v1";
interface Saved { picked: string[]; pinnedOnly: boolean; useKb: boolean; jobId: string }

function loadSaved(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (s && Array.isArray(s.picked)) return { picked: s.picked, pinnedOnly: s.pinnedOnly !== false, useKb: !!s.useKb, jobId: String(s.jobId ?? "") };
  } catch { /* ไม่มีที่เก็บ/ข้อมูลเสีย ใช้ค่าเริ่มต้น */ }
  return { picked: [], pinnedOnly: true, useKb: false, jobId: "" };
}

const STATUS: Record<string, { label: string; tone: "good" | "warn" | "bad" | "info" | "mute" }> = {
  running: { label: "กำลังรัน", tone: "info" }, done: { label: "เสร็จ", tone: "good" }, error: { label: "ผิดพลาด", tone: "bad" },
  cancelled: { label: "หยุดแล้ว", tone: "warn" }, interrupted: { label: "ถูกตัดกลางทาง", tone: "warn" },
};

/** ข้อความความคืบหน้าอ่านง่าย */
export function progressText(j: Pick<CompareJob, "progress">): string {
  const p = j.progress;
  if (!p) return "";
  return `โมเดลที่ ${p.model_index + 1}/${p.models_total} (${p.model}) · ข้อ ${p.done}/${p.total}`;
}

export default function EvalCompare({ models, selectedPromptIds }: { models: string[]; selectedPromptIds: Set<string> }) {
  const init = useRef(loadSaved()).current;
  const [picked, setPicked] = useState<Set<string>>(new Set(init.picked));
  const [pinnedOnly, setPinnedOnly] = useState(init.pinnedOnly);
  const [useKb, setUseKb] = useState(init.useKb);
  const [jobId, setJobId] = useState(init.jobId);
  const [job, setJob] = useState<CompareJob | null>(null);
  const [history, setHistory] = useState<CompareJob[]>([]);
  const [starting, setStarting] = useState(false);

  // จำตัวเลือก + งานล่าสุด ให้กลับมาหน้านี้แล้วอยู่ที่เดิม
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ picked: Array.from(picked), pinnedOnly, useKb, jobId })); } catch { /* ข้าม */ }
  }, [picked, pinnedOnly, useKb, jobId]);

  const loadHistory = useCallback(() => { api.compareJobs().then((h) => setHistory(h.slice(0, 8))).catch(() => {}); }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // เปิดหน้ามาแล้วมีงานค้างอยู่ → โหลดและติดตามต่อ; ระหว่างรันถามความคืบหน้าทุก 2 วินาที
  useEffect(() => {
    if (!jobId) { setJob(null); return; }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const j = await api.compareJob(jobId);
        if (stop) return;
        setJob(j);
        if (j.status === "running") timer = setTimeout(tick, 2000);
        else loadHistory();
      } catch {
        if (!stop) { setJob(null); setJobId(""); }   // งานถูกลบ/ไม่พบ
      }
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [jobId, loadHistory]);

  const toggle = (m: string) =>
    setPicked((p) => { const n = new Set(p); n.has(m) ? n.delete(m) : n.add(m); return n; });

  async function run() {
    setStarting(true);
    try {
      // pinnedOnly = ใช้เฉพาะโจทย์ที่ตรึง/red flag; ปิด = ใช้โจทย์ที่ติ๊กเลือกไว้ด้านบน
      const r = await api.compareStart(Array.from(picked), pinnedOnly, pinnedOnly ? [] : Array.from(selectedPromptIds), useKb);
      setJob(null);
      setJobId(r.id);
      toast("เริ่มเปรียบเทียบแล้ว เปลี่ยนหน้าได้ ผลจะรออยู่ที่นี่");
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setStarting(false);
    }
  }
  async function stop() {
    if (!jobId) return;
    try { await api.compareCancel(jobId); toast("สั่งหยุดแล้ว (หยุดหลังข้อที่กำลังตอบ)"); } catch (e) { toast(errText(e), "bad"); }
  }

  const running = job?.status === "running";
  const pct = job?.progress ? Math.round(((job.progress.model_index * job.progress.total + job.progress.done) / Math.max(1, job.progress.models_total * job.progress.total)) * 100) : 0;

  return (
    <Card>
      <CardHeader title="เปรียบเทียบหลายโมเดล" subtitle="เหมาะตอนเทียบโมเดลเก่ากับโมเดลที่เพิ่งเทรนก่อนตัดสินใจอนุมัติ" />
      <div className="px-5 pb-5 space-y-4">
        <div className="flex flex-wrap gap-2">
          {models.length === 0 && <span className="text-xs text-base-500">ไม่พบโมเดลใน Ollama</span>}
          {models.map((m) => (
            <button key={m} onClick={() => toggle(m)}
              className={`px-3 py-1.5 rounded-lg text-xs border ${picked.has(m) ? "border-accent-500 bg-accent-500/10 text-base-100" : "border-base-700 text-base-400 hover:border-base-600"}`}>
              {m}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-base-300 cursor-pointer">
          <input type="checkbox" className="accent-accent-500" checked={pinnedOnly} onChange={(e) => setPinnedOnly(e.target.checked)} />
          ใช้เฉพาะโจทย์ที่ตรึงไว้และเคส red flag (ปิด = ใช้โจทย์ที่ติ๊กเลือกด้านบน {selectedPromptIds.size} ข้อ)
        </label>
        <label className="flex items-center gap-2 text-xs text-base-300 cursor-pointer">
          <input type="checkbox" className="accent-accent-500" checked={useKb} onChange={(e) => setUseKb(e.target.checked)} />
          ทดสอบแบบมีคลังความรู้และขอบเขต (เหมือนใช้งานจริง) — วัดผลที่ผู้ใช้เห็นจริง ไม่ใช่แค่ความจำของโมเดล
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={run} disabled={starting || running || picked.size < 2}>
            <GitCompare size={15} /> {running ? "กำลังเปรียบเทียบ..." : `เปรียบเทียบ ${picked.size} โมเดล`}
          </Button>
          {running && <Button variant="secondary" onClick={stop}><Square size={14} /> หยุด</Button>}
        </div>
        {picked.size < 2 && !running && <p className="text-[11px] text-base-500">เลือกอย่างน้อย 2 โมเดล</p>}

        {job && running && (
          <div className="space-y-1.5">
            <div className="h-2 rounded-full bg-base-800 overflow-hidden"><div className="h-full bg-accent-500 transition-all" style={{ width: `${pct}%` }} /></div>
            <div className="text-xs text-base-300">{progressText(job)} ({pct}%) · เปลี่ยนหน้าได้ งานรันต่อที่ backend</div>
          </div>
        )}
        {job && job.status === "error" && <Notice tone="bad">เปรียบเทียบผิดพลาด: {job.error}{job.result ? " (แสดงผลบางส่วนด้านล่าง)" : ""}</Notice>}
        {job && job.status === "interrupted" && <Notice tone="warn">งานนี้ถูกตัดกลางทางเพราะ backend ถูกปิด ผลที่ทำเสร็จก่อนหน้าอยู่ในประวัติการทดสอบของแต่ละโมเดล รันใหม่ได้</Notice>}
        {job && job.status === "cancelled" && <Notice tone="warn">หยุดกลางทาง แสดงเฉพาะข้อที่ทำเสร็จแล้ว</Notice>}

        {job?.result && <CompareResultView jobId={job.id} res={job.result} />}

        {history.length > 0 && (
          <div className="pt-2 border-t border-base-800">
            <div className="flex items-center gap-1.5 text-xs text-base-400 mb-2"><History size={13} /> ประวัติการเปรียบเทียบล่าสุด</div>
            <div className="space-y-1.5">
              {history.map((h) => (
                <div key={h.id} className={`flex items-center gap-2 text-xs rounded-lg px-3 py-2 ${h.id === jobId ? "bg-base-800" : "bg-base-900/60"}`}>
                  <span className="text-base-500 shrink-0">{fmtDate(h.created_at)}</span>
                  <span className="text-base-200 truncate">{h.models.join(" vs ")}</span>
                  <span className="text-base-500 shrink-0">{h.n_prompts} ข้อ{h.use_kb ? " · มีคลัง" : ""}</span>
                  <span className="ml-auto shrink-0"><Pill tone={STATUS[h.status]?.tone ?? "mute"}>{STATUS[h.status]?.label ?? h.status}</Pill></span>
                  <button className="shrink-0 text-base-400 hover:text-base-100" title="เปิดดู" onClick={() => setJobId(h.id)}><Eye size={14} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
