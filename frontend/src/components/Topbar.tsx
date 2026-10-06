import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Circle } from "lucide-react";

export default function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
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

  return (
    <header className="h-16 shrink-0 border-b border-base-800 bg-base-950/80 backdrop-blur px-4 md:px-8 flex items-center justify-between">
      <div>
        <h1 className="text-base font-semibold text-base-100">{title}</h1>
        {subtitle && <p className="text-xs text-base-400 mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2 text-xs text-base-400">
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
        {healthy === null ? "กำลังเช็ค backend..." : healthy ? "backend พร้อมใช้งาน" : "เชื่อมต่อ backend ไม่ได้"}
      </div>
    </header>
  );
}
