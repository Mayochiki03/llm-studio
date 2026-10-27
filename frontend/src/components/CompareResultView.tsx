// แสดงผลเปรียบเทียบ (0.8.4): สรุปรวม → วิเคราะห์ว่าพลาดเพราะอะไร → เฉพาะข้อที่พลาดก่อน (ข้อที่ผ่านพับไว้) + ปุ่มส่งออก/ร่างข้อมูลสอน
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, XCircle, Siren, Download, Copy, Wand2, ChevronDown, ChevronRight, Lightbulb, BookOpen, ShieldCheck } from "lucide-react";
import Button from "./Button";
import { Notice, Pill, pct } from "./ui";
import { toast, errText } from "./toast";
import { api, downloadFile } from "../api/client";
import { saveFactsDraft } from "../lib/factsDraft";
import type { CompareAnalysis, CompareResult, CompareRow } from "../types";

const rowFailed = (row: CompareRow, models: string[]) => models.some((m) => row.answers[m]?.passed === false);

/** แถวที่ต้องดูก่อน: แถวที่มีโมเดลพลาด (เรียง red flag ก่อน) / แถวที่ผ่านหมด แยกไว้พับ */
export function splitRows(res: CompareResult): { failed: CompareRow[]; passed: CompareRow[] } {
  const failed = res.rows.filter((r) => rowFailed(r, res.models)).sort((a, b) => Number(!!b.red_flag) - Number(!!a.red_flag));
  const passed = res.rows.filter((r) => !rowFailed(r, res.models));
  return { failed, passed };
}

function AnswerBox({ m, row }: { m: string; row: CompareRow }) {
  const a = row.answers[m];
  if (!a) return null;
  return (
    <div className="bg-base-850 rounded-lg p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-base-400 break-all">{m}</span>
        {a.passed === null ? <Pill>ไม่มีเกณฑ์</Pill> : a.passed ? <Pill tone="good"><CheckCircle2 size={11} className="mr-1" />ผ่าน</Pill> : <Pill tone="bad"><XCircle size={11} className="mr-1" />ไม่ผ่าน</Pill>}
      </div>
      <div className="text-xs text-base-200 whitespace-pre-wrap">{a.response}</div>
      {a.guard && <div className="text-[11px] text-accent-300 flex items-center gap-1"><ShieldCheck size={11} /> ตอบตามขอบเขต ({a.guard}){a.guard === "unverified_number" ? " แก้เลขที่ไม่ตรงเอกสาร" : " ไม่ผ่านโมเดล"}</div>}
      {a.missing.length > 0 && <div className="text-[11px] text-bad">ขาด: {a.missing.join(", ")}</div>}
      {a.violated.length > 0 && <div className="text-[11px] text-bad">มีสิ่งที่ห้ามมี: {a.violated.join(", ")}</div>}
      {a.sources && a.sources.length > 0 && <div className="text-[11px] text-base-500 flex items-center gap-1 break-all"><BookOpen size={11} /> ดึงจาก: {a.sources.join(", ")}{typeof a.top_score === "number" && <span className="ml-1 text-base-400">· คะแนนสูงสุด {a.top_score}</span>}</div>}
      {a.reply_original && <div className="text-[11px] text-warn break-words">โมเดลตอบเดิม (ถูกแก้เพราะเลขไม่ตรงเอกสาร): {a.reply_original}</div>}
    </div>
  );
}

function RowCard({ row, models }: { row: CompareRow; models: string[] }) {
  return (
    <div className="border border-base-800 rounded-lg p-3.5 space-y-2">
      <div className="flex items-center gap-2 text-sm flex-wrap">
        {row.red_flag && <Siren size={14} className="text-bad shrink-0" />}
        <span className="text-base-100">{row.prompt_text}</span>
        {row.category && <span className="text-[10px] text-base-500 border border-base-700 rounded px-1.5 py-0.5">{row.category}</span>}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{models.map((m) => <AnswerBox key={m} m={m} row={row} />)}</div>
    </div>
  );
}

