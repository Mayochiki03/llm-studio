// ทดสอบ 0.8.0: ตรวจชื่อโมเดลผลลัพธ์, ตัววิเคราะห์ตารางแก้ไขชุดข้อมูล
import { describe, it, expect } from "vitest";
import { checkOutputName } from "../pages/NewTraining";
import { analyze, toRows } from "../components/DatasetTableEditor";

describe("checkOutputName", () => {
  it("ว่างไม่ได้", () => expect(checkOutputName("  ", [])).not.toBe(""));
  it("ภาษาไทย/อักขระแปลกไม่ได้", () => {
    expect(checkOutputName("ชื่อไทย", [])).not.toBe("");
    expect(checkOutputName("a b", [])).not.toBe("");
  });
  it("ชื่อปกติผ่าน", () => expect(checkOutputName("faq-v4", [])).toBe(""));
  it("ซ้ำไม่ได้ (ไม่สนตัวพิมพ์เล็กใหญ่)", () => expect(checkOutputName("FAQ-v3", ["faq-v3"])).toContain("มีงาน"));
});

describe("analyze (ตารางแก้ไข)", () => {
  const base = toRows([{ instruction: "ก", output: "1" }, { instruction: "ข", output: "2" }]);
  it("ไม่แก้อะไร = ไม่ dirty", () => expect(analyze(base, 0).dirty).toBe(false));
  it("นับแถวที่แก้ เพิ่ม ลบ", () => {
    const rows = [{ ...base[0], output: "แก้" }, base[1], { rid: 9, instruction: "ค", output: "3", o_ins: "", o_out: "", isNew: true }];
    const a = analyze(rows, 1);
    expect(a).toMatchObject({ edited: 1, added: 1, removed: 1, dirty: true });
  });
  it("เจอคำถามซ้ำและแถวไม่ครบ", () => {
    const rows = [base[0], { ...base[1], instruction: "ก" }, { rid: 5, instruction: "ง", output: "", o_ins: "", o_out: "", isNew: true }];
    const a = analyze(rows, 0);
    expect(a.dup.has("ก")).toBe(true);
    expect(a.incomplete).toBe(1);
  });
});
