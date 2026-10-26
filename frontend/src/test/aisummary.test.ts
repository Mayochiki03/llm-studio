// ทดสอบตัวตัดเครื่องหมาย markdown ออกจากข้อความที่ AI สรุป
import { describe, it, expect } from "vitest";
import { plainText } from "../components/AiSummaryCard";

describe("plainText", () => {
  it("ตัด ** และหัวข้อ markdown ออก คงเนื้อหาไว้", () => {
    expect(plainText("**1) ภาพรวม:** loss ลดลง\n## หัวข้อ\n`x`")).toBe("1) ภาพรวม: loss ลดลง\nหัวข้อ\nx");
  });
});
