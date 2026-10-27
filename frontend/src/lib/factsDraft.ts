// ส่งต่อ "ร่างข้อมูลสอนจากข้อที่พลาด" จากหน้าทดสอบไปเปิดในตารางข้อเท็จจริงของหน้าชุดข้อมูล (ผ่าน localStorage ใช้ครั้งเดียว)
import type { FactsDraft } from "../types";

const KEY = "llmstudio.factsDraft.v1";

export function saveFactsDraft(d: FactsDraft): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(d)); return true; } catch { return false; }
}
/** อ่านแล้วลบทิ้ง กันเด้งซ้ำทุกครั้งที่เปิดหน้า */
export function takeFactsDraft(): FactsDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const d = JSON.parse(raw) as FactsDraft;
    return Array.isArray(d.facts) && Array.isArray(d.oos) ? d : null;
  } catch { return null; }
}
export function hasFactsDraft(): boolean {
  try { return !!localStorage.getItem(KEY); } catch { return false; }
}
