import { NavLink } from "react-router-dom";
import { LayoutDashboard, FlaskConical, Boxes, Settings, Sparkles, FolderInput, ClipboardCheck } from "lucide-react";

const items = [
  { to: "/", label: "ภาพรวม", icon: LayoutDashboard, end: true },
  { to: "/train", label: "เทรนโมเดลใหม่", icon: FlaskConical },
  { to: "/import", label: "นำเข้าโมเดล", icon: FolderInput },
  { to: "/eval", label: "ทดสอบโมเดล", icon: ClipboardCheck },
  { to: "/models", label: "โมเดลของฉัน", icon: Boxes },
  { to: "/settings", label: "ตั้งค่า", icon: Settings },
];

export default function Sidebar() {
  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-base-800 bg-base-900">
      <div className="flex items-center gap-2 px-5 h-16 border-b border-base-800">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-400 to-accent-500 flex items-center justify-center shadow-card">
          <Sparkles size={16} className="text-base-950" />
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight">LLM Studio</div>
          <div className="text-[11px] text-base-400 leading-tight">local training console</div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {items.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-base-800 text-base-100 shadow-card"
                  : "text-base-300 hover:bg-base-850 hover:text-base-100"
              }`
            }
          >
            <Icon size={17} strokeWidth={2} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="px-4 py-4 border-t border-base-800 text-[11px] text-base-500">
        เชื่อมต่อ Ollama ที่ <code className="text-base-400">localhost:11434</code>
      </div>
    </aside>
  );
}
