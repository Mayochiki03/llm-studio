// แผงดูสถานะเครื่องแบบเรียลไทม์ระหว่างเทรน: ความคืบหน้า + เวลาที่เหลือ, VRAM/การ์ด/อุณหภูมิ (มีกราฟย้อนหลัง), CPU/RAM/เครือข่าย
// ดึงจาก /system/gpu-live ทุก 3 วินาทีเฉพาะตอน active=true (เบา: nvidia-smi + psutil); อ่านไม่ได้ก็ซ่อนไปเฉยๆ ไม่กระทบงานเทรน
// ตัวเลขทั้งหมดเป็นของเครื่องนี้ ไม่ส่งออกไปที่ไหน
import { useEffect, useRef, useState } from "react";
import { Cpu, Thermometer, ArrowDown, ArrowUp, MemoryStick, Timer } from "lucide-react";
import { Card } from "./Card";
import { Meter } from "./ui";
import { api } from "../api/client";
import type { GpuLive } from "../types";

const MAX_POINTS = 60; // 60 ตัวอย่าง x 3 วินาที = 3 นาทีล่าสุด

export type GpuLevel = "ok" | "warn" | "bad";

/** ระดับเตือน VRAM: เกิน 92% = แดง, เกิน 85% = เหลือง */
export function vramLevel(usedGb: number, totalGb: number): GpuLevel {
  const r = totalGb > 0 ? usedGb / totalGb : 0;
  return r > 0.92 ? "bad" : r > 0.85 ? "warn" : "ok";
}
/** ระดับเตือนอุณหภูมิ: การ์ดโน้ตบุ๊กทำงานที่ 80-88°C ได้ตามปกติ จึงเตือนเหลืองเมื่อเกิน 88 และแดงเมื่อเกิน 92 */
export function tempLevel(c: number | null | undefined): GpuLevel {
  if (c == null) return "ok";
  return c > 92 ? "bad" : c > 88 ? "warn" : "ok";
}

export interface Progress { step: number; total: number; remainingSec: number | null; secPerStep: number | null }

const toSec = (t: string) => t.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);

