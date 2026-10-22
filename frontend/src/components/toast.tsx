// แจ้งเตือนมุมจอ: เรียก toast("ข้อความ") จากที่ไหนก็ได้ แล้ววาง <Toaster /> ไว้ที่ App ครั้งเดียว
import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";

type T = { id: number; text: string; tone: "good" | "bad" };
let seq = 1;

export function toast(text: string, tone: "good" | "bad" = "good") {
  window.dispatchEvent(new CustomEvent("studio-toast", { detail: { id: seq++, text, tone } }));
}

/** แปลง error ใดๆ เป็นข้อความสำหรับแจ้งผู้ใช้ */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : "เกิดข้อผิดพลาด";
}

export function Toaster() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    const h = (e: Event) => {
      const t = (e as CustomEvent<T>).detail;
      setItems((p) => [...p.slice(-3), t]);
      setTimeout(() => setItems((p) => p.filter((x) => x.id !== t.id)), 4500);
    };
    window.addEventListener("studio-toast", h);
    return () => window.removeEventListener("studio-toast", h);
  }, []);
  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[60] flex flex-col gap-2 items-end pointer-events-none">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 max-w-sm w-full sm:w-auto text-sm px-4 py-3 rounded-lg border shadow-card bg-base-900 ${
            t.tone === "good" ? "border-good/40 text-good" : "border-bad/40 text-bad"
          }`}
        >
          {t.tone === "good" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
          <span className="text-base-100">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
