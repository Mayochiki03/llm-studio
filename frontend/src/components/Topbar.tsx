import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Circle, Menu } from "lucide-react";
import { useEmbedded } from "./embedded";

/** force = ตัว Hub เรียกเอง (แสดงเสมอ) ส่วนหน้าลูกใน Hub จะถูกซ่อนหัวเรื่อง */
export default function Topbar({ title, subtitle, force }: { title: string; subtitle?: string; force?: boolean }) {
  const embedded = useEmbedded();
  const [healthy, setHealthy] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    const check = () =>
      api
        .health()
        .then(() => mounted && setHealthy(true))
        .catch(() => mounted && setHealthy(false));
    check();
    const t = setInterval(check, 15000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, []);

  if (embedded && !force) return null;

  return (
    <header className="h-16 shrink-0 border-b border-base-800 bg-base-950/80 backdrop-blur px-4 md:px-8 flex items-center justify-between">
      <div className="flex items-center gap-3 min-w-0">
        <button
          className="lg:hidden text-base-300 hover:text-base-100 shrink-0"
          onClick={() => window.dispatchEvent(new Event("toggle-nav"))}
          aria-label="เปิดเมนู"
        >
          <Menu size={20} />
        </button>
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-base-100 truncate">{title}</h1>
          {subtitle && <p className="text-xs text-base-400 mt-0.5 truncate">{subtitle}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-base-400 shrink-0">
        <Circle
          size={9}
          className={
            healthy === null
              ? "text-base-500"
              : healthy
              ? "text-good fill-good"
              : "text-bad fill-bad"
          }
        />
        <span className="hidden sm:inline">{healthy === null ? "กำลังเช็ค backend..." : healthy ? "backend พร้อมใช้งาน" : "เชื่อมต่อ backend ไม่ได้"}</span>
      </div>
    </header>
  );
}