export default function CompareResultView({ jobId, res }: { jobId: string; res: CompareResult }) {
  const nav = useNavigate();
  const [analysis, setAnalysis] = useState<CompareAnalysis | null>(null);
  const [showPassed, setShowPassed] = useState(false);
  const [draftBusy, setDraftBusy] = useState("");
  const { failed, passed } = useMemo(() => splitRows(res), [res]);

  useEffect(() => {
    setAnalysis(null);
    api.compareAnalysis(jobId).then(setAnalysis).catch(() => {});
  }, [jobId]);

  async function copyFailed() {
    try { await navigator.clipboard.writeText(await api.compareFailedText(jobId)); toast("คัดลอกข้อที่พลาดแล้ว แปะส่งต่อได้เลย"); } catch (e) { toast(errText(e), "bad"); }
  }
  async function dl(fmt: "csv" | "json") {
    try { await downloadFile(`/eval/compare/jobs/${jobId}/export?format=${fmt}`, `compare-${jobId}.${fmt}`); } catch (e) { toast(errText(e), "bad"); }
  }
  async function makeDraft(model: string) {
    setDraftBusy(model);
    try {
      const d = await api.compareDrafts(jobId, model);
      if (d.facts.length === 0 && d.oos.length === 0) { toast("ไม่มีข้อที่ร่างอัตโนมัติได้ (เคสอันตรายต้องแก้ที่กฎขอบเขตเอง)"); return; }
      if (!saveFactsDraft(d)) { toast("เบราว์เซอร์ไม่ให้เก็บข้อมูลชั่วคราว ส่งร่างต่อไม่ได้", "bad"); return; }
      toast(`ร่าง ${d.facts.length} เรื่อง + นอกขอบเขต ${d.oos.length} ข้อ เปิดตารางข้อเท็จจริงให้ตรวจ`);
      nav("/datasets");
    } catch (e) { toast(errText(e), "bad"); } finally { setDraftBusy(""); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={res.use_kb ? "good" : "mute"}>{res.use_kb ? "ทดสอบแบบมีคลังความรู้" : "ทดสอบแบบไม่มีคลังความรู้"}</Pill>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="secondary" className="text-xs py-1.5" onClick={copyFailed}><Copy size={13} /> คัดลอกเฉพาะข้อที่พลาด</Button>
          <Button variant="secondary" className="text-xs py-1.5" onClick={() => dl("csv")}><Download size={13} /> CSV (Excel)</Button>
          <Button variant="secondary" className="text-xs py-1.5" onClick={() => dl("json")}><Download size={13} /> JSON</Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-base-400 border-b border-base-800">
              <th className="py-2 pr-3 font-medium">โมเดล</th><th className="py-2 pr-3 font-medium">ผ่านเกณฑ์</th>
              <th className="py-2 pr-3 font-medium">จับ red flag</th><th className="py-2 pr-3 font-medium">เวลาตอบ</th><th className="py-2 font-medium">ความเร็ว</th>
            </tr>
          </thead>
          <tbody>
            {res.models.map((m) => {
              const s = res.summaries[m];
              return (
                <tr key={m} className="border-b border-base-800 last:border-0">
                  <td className="py-2 pr-3 text-base-100 break-all">{m}</td>
                  <td className="py-2 pr-3">{pct(s?.pass_rate)}</td>
                  <td className="py-2 pr-3">{pct(s?.red_flag_recall)}</td>
                  <td className="py-2 pr-3">{s?.avg_latency_s ? `${s.avg_latency_s} วิ` : "-"}</td>
                  <td className="py-2">{s?.avg_tokens_per_s ? `${s.avg_tokens_per_s} tok/s` : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {analysis && (
        <div className="rounded-lg border border-base-800 p-3.5 space-y-3">
          <div className="flex items-center gap-2 text-sm text-base-100"><Lightbulb size={15} className="text-warn" /> พลาดเพราะอะไร และควรทำอะไรต่อ</div>
          {res.models.map((m) => {
            const a = analysis.models[m];
            if (!a) return null;
            return (
              <div key={m} className="space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-base-200 break-all">{m}</span>
                  <Pill tone={a.failed ? "warn" : "good"}>{a.failed ? `พลาด ${a.failed} ข้อ` : "ไม่พลาดเลย"}</Pill>
                  {a.failed > 0 && (
                    <Button variant="ghost" className="text-[11px] py-1 ml-auto" disabled={!!draftBusy} onClick={() => makeDraft(m)}>
                      <Wand2 size={12} /> {draftBusy === m ? "กำลังร่าง..." : "ร่างข้อมูลสอนจากข้อที่พลาด"}
                    </Button>
                  )}
                </div>
                {a.groups.map((g) => (
                  <div key={g.kind} className="text-xs pl-3 border-l-2 border-base-700">
                    <span className="text-base-100">{g.label} {g.count} ข้อ</span>
                    <span className="text-base-400"> — {g.advice}</span>
                  </div>
                ))}
              </div>
            );
          })}
          {analysis.differences.length > 0 && res.models.length >= 2 && (
            <div className="text-xs text-base-400">ข้อที่สองโมเดลต่างกัน {analysis.differences.length} ข้อ ({res.models[0]} ชนะ {analysis.differences.filter((d) => d.winner === res.models[0]).length}, {res.models[1]} ชนะ {analysis.differences.filter((d) => d.winner === res.models[1]).length})</div>
          )}
          <div className="text-[11px] text-base-500">การวิเคราะห์เป็นกฎคำนวณในเครื่อง ไม่ส่งข้อมูลออกนอก ใช้เป็นแนวทาง ควรเปิดคำตอบจริงตรวจก่อนแก้ข้อมูล</div>
        </div>
      )}

      {failed.length === 0 ? <Notice tone="good">ทุกข้อผ่านทั้งหมด</Notice> : (
        <div className="space-y-3">
          <div className="text-xs text-base-400">ข้อที่มีโมเดลพลาด {failed.length} ข้อ (เคสอันตรายขึ้นก่อน)</div>
          {failed.map((r) => <RowCard key={r.prompt_id} row={r} models={res.models} />)}
        </div>
      )}
      {passed.length > 0 && (
        <div>
          <button onClick={() => setShowPassed((v) => !v)} className="flex items-center gap-1.5 text-xs text-base-400 hover:text-base-200">
            {showPassed ? <ChevronDown size={14} /> : <ChevronRight size={14} />} ข้อที่ผ่านทุกโมเดล {passed.length} ข้อ
          </button>
          {showPassed && <div className="space-y-3 mt-3">{passed.map((r) => <RowCard key={r.prompt_id} row={r} models={res.models} />)}</div>}
        </div>
      )}
    </div>
  );
}
