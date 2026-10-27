// ทดสอบ 0.8.5: หน้าป้องกันถามซ้ำ/สแปม (พรีเซ็ต จำลอง ปลดล็อก), ชื่อชนิดการตอบ, หน้าขอบเขตมีหัวข้อใหม่
import { describe, it, expect } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { fmtSecs, parseCooldowns } from "../pages/Abuse";
import { guardLabel } from "../pages/Playground";
import { installFetch } from "./mockApi";

const wait = (ms = 120) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const CFG = {
  enabled: true, preset: "normal", window_s: 600, cache_after: 2, warn_after: 4, block_after: 7, cooldown_s: [60, 300, 1800], strike_decay_s: 3600,
  rate_per_min: 20, max_chars: 1500, exempt_playground: true, cache_ttl_s: 600, warn_reply: "เตือน", block_reply: "พัก", rate_reply: "ถี่", long_reply: "ยาว",
};
const PRESETS = {
  lenient: { label: "ผ่อนปรน", hint: "ให้ถามซ้ำได้หลายครั้ง", cache_after: 3, warn_after: 6, block_after: 10, cooldown_s: [30, 120, 600], rate_per_min: 40 },
  normal: { label: "ปกติ", hint: "สมดุล", cache_after: 2, warn_after: 4, block_after: 7, cooldown_s: [60, 300, 1800], rate_per_min: 20 },
  strict: { label: "เข้มงวด", hint: "ตัดเร็ว", cache_after: 1, warn_after: 2, block_after: 4, cooldown_s: [120, 900, 3600], rate_per_min: 10 },
};
const STATUS = {
  cooling: [{ client: "key:1:A", retry_after: 90, strikes: 1 }], clients: 1, cache_size: 0,
  counters: { allow: 5, cached: 2, warn: 1, block: 1, rate: 0, long: 0 }, events: [],
};

describe("ฟังก์ชันช่วย", () => {
  it("แปลงระยะพักและเวลา", () => {
    expect(parseCooldowns("60, 300 x 1800")).toEqual([60, 300, 1800]);
    expect(fmtSecs(45)).toBe("45 วินาที");
    expect(fmtSecs(90)).toBe("1 นาที 30 วินาที");
    expect(fmtSecs(3600)).toBe("1 ชั่วโมง");
  });
  it("ชื่อชนิดการตอบตามขอบเขต", () => {
    expect(guardLabel("canned|identity")).toBe("คำตอบสำเร็จรูป");
    expect(guardLabel("unverified_number|verify-numbers")).toBe("เลขไม่ตรงเอกสาร");
    expect(guardLabel("abuse_block")).toBe("พักการใช้งานชั่วคราว");
    expect(guardLabel("no_context|x")).toBe("ไม่พบเอกสารที่เกี่ยวข้อง");
  });
});

describe("หน้าป้องกันถามซ้ำ/สแปม", () => {
  it("แสดงพรีเซ็ต คนที่ถูกพัก และปลดล็อกได้", async () => {
    const { calls } = installFetch({
      "GET /api/abuse": { config: CFG, default: CFG, presets: PRESETS, status: STATUS },
      "POST /api/abuse/unlock": { ok: true },
    });
    render(<MemoryRouter initialEntries={["/abuse"]}><App /></MemoryRouter>);
    await wait(300);
    expect(await screen.findByText("ผ่อนปรน")).toBeTruthy();
    expect(screen.getByText("key:1:A")).toBeTruthy();
    fireEvent.click(screen.getByText("ปลดล็อก"));
    await wait(100);
    expect(calls.some((c) => c.path === "/api/abuse/unlock" && (c.body as { client: string }).client === "key:1:A")).toBe(true);
  });

  it("เลือกพรีเซ็ตแล้วต้องกดบันทึก และจำลองส่งค่าที่กำลังแก้ไป", async () => {
    const { calls } = installFetch({
      "GET /api/abuse": { config: CFG, default: CFG, presets: PRESETS, status: { ...STATUS, cooling: [] } },
      "PUT /api/abuse": { config: { ...CFG, ...PRESETS.strict, preset: "strict" } },
      "POST /api/abuse/simulate": { rows: [{ n: 1, at_s: 0, action: "allow", reason: "", retry_after: 0, count: 1 }, { n: 2, at_s: 5, action: "cached", reason: "repeat", retry_after: 0, count: 3 }], model_calls: 1, saved: 1, total: 2 },
    });
    render(<MemoryRouter initialEntries={["/abuse"]}><App /></MemoryRouter>);
    await wait(300);
    fireEvent.click(await screen.findByText("เข้มงวด"));
    fireEvent.click(screen.getByText("จำลอง"));
    await wait(100);
    const sim = calls.find((c) => c.path === "/api/abuse/simulate")!;
    expect((sim.body as { config: { block_after: number } }).config.block_after).toBe(4);   // ใช้ค่าที่ยังไม่บันทึก
    expect((await screen.findAllByText("ใช้คำตอบเดิม")).length).toBeGreaterThan(1);   // หัวคำอธิบาย + ผลในตารางจำลอง
    expect(screen.getByText(/ประหยัด/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.click(screen.getByText("บันทึก"));
    await wait(100);
    expect(calls.some((c) => c.method === "PUT" && (c.body as { preset: string }).preset === "strict")).toBe(true);
  });
});

describe("หน้าขอบเขตการตอบ 0.8.5", () => {
  it("มีหัวข้อคำตอบสำเร็จรูปและตรวจเลข", async () => {
    installFetch({
      "GET /api/scope": {
        scope: { enabled: true, require_context: true, no_info_reply: "ไม่มีข้อมูล", smalltalk_keywords: ["สวัสดี"], verify_numbers: true, number_whitelist: ["1669"], number_reply: "เลขไม่ตรง",
          rules: [{ id: "identity", name: "แนะนำตัว", kind: "canned", enabled: true, keywords: ["คุณคือใคร"], reply: "ฉันคือผู้ช่วย" }] },
        default: {}, kb_min_score: 0.2, kb_top_k: 4, default_system_prompt: "",
      },
    });
    render(<MemoryRouter initialEntries={["/scope"]}><App /></MemoryRouter>);
    await wait(300);
    expect((await screen.findAllByText("คำตอบสำเร็จรูป")).length).toBeGreaterThan(0);
    expect(screen.getByText("ตรวจเลขในคำตอบ")).toBeTruthy();
    expect(screen.getByDisplayValue("แนะนำตัว")).toBeTruthy();
  });
});
