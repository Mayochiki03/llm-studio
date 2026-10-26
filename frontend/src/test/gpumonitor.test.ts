// ทดสอบตัวช่วยของแผงมอนิเตอร์: อ่านความคืบหน้าจาก log, ระดับเตือน, รูปแบบเวลา/ความเร็ว
import { describe, it, expect } from "vitest";
import { parseProgress, vramLevel, tempLevel, fmtDuration, fmtRate } from "../components/GpuMonitor";

describe("parseProgress", () => {
  it("อ่านแถบ tqdm ล่าสุด", () => {
    const p = parseProgress(["noise", " 15%|█▌        | 50/328 [03:41<19:17,  4.17s/it]"]);
    expect(p).toEqual({ step: 50, total: 328, remainingSec: 19 * 60 + 17, secPerStep: 4.17 });
  });
  it("แถบที่ติดกันหลายอันในบรรทัดเดียว ใช้อันท้ายสุด", () => {
    const p = parseProgress([" 10%|█| 32/328 [02:26<21:22,  4.33s/it] 11%| 33/328 [02:30<39:07,  7.96s/it]"]);
    expect(p?.step).toBe(33);
  });
  it("ข้ามแถบสั้นๆ เช่น validation 73/73 หรือโหลดไฟล์ 10/10", () => {
    expect(parseProgress(["Fetching 10 files: 100%|██| 10/10 [00:00<00:00, 1815.56it/s]"])).toBeNull();
    const p = parseProgress([" 15%| 50/328 [03:41<19:17,  4.17s/it]", "100%|██| 73/73 [00:12<00:00,  5.37it/s]"]);
    expect(p?.total).toBe(328);
  });
  it("ไม่มีแถบ → null; ไม่รู้เวลาที่เหลือ (?) → remainingSec null", () => {
    expect(parseProgress([])).toBeNull();
    expect(parseProgress(["  0%| 0/328 [00:00<?, ?it/s]"])?.remainingSec).toBeNull();
  });
});

describe("ระดับเตือนและการแสดงผล", () => {
  it("VRAM", () => { expect(vramLevel(3.1, 4)).toBe("ok"); expect(vramLevel(3.6, 4)).toBe("warn"); expect(vramLevel(3.8, 4)).toBe("bad"); });
  it("อุณหภูมิ (87 ยังปกติสำหรับโน้ตบุ๊ก)", () => { expect(tempLevel(87)).toBe("ok"); expect(tempLevel(90)).toBe("warn"); expect(tempLevel(93)).toBe("bad"); expect(tempLevel(null)).toBe("ok"); });
  it("เวลา", () => { expect(fmtDuration(45)).toBe("45 วินาที"); expect(fmtDuration(19 * 60)).toBe("19 นาที"); expect(fmtDuration(3900)).toBe("1 ชม. 5 นาที"); });
  it("ความเร็วเครือข่าย", () => { expect(fmtRate(500)).toBe("500 B/s"); expect(fmtRate(2048)).toBe("2 KB/s"); expect(fmtRate(3 * 1024 * 1024)).toBe("3.0 MB/s"); });
});
