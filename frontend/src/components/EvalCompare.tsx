// เปรียบเทียบหลายโมเดลด้วยชุดโจทย์เดียวกัน: ตารางสรุป + คำตอบเรียงข้างกัน (รันทีละโมเดลเพื่อไม่ให้ VRAM เต็ม)
import { useState } from "react";
import { GitCompare, CheckCircle2, XCircle, Siren } from "lucide-react";
import { Card, CardHeader } from "./Card";
import Button from "./Button";
import { Pill, pct } from "./ui";
import { toast, errText } from "./toast";
import { api } from "../api/client";
import type { CompareResult } from "../types";

export default function EvalCompare({ models, selectedPromptIds }: { models: string[]; selectedPromptIds: Set<string> }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pinnedOnly, setPinnedOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<CompareResult | null>(null);

  const toggle = (m: string) =>
    setPicked((p) => {
      const n = new Set(p);
      n.has(m) ? n.delete(m) : n.add(m);
      return n;
    });

  async function run() {
    setBusy(true);
    setRes(null);
    try {
      // pinnedOnly = ใช้เฉพาะโจทย์ที่ตรึง/red flag; ปิด = ใช้โจทย์ที่ติ๊กเลือกไว้ด้านบน
      setRes(await api.compare(Array.from(picked), pinnedOnly, pinnedOnly ? [] : Array.from(selectedPromptIds)));
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

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
        <Button onClick={run} disabled={busy || picked.size < 2}>
          <GitCompare size={15} /> {busy ? "กำลังเปรียบเทียบ (อาจใช้เวลาหลายนาที)..." : `เปรียบเทียบ ${picked.size} โมเดล`}
        </Button>
        {picked.size < 2 && <p className="text-[11px] text-base-500">เลือกอย่างน้อย 2 โมเดล</p>}

        {res && (
          <div className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-base-400 border-b border-base-800">
                    <th className="py-2 pr-3 font-medium">โมเดล</th>
                    <th className="py-2 pr-3 font-medium">ผ่านเกณฑ์</th>
                    <th className="py-2 pr-3 font-medium">จับ red flag</th>
                    <th className="py-2 pr-3 font-medium">เวลาตอบ</th>
                    <th className="py-2 font-medium">ความเร็ว</th>
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

            {res.rows.map((row) => (
              <div key={row.prompt_id} className="border border-base-800 rounded-lg p-3.5 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  {row.red_flag && <Siren size={14} className="text-bad shrink-0" />}
                  <span className="text-base-100">{row.prompt_text}</span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {res.models.map((m) => {
                    const a = row.answers[m];
                    if (!a) return null;
                    return (
                      <div key={m} className="bg-base-850 rounded-lg p-3 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-base-400 break-all">{m}</span>
                          {a.passed === null ? <Pill>ไม่มีเกณฑ์</Pill> : a.passed ? <Pill tone="good"><CheckCircle2 size={11} className="mr-1" />ผ่าน</Pill> : <Pill tone="bad"><XCircle size={11} className="mr-1" />ไม่ผ่าน</Pill>}
                        </div>
                        <div className="text-xs text-base-200 whitespace-pre-wrap">{a.response}</div>
                        {a.missing.length > 0 && <div className="text-[11px] text-bad">ขาด: {a.missing.join(", ")}</div>}
                        {a.violated.length > 0 && <div className="text-[11px] text-bad">มีสิ่งที่ห้ามมี: {a.violated.join(", ")}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
