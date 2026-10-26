// ทดสอบการแปลงแถวในฟอร์มตารางข้อเท็จจริงเป็นข้อมูลส่ง backend
import { describe, it, expect } from "vitest";
import { rowsToFacts, factsToRows, emptyRow } from "../components/FactsBuilderDialog";

describe("rowsToFacts", () => {
  it("แยกบรรทัดคำถามและ comma คำสำคัญ ตัดช่องว่าง", () => {
    const f = rowsToFacts([{ topic: " เวลา ", answer: " เปิด 08.00 ", questions: "เปิดกี่โมง\n\n  ปิดกี่โมง  ", answers_alt: "เปิด 08.00 นะคะ\n", keywords: "08.00, 16.00，x", red_flag: true }]);
    expect(f).toEqual([{ topic: "เวลา", answer: "เปิด 08.00", questions: ["เปิดกี่โมง", "ปิดกี่โมง"], answers_alt: ["เปิด 08.00 นะคะ"], keywords: ["08.00", "16.00", "x"], red_flag: true }]);
  });
  it("ข้ามแถวที่ไม่มีคำตอบหรือไม่มีคำถาม", () => {
    expect(rowsToFacts([emptyRow(), { ...emptyRow(), answer: "a" }, { ...emptyRow(), questions: "q" }])).toEqual([]);
  });
  it("วนกลับ factsToRows แล้วได้ค่าเดิม", () => {
    const rows = factsToRows([{ topic: "t", answer: "a", questions: ["q1", "q2"], keywords: ["k"] }]);
    expect(rows[0].questions).toBe("q1\nq2");
    expect(rows[0].keywords).toBe("k");
  });
});
