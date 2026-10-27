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

import { cardToText } from "../components/ModelCardDialog";
import type { ModelCard } from "../types";

describe("cardToText (0.8.3)", () => {
  const card = {
    version: { id: "a", name: "faq-v5", base_model: "typhoon", status: "candidate", notes: "เพิ่มข้อมูลนอกขอบเขต", created_at: 0, updated_at: 0 },
    dataset: { id: "custom-1", version: "2" },
    job: { r: 16, lora_alpha: 16, max_seq_length: 512, num_train_epochs: 4, learning_rate: 0.0001, val_ratio: 0.1, final_train_loss: 0.07, final_val_loss: 0.25, best_val_loss: 0.24 },
    eval: { pass_rate: 0.96, red_flag_recall: 1, use_kb: true },
    environment_now: {}, events: [], retrain: null,
  } as unknown as ModelCard;
  it("สรุปค่าสำคัญครบ พร้อมบอกว่าทดสอบแบบมีคลังความรู้", () => {
    const t = cardToText(card);
    for (const w of ["faq-v5", "custom-1 v2", "epochs=4", "0.250", "มีคลังความรู้", "เพิ่มข้อมูลนอกขอบเขต"]) expect(t).toContain(w);
  });
  it("โมเดลที่ไม่มีงานเทรนยังสรุปได้ ไม่ error", () => {
    expect(cardToText({ ...card, job: null })).toContain("faq-v5");
  });
});
