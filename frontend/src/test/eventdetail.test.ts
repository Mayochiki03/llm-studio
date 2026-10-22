// ทดสอบการแสดงผลประวัติการทดสอบเป็นภาษาคน
import { describe, it, expect } from "vitest";
import { fmtEventDetail } from "../pages/Registry";

describe("fmtEventDetail", () => {
  it("แปลงผลทดสอบเป็นเปอร์เซ็นต์", () => {
    expect(fmtEventDetail("eval", '{"pass_rate": 0.0, "red_flag_recall": 0.5}')).toBe("ผ่านเกณฑ์ 0% · จับ red flag ได้ 50%");
  });
  it("ค่าไม่มีแสดงไม่มีข้อมูล และ JSON เสียไม่พัง", () => {
    expect(fmtEventDetail("eval", '{"pass_rate": 1, "red_flag_recall": null}')).toContain("ไม่มีข้อมูล");
    expect(fmtEventDetail("eval", "not json")).toBe("not json");
    expect(fmtEventDetail("register", "x")).toBe("x");
  });
});
