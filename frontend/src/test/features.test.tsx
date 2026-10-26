// เทสต์ฟีเจอร์เฉพาะของ 0.6.0: ตัวส่ง log, ApiError, ยืนยัน PII, หน้าดู log, ความยาวรหัสผ่าน
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { api, ApiError } from "../api/client";
import { reportError, recentErrors } from "../lib/clientLog";
import { installFetch, jsonRes } from "./mockApi";

const wait = (ms = 80) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function open(path: string) {
  render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
  await wait();
}

describe("api client", () => {
  it("409 จาก backend กลายเป็น ApiError ที่มี status และ detail", async () => {
    installFetch({ "POST /api/kb/docs": () => jsonRes({ detail: { code: "pii", by_type: { thai_id: 1 }, message: "พบข้อมูล" } }, 409) });
    const err = await api.kbAdd({ title: "a", text: "b", category: "", tags: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.detail.code).toBe("pii");
    expect(err.message).toBe("พบข้อมูล");
  });

  it("ollamaModels กรองรายการที่ไม่มีชื่อออก", async () => {
    installFetch({ "GET /api/ollama/models": { models: [null, {}, { name: 5 }, { name: "ok" }] } });
    const r = await api.ollamaModels();
    expect(r.models.map((m) => m.name)).toEqual(["ok"]);
  });
});

describe("ตัวส่ง log ฝั่งหน้าเว็บ", () => {
  it("reportError ส่งไป /api/client-log ครั้งเดียวสำหรับ error ซ้ำ และไม่ throw ถึง backend ล่ม", async () => {
    const { calls } = installFetch({ "POST /api/client-log": { ok: true } });
    reportError("test", new Error("พังตัวอย่าง-A"));
    reportError("test", new Error("พังตัวอย่าง-A"));
    await wait(20);
    const sent = calls.filter((c) => c.path === "/api/client-log");
    expect(sent.length).toBe(1);
    expect((sent[0].body as any).message).toContain("พังตัวอย่าง-A");
    expect(recentErrors().length).toBeGreaterThan(0);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("down"); }));
    expect(() => reportError("test", "อีกอัน")).not.toThrow();
    await wait(20);
  });
});

describe("คลังความรู้: ยืนยันข้อมูลระบุตัวตน", () => {
  it("ถูก 409 pii แล้วผู้ใช้ยืนยัน → ส่งซ้ำพร้อม pii_ack=true", async () => {
    let n = 0;
    const { calls } = installFetch({
      "POST /api/kb/docs": () => (++n === 1
        ? jsonRes({ detail: { code: "pii", by_type: { thai_id: 1 }, samples: [], message: "พบ" } }, 409)
        : { doc: { id: "d" }, embed: {} }),
    });
    await open("/kb");
    fireEvent.click(screen.getAllByText(/เพิ่มความรู้/)[0]);
    fireEvent.change(await screen.findByPlaceholderText(/ขั้นตอนส่งต่อ/), { target: { value: "หัวข้อ" } });
    const ta = document.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "เลขบัตร 1234567890123" } });
    fireEvent.click(screen.getByText("บันทึก"));
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/kb/docs" && c.method === "POST").length).toBe(2));
    const posts = calls.filter((c) => c.path === "/api/kb/docs" && c.method === "POST");
    expect((posts[0].body as any).pii_ack).toBe(false);
    expect((posts[1].body as any).pii_ack).toBe(true);
  });
});

describe("หน้าเครื่องและพื้นที่", () => {
  it("แสดง log ฝั่งเซิร์ฟเวอร์ และสลับไปฝั่งหน้าเว็บได้", async () => {
    const { calls } = installFetch();
    await open("/system");
    expect(await screen.findByText(/INFO started/)).toBeTruthy();
    fireEvent.click(screen.getByText("ฝั่งหน้าเว็บ"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/system/logs/client")).toBe(true));
  });
});

describe("ตั้งค่า", () => {
  it("รหัสผ่านสั้นกว่า 8 ตัวไม่ถูกส่งไป backend", async () => {
    const { calls } = installFetch();
    await open("/settings");
    const inputs = await screen.findAllByDisplayValue("");
    const pwInputs = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    expect(pwInputs.length).toBe(2);
    fireEvent.change(pwInputs[0], { target: { value: "1234567" } });
    fireEvent.change(pwInputs[1], { target: { value: "1234567" } });
    fireEvent.click(screen.getByText("เปิดการล็อกอิน"));
    await wait();
    expect(calls.some((c) => c.path === "/api/auth/set-password")).toBe(false);
    void inputs;
  });

  it("สร้างคีย์ API แล้วแสดงคีย์เต็มให้เห็นครั้งเดียว", async () => {
    installFetch({ "POST /api/apikeys": { id: "k1", name: "ระบบทดสอบ", key: "sk-llmstudio-abc123" } });
    await open("/connect");
    fireEvent.change(await screen.findByPlaceholderText(/ชื่อคีย์/), { target: { value: "ระบบทดสอบ" } });
    fireEvent.click(screen.getByText("สร้าง"));
    expect(await screen.findByText("sk-llmstudio-abc123")).toBeTruthy();
  });
});
