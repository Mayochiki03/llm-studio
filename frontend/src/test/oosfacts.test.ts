// ทดสอบตัวแปลงรายการคำถามนอกขอบเขตในฟอร์มตารางข้อเท็จจริง
import { describe, it, expect } from "vitest";
import { linesToList } from "../components/FactsBuilderDialog";

describe("linesToList", () => {
  it("ตัดช่องว่าง บรรทัดว่าง และข้อซ้ำ", () => {
    expect(linesToList(" มีกี่ชั้น \n\nมีกี่ชั้น\nที่จอดรถ\n")).toEqual(["มีกี่ชั้น", "ที่จอดรถ"]);
  });
  it("ว่างเปล่าได้ (แปลว่าไม่ใส่คำถามนอกขอบเขต)", () => {
    expect(linesToList("  \n ")).toEqual([]);
  });
});
