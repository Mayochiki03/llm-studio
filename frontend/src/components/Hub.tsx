// หน้า "รวม" หลายหน้าไว้ใต้เมนูเดียว: หัวเรื่องหนึ่งอัน + แท็บสลับหน้า (เส้นทางเดิมยังใช้ได้ เช่น /registry /models /import)
// หน้าลูกเรียก <Topbar> ของตัวเองตามเดิม แต่ถ้าอยู่ใน Hub ให้ซ่อน (Embedded) เพื่อไม่ให้มีหัวเรื่องซ้อนสองชั้น
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import Topbar from "./Topbar";
import { EmbeddedCtx } from "./embedded";

export interface HubTab { to: string; label: string; hint?: string }

export default function Hub({ title, subtitle, tabs, children }: { title: string; subtitle?: string; tabs: HubTab[]; children: ReactNode }) {
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <Topbar title={title} subtitle={subtitle} force />
      <div className="shrink-0 border-b border-base-800 px-4 md:px-8 overflow-x-auto">
        <div className="flex gap-1 min-w-max" role="tablist">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              role="tab"
              title={t.hint}
              className={({ isActive }) =>
                `px-3.5 py-2.5 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${
                  isActive ? "border-accent-400 text-base-100" : "border-transparent text-base-400 hover:text-base-100"
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </div>
      </div>
      <EmbeddedCtx.Provider value={true}>{children}</EmbeddedCtx.Provider>
    </div>
  );
}
