// ทดสอบ 0.8.2: เมนูซ้ายเรียงตามลำดับงาน/แท็บรวมหน้า, ตัวแยกคำในหน้าขอบเขต, คำศัพท์
import { describe, it, expect } from "vitest";
import { navGroups, isItemActive } from "../components/Sidebar";
import { splitWords } from "../pages/Scope";
import { TERMS } from "../pages/Glossary";

const items = navGroups.flatMap((g) => g.items);

describe("เมนูซ้าย", () => {
  it("ไม่มีเมนูซ้ำ และมีไม่เกิน 10 ข้อ (ไม่ให้หน้างอก)", () => {
    expect(new Set(items.map((i) => i.to)).size).toBe(items.length);
    expect(items.length).toBeLessThanOrEqual(10);
  });
  it("เรียงตามลำดับงาน: ข้อมูล → สร้างและทดสอบ → นำไปใช้ → ระบบ", () => {
    const order = items.map((i) => i.to);
    expect(order.indexOf("/kb")).toBeLessThan(order.indexOf("/train"));
    expect(order.indexOf("/train")).toBeLessThan(order.indexOf("/registry"));
    expect(order.indexOf("/registry")).toBeLessThan(order.indexOf("/system"));
  });
  it("หน้าในแท็บเดียวกันทำให้เมนูข้อนั้นสว่าง", () => {
    const models = items.find((i) => i.to === "/registry")!;
    for (const p of ["/registry", "/models", "/import"]) expect(isItemActive(models, p)).toBe(true);
    expect(isItemActive(models, "/kb")).toBe(false);
    const train = items.find((i) => i.to === "/train")!;
    expect(isItemActive(train, "/jobs/abc")).toBe(true);
    const home = items.find((i) => i.to === "/")!;
    expect(isItemActive(home, "/kb")).toBe(false);
  });
});

describe("splitWords", () => {
  it("แยกด้วยบรรทัด/คอมมา ตัดช่องว่างและค่าซ้ำ", () => {
    expect(splitWords("ยา, ขนาดยา\nยา\n  ")).toEqual(["ยา", "ขนาดยา"]);
  });
});

describe("คำศัพท์", () => {
  it("มีคำสำคัญที่ผู้ใช้เคยสับสน", () => {
    const words = TERMS.map((t) => t.word).join("|");
    for (const w of ["RAG", "LoRA", "โมเดลที่ใช้งานจริง"]) expect(words).toContain(w);
  });
});
