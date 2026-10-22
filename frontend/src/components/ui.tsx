// ชิ้นส่วนหน้าจอที่ใช้ซ้ำทุกหน้า: ช่องกรอก, สวิตช์, กล่องป๊อปอัป, ป้าย, กล่องแจ้งเตือน, ข้อความว่าง
import { useEffect, useState, type ReactNode } from "react";
import { X, AlertTriangle, Info, CheckCircle2, Loader2 } from "lucide-react";

export const inputCls =
  "w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500 placeholder:text-base-500";

/** ช่องกรอกพร้อมป้ายชื่อและคำอธิบายใต้ช่อง */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="text-xs text-base-400 block mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-base-500 mt-1">{hint}</p>}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputCls} resize-y ${props.className ?? ""}`} />;
}

const fmtNum = (n: number) => (Number.isFinite(n) ? String(n) : "0");

/**
 * ช่องกรอกตัวเลข: เก็บสิ่งที่พิมพ์เป็นข้อความไว้เอง จึงลบจนว่างแล้วพิมพ์ค่าใหม่ได้ (ไม่เด้งเป็น 0 แล้วกลายเป็น 01000)
 * - ระหว่างพิมพ์ ส่งค่าให้ผู้เรียกเฉพาะเมื่อข้อความเป็นตัวเลขที่ใช้ได้ ช่องว่างยังไม่ส่งอะไร
 * - ตอนออกจากช่อง (blur): ถ้าว่าง/ไม่ใช่ตัวเลข คืนเป็นค่าเดิม, ถ้าเกิน min/max ปรับให้อยู่ในช่วง
 */
export function NumberInput({
  value,
  onChange,
  step = 1,
  min,
  max,
  className,
}: {
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
}) {
  const [text, setText] = useState(fmtNum(value));

  // ค่าจากภายนอกเปลี่ยน (เช่น เลือกชุดค่าสำเร็จรูป) ให้ช่องตามค่านั้น แต่ถ้าที่พิมพ์อยู่ตรงกับค่าอยู่แล้ว (เช่น "1.") ไม่แตะ
  useEffect(() => {
    setText((t) => (t.trim() !== "" && Number(t) === value ? t : fmtNum(value)));
  }, [value]);

  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = parseFloat(raw);
        if (raw.trim() !== "" && Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => {
        const n = parseFloat(text);
        if (text.trim() === "" || !Number.isFinite(n)) {
          setText(fmtNum(value));
          return;
        }
        let c = n;
        if (min !== undefined && c < min) c = min;
        if (max !== undefined && c > max) c = max;
        if (c !== n) onChange(c);
        setText(fmtNum(c));
      }}
      className={className ?? inputCls}
    />
  );
}

/** สวิตช์เปิด/ปิด */
export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm text-base-100">{label}</div>
        {hint && <p className="text-[11px] text-base-500 mt-0.5">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-6 rounded-full shrink-0 transition-colors ${checked ? "bg-accent-500" : "bg-base-700"}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`} />
      </button>
    </div>
  );
}

/** กล่องป๊อปอัป: กด Esc หรือคลิกพื้นหลังเพื่อปิด; เลื่อนในกล่องได้บนจอเล็ก */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className={`bg-base-900 border border-base-800 rounded-xl2 shadow-card w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[90vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-14 border-b border-base-800 shrink-0">
          <div className="text-sm font-medium">{title}</div>
          <button onClick={onClose} className="text-base-400 hover:text-base-100" aria-label="ปิด">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 overflow-y-auto space-y-3">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-base-800 flex justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

const TONES = {
  good: "bg-good/15 text-good",
  warn: "bg-warn/15 text-warn",
  bad: "bg-bad/15 text-bad",
  info: "bg-accent-500/15 text-accent-300",
  mute: "bg-base-800 text-base-300",
};
export type Tone = keyof typeof TONES;

export function Pill({ tone = "mute", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${TONES[tone]}`}>{children}</span>;
}

/** กล่องข้อความแจ้ง (ข้อมูล/เตือน/ผิดพลาด/สำเร็จ) */
export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "good"; children: ReactNode }) {
  const cls = {
    info: "text-accent-300 bg-accent-500/10 border-accent-500/20",
    warn: "text-warn bg-warn/10 border-warn/20",
    bad: "text-bad bg-bad/10 border-bad/20",
    good: "text-good bg-good/10 border-good/20",
  }[tone];
  const Icon = tone === "good" ? CheckCircle2 : tone === "info" ? Info : AlertTriangle;
  return (
    <div className={`flex items-start gap-2 text-xs border rounded-lg px-3 py-2.5 ${cls}`}>
      <Icon size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="px-5 py-12 text-center">
      {icon && <div className="flex justify-center mb-3 text-base-600">{icon}</div>}
      <div className="text-sm text-base-300">{title}</div>
      {hint && <p className="text-xs text-base-500 mt-1 max-w-sm mx-auto">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Spinner({ text }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-base-400 py-6 justify-center">
      <Loader2 size={16} className="animate-spin" /> {text ?? "กำลังโหลด..."}
    </div>
  );
}

/** แถบความคืบหน้า/การใช้งาน (0-100) เปลี่ยนสีตามระดับ */
export function Meter({ pct, tone }: { pct: number; tone?: "good" | "warn" | "bad" | "accent" }) {
  const p = Math.max(0, Math.min(100, pct));
  const t = tone ?? (p > 90 ? "bad" : p > 75 ? "warn" : "accent");
  const bg = { good: "bg-good", warn: "bg-warn", bad: "bg-bad", accent: "bg-accent-500" }[t];
  return (
    <div className="h-1.5 rounded-full bg-base-800 overflow-hidden">
      <div className={`h-full rounded-full ${bg}`} style={{ width: `${p}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------- ตัวช่วยจัดรูปแบบ
export function timeAgo(ts?: number | null) {
  if (!ts) return "-";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "เมื่อครู่";
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชม.ที่แล้ว`;
  return `${Math.floor(s / 86400)} วันที่แล้ว`;
}

export function fmtDate(ts?: number | null) {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

export function pct(v?: number | null) {
  return v === null || v === undefined ? "-" : `${Math.round(v * 100)}%`;
}