/** อ่านความคืบหน้าจากแถบ tqdm ล่าสุดใน log เช่น "50/328 [03:41<19:17, 4.17s/it]" (เวลาที่เหลือคือค่าที่ tqdm ประมาณเอง) */
export function parseProgress(lines: string[]): Progress | null {
  const re = /(\d+)\/(\d+) \[([\d:]+)<([\d:?]+), *([\d.?]+)(s\/it|it\/s)\]/g;
  let best: Progress | null = null;
  // ดูย้อนหลัง 60 บรรทัด เลือกแถบที่ "ยาวที่สุด" (= แถบเทรนหลัก) เพื่อไม่สับสนกับแถบ validation/โหลดไฟล์ที่ผ่านมาทีหลัง
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60); i--) {
    let m: RegExpExecArray | null, last: RegExpExecArray | null = null;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) last = m;
    if (!last) continue;
    const step = Number(last[1]), total = Number(last[2]);
    if (!total || step > total || total <= 10) continue; // ตัดแถบเล็ก เช่นดาวน์โหลดไฟล์ 10/10
    if (best && total <= best.total) continue; // ได้แถบที่ใหม่กว่าและยาวพอกันหรือยาวกว่าแล้ว
    const v = Number(last[5]);
    const sec = !Number.isFinite(v) ? null : last[6] === "s/it" ? v : v > 0 ? 1 / v : null;
    best = { step, total, remainingSec: last[4].includes("?") ? null : toSec(last[4]), secPerStep: sec };
  }
  return best;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} วินาที`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} นาที`;
  return `${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
}

export function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
}

const TONE: Record<GpuLevel, string> = { ok: "text-good", warn: "text-warn", bad: "text-bad" };
const STROKE: Record<GpuLevel, string> = { ok: "#7fd1ae", warn: "#e6c07b", bad: "#e58a8a" };

function Spark({ values, max, tone }: { values: number[]; max: number; tone: GpuLevel }) {
  const w = 200, h = 26;
  if (values.length < 2) return <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-6" aria-hidden />;
  const n = Math.max(values.length, 2);
  const pts = values.map((v, i) => `${(i / (n - 1)) * w},${h - 2 - (Math.min(v, max) / max) * (h - 4)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-6" aria-hidden>
      <polyline points={pts} fill="none" stroke={STROKE[tone]} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Stat({ label, value, sub, tone, spark }: { label: string; value: string; sub?: string; tone: GpuLevel; spark?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-base-500">{label}</div>
      <div className={`text-lg font-semibold leading-tight ${TONE[tone]}`}>{value}</div>
      {sub && <div className="text-[11px] text-base-400 mb-1">{sub}</div>}
      {spark}
    </div>
  );
}

export default function GpuMonitor({ active, logLines = [], demo }: { active: boolean; logLines?: string[]; demo?: GpuLive[] }) {
  const [cur, setCur] = useState<GpuLive | null>(null);
  const hist = useRef({ vram: [] as number[], util: [] as number[], temp: [] as number[] });
  const prev = useRef<GpuLive | null>(null);
  const [net, setNet] = useState<{ rx: number; tx: number }>({ rx: 0, tx: 0 });
  const [, bump] = useState(0);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const push = (r: GpuLive) => {
      if (!r.gpu) return;
      const h = hist.current;
      h.vram = [...h.vram, r.gpu.vram_used_gb].slice(-MAX_POINTS);
      h.util = [...h.util, r.gpu.util_pct ?? 0].slice(-MAX_POINTS);
      h.temp = [...h.temp, r.gpu.temp_c ?? 0].slice(-MAX_POINTS);
      const p = prev.current;
      if (p && p.net_rx != null && r.net_rx != null && p.net_tx != null && r.net_tx != null && r.ts > p.ts)
        setNet({ rx: Math.max(0, (r.net_rx - p.net_rx) / (r.ts - p.ts)), tx: Math.max(0, ((r.net_tx ?? 0) - p.net_tx) / (r.ts - p.ts)) });
      prev.current = r;
      setCur(r); bump((n) => n + 1);
    };
    if (demo) { demo.forEach(push); return; } // โหมดตัวอย่าง (ใช้ถ่ายภาพ/ทดสอบ) ไม่เรียก backend
    const tick = () => api.gpuLive().then((r) => { if (alive) push(r); }).catch(() => { /* อ่านไม่ได้ก็ข้าม ไม่รบกวนหน้า */ });
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [active, demo]);

  const g = cur?.gpu;
  if (!active || !cur || !g) return null;
  const vl = vramLevel(g.vram_used_gb, g.vram_total_gb);
  const tl = tempLevel(g.temp_c);
  const worst: GpuLevel = vl === "bad" || tl === "bad" ? "bad" : vl === "warn" || tl === "warn" ? "warn" : "ok";
  const h = hist.current;
  const prog = parseProgress(logLines);
  const eta = prog?.remainingSec != null ? new Date(Date.now() + prog.remainingSec * 1000) : null;

  return (
    <Card className="p-4 space-y-4">
      {prog && (
        <div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-base-400 mb-2">
            <span className="flex items-center gap-1.5 text-base-200"><Timer size={14} /> step {prog.step} / {prog.total} ({Math.round((prog.step / prog.total) * 100)}%)</span>
            {prog.remainingSec != null && <span>เหลือประมาณ <b className="text-base-100">{fmtDuration(prog.remainingSec)}</b>{eta && <> · น่าจะเสร็จราว <b className="text-base-100">{eta.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}</b></>}</span>}
            {prog.secPerStep != null && <span>{prog.secPerStep.toFixed(1)} วินาที/step</span>}
          </div>
          <Meter pct={(prog.step / prog.total) * 100} tone="accent" />
          <p className="text-[11px] text-base-500 mt-1">เวลาที่เหลือเป็นค่าประมาณจากความเร็วล่าสุด ช่วงรอบตรวจสอบ (validation) และบันทึก checkpoint จะช้ากว่าปกติเล็กน้อย</p>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-base-400">
        <Cpu size={14} /> <span className="truncate">{g.name}</span>
        <span className="ml-auto text-[11px] text-base-500 hidden sm:inline">อัปเดตทุก 3 วินาที · กราฟย้อนหลัง 3 นาที</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Stat label="VRAM" value={`${g.vram_used_gb.toFixed(1)} / ${g.vram_total_gb.toFixed(1)} GB`} sub={`ใช้ ${Math.round((g.vram_used_gb / g.vram_total_gb) * 100)}% · ว่าง ${g.vram_free_gb.toFixed(2)} GB`} tone={vl} spark={<Spark values={h.vram} max={g.vram_total_gb} tone={vl} />} />
        <Stat label="การใช้งานการ์ด" value={`${g.util_pct ?? "-"}%`} sub={(g.util_pct ?? 0) >= 90 ? "ทำงานเต็มที่" : "ยังมีที่ว่างให้ทำงาน"} tone="ok" spark={<Spark values={h.util} max={100} tone="ok" />} />
        <Stat label="อุณหภูมิ" value={`${g.temp_c ?? "-"} °C`} sub={tl === "ok" ? "ปกติ" : tl === "warn" ? "ค่อนข้างร้อน ระบายอากาศให้เครื่อง" : "ร้อนมาก อาจหน่วงความเร็วหรือค้าง"} tone={tl} spark={<Spark values={h.temp} max={100} tone={tl} />} />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-base-400 border-t border-base-800 pt-3">
        {cur.cpu_pct != null && <span className="flex items-center gap-1.5"><Cpu size={13} /> CPU <b className="text-base-200">{Math.round(cur.cpu_pct)}%</b></span>}
        {cur.ram_used_gb != null && cur.ram_total_gb != null && <span className="flex items-center gap-1.5"><MemoryStick size={13} /> RAM <b className="text-base-200">{cur.ram_used_gb} / {cur.ram_total_gb} GB</b></span>}
        {cur.net_rx != null && <span className="flex items-center gap-1.5"><ArrowDown size={13} /> <b className="text-base-200">{fmtRate(net.rx)}</b> <ArrowUp size={13} /> <b className="text-base-200">{fmtRate(net.tx)}</b> <span className="text-base-500">(เครือข่ายทั้งเครื่อง)</span></span>}
      </div>

      {worst !== "ok" && (
        <div className={`flex items-center gap-1.5 text-xs ${TONE[worst]}`}>
          <Thermometer size={13} />
          {vl !== "ok" ? "VRAM ใกล้เต็ม: ถ้าเทรนล้มด้วย OOM ให้ลด max_seq_length หรือปิดโปรแกรมที่ใช้การ์ดจอ" : "อุณหภูมิสูง: ยกเครื่องให้อากาศผ่านใต้เครื่อง หรือใช้พัดลมรอง"}
        </div>
      )}
    </Card>
  );
}
