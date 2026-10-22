import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard, FlaskConical, Boxes, Settings, Sparkles, FolderInput, ClipboardCheck,
  BookOpen, MessageSquare, Database, ShieldCheck, Server, X, type LucideIcon,
} from "lucide-react";

// เมนูแบ่งกลุ่มตามลำดับงานจริง: เตรียมข้อมูล → เทรน → ทดสอบ → นำไปใช้ → ระบบ
const groups: { title: string; items: { to: string; label: string; icon: LucideIcon; end?: boolean }[] }[] = [
  {
    title: "",
    items: [{ to: "/", label: "ภาพรวม", icon: LayoutDashboard, end: true }],
  },
  {
    title: "เตรียมข้อมูล",
    items: [
      { to: "/kb", label: "คลังความรู้", icon: BookOpen },
      { to: "/datasets", label: "ชุดข้อมูลเทรน", icon: Database },
    ],
  },
  {
    title: "เทรนและทดสอบ",
    items: [
      { to: "/train", label: "เทรนโมเดลใหม่", icon: FlaskConical },
      { to: "/import", label: "นำเข้าโมเดล", icon: FolderInput },
      { to: "/eval", label: "ทดสอบและเปรียบเทียบ", icon: ClipboardCheck },
      { to: "/playground", label: "Playground", icon: MessageSquare },
    ],
  },
  {
    title: "นำไปใช้",
    items: [
      { to: "/registry", label: "ทะเบียนโมเดล", icon: ShieldCheck },
      { to: "/models", label: "โมเดลใน Ollama", icon: Boxes },
    ],
  },
  {
    title: "ระบบ",
    items: [
      { to: "/system", label: "เครื่องและพื้นที่", icon: Server },
      { to: "/settings", label: "ตั้งค่า", icon: Settings },
    ],
  },
];

function Brand() {
  return (
    <div className="flex items-center gap-2 px-5 h-16 border-b border-base-800 shrink-0">
      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-400 to-accent-500 flex items-center justify-center shadow-card">
        <Sparkles size={16} className="text-base-950" />
      </div>
      <div>
        <div className="text-sm font-semibold leading-tight">LLM Studio</div>
        <div className="text-[11px] text-base-400 leading-tight">local training console</div>
      </div>
    </div>
  );
}

function Nav() {
  return (
    <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
      {groups.map((g, gi) => (
        <div key={gi} className="space-y-1">
          {g.title && <div className="px-3 pb-1 text-[11px] uppercase tracking-wide text-base-500">{g.title}</div>}
          {g.items.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive ? "bg-base-800 text-base-100 shadow-card" : "text-base-300 hover:bg-base-850 hover:text-base-100"
                }`
              }
            >
              <Icon size={17} strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

export default function Sidebar() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();

  // หน้าบนมือถือ: ปุ่มเมนูใน Topbar ส่งสัญญาณมาเปิดลิ้นชัก; เปลี่ยนหน้าแล้วปิดเอง
  useEffect(() => {
    const h = () => setOpen((o) => !o);
    window.addEventListener("toggle-nav", h);
    return () => window.removeEventListener("toggle-nav", h);
  }, []);
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  return (
    <>
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-base-800 bg-base-900">
        <Brand />
        <Nav />
      </aside>

      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="relative w-72 max-w-[85%] flex flex-col bg-base-900 border-r border-base-800 h-full">
            <button onClick={() => setOpen(false)} className="absolute top-4 right-3 text-base-400 hover:text-base-100" aria-label="ปิดเมนู">
              <X size={18} />
            </button>
            <Brand />
            <Nav />
          </aside>
        </div>
      )}
    </>
  );
}
