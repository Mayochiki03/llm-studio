// เทสต์ "ทุกหน้าเปิดได้ ไม่ขึ้นจอว่าง/หน้าพัง" ด้วย backend จำลอง
// จำลองสถานการณ์จริงหลายแบบ: ข้อมูลปกติ, ข้อมูลว่าง, backend ไม่ตอบ, Ollama ส่งข้อมูลรูปแบบแปลก
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { installFetch, jsonRes, ndjson, type Routes } from "./mockApi";

const ROUTES = ["/", "/train", "/import", "/eval", "/models", "/kb", "/playground", "/registry", "/datasets", "/system", "/settings", "/scope", "/connect", "/glossary", "/jobs/abc"];
const CRASH = "หน้านี้แสดงผลไม่ได้";

async function open(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
  // รอให้คำขอเริ่มต้นเสร็จและหน้านิ่ง
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
}

// ถ้าพัง ให้แนบข้อความ error จริงของหน้านั้นมาในผลเทสต์ จะได้รู้สาเหตุทันที
const noCrash = () => {
  const el = screen.queryByText(CRASH);
  if (el) throw new Error("หน้าพัง: " + (el.parentElement?.parentElement?.textContent ?? "").slice(0, 600));
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {}); // React เขียน error ลง console ตอนทดสอบ ไม่ต้องรก
});

describe("ทุกหน้าเปิดได้ (ข้อมูลปกติ)", () => {
  for (const p of ROUTES) {
    it(`เปิด ${p} ไม่พัง`, async () => {
      installFetch();
      await open(p);
      noCrash();
    });
  }
});

describe("backend ไม่ตอบเลย (เครือข่ายล่ม)", () => {
  for (const p of ROUTES) {
    it(`เปิด ${p} ไม่พัง`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
      await open(p);
      noCrash();
    });
  }
});

describe("backend ตอบ 500 ทุกอย่าง", () => {
  for (const p of ROUTES) {
    it(`เปิด ${p} ไม่พัง`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ detail: "boom" }, 500)));
      await open(p);
      noCrash();
    });
  }
});

describe("ข้อมูลรูปแบบแปลก (เคสที่ทำให้หน้าจอว่างได้)", () => {
  const weird: Routes = {
    // Ollama ส่งรายการที่ไม่มีชื่อ / ชื่อเป็นตัวเลข / null
    "GET /api/ollama/models": { models: [null, {}, { name: 123 }, { name: "qwen2.5:3b" }, { name: "qwen2.5:3b" }] },
    "GET /api/registry": [{ id: "v1", name: "m", status: "active", eval: {}, base_model: "", job_id: "", dataset_id: "", dataset_version: "", notes: "" }],
    "GET /api/kb/docs": [{ id: "d1", title: "เอกสาร", kind: "text", category: "", tags: [], enabled: 1, version: 1, source_name: "", chunks: 0, embedded: 0, updated_at: 0, created_at: 0 }],
    "GET /api/jobs": [{ id: "j1", base_model: "unsloth/Qwen2.5-3B", dataset: "d", output_name: "o", status: "mystery", created_at: 0, updated_at: 0, loss_points: [], log_tail: [] }],
  };
  for (const p of ["/playground", "/models", "/registry", "/kb", "/"]) {
    it(`เปิด ${p} ไม่พัง`, async () => {
      installFetch(weird);
      await open(p);
      noCrash();
    });
  }
  it("ถ้า Ollama ส่งโครงสร้างผิด (ไม่มี models) หน้า Playground ยังเปิดได้", async () => {
    installFetch({ "GET /api/ollama/models": { error: "x" } });
    await open("/playground");
    noCrash();
  });
});

describe("Playground", () => {
  it("แสดงเฉพาะโมเดลแชท (ตัด embedding) และสตรีมคำตอบพร้อมแหล่งที่มา", async () => {
    const { calls } = installFetch({
      "POST /api/playground/chat": () =>
        ndjson([
          { type: "sources", mode: "hybrid", hits: [{ doc_id: "d1", title: "คู่มือ", text: "เนื้อหา", score: 0.9 }] },
          { type: "token", content: "สวัสดี" },
          { type: "token", content: "ครับ" },
          { type: "done", stats: "10 tok/s" },
        ]),
    });
    await open("/playground");
    const box = await screen.findByPlaceholderText(/พิมพ์|ถาม/);
    fireEvent.change(box, { target: { value: "ทดสอบ" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/playground/chat")).toBe(true));
    noCrash();
    const chat = calls.find((c) => c.path === "/api/playground/chat")!;
    expect((chat.body as any).model).toBe("qwen2.5:3b"); // ไม่เลือก bge-m3
  });

  it("เมื่อสตรีมพังกลางทาง ยังไม่ทำให้หน้าพัง", async () => {
    installFetch({
      "POST /api/playground/chat": () => {
        const s = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"type":"token","content":"a"}\n{bad json\n')); c.error(new Error("connection reset")); } });
        return new Response(s, { status: 200 });
      },
    });
    await open("/playground");
    const box = await screen.findByPlaceholderText(/พิมพ์|ถาม/);
    fireEvent.change(box, { target: { value: "x" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    noCrash();
  });
});

describe("Playground จำบทสนทนาข้ามหน้า", () => {
  it("ถามแล้วสลับไปหน้าอื่น กลับมายังเห็นคำถามและคำตอบเดิม", async () => {
    installFetch({
      "POST /api/playground/chat": () => ndjson([{ type: "delta", text: "คำตอบทดสอบ" }, { type: "done", total_s: 1, tokens_per_s: 5 }]),
    });
    sessionStorage.clear();
    localStorage.clear();
    const { unmount } = render(<MemoryRouter initialEntries={["/playground"]}><App /></MemoryRouter>);
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    const box = await screen.findByPlaceholderText(/พิมพ์|ถาม/);
    fireEvent.change(box, { target: { value: "คำถามที่ต้องจำ" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("คำตอบทดสอบ");
    unmount();
    // เปิดใหม่ (เหมือนกลับมาจากหน้าอื่น)
    await open("/playground");
    expect(screen.getByText("คำถามที่ต้องจำ")).toBeTruthy();
    expect(screen.getByText("คำตอบทดสอบ")).toBeTruthy();
    // กดล้างแล้วต้องหาย
    fireEvent.click(screen.getByText("ล้างบทสนทนา"));
    expect(screen.queryByText("คำถามที่ต้องจำ")).toBeNull();
  });
});

describe("การเข้าสู่ระบบ", () => {
  it("เปิดล็อกอินและยังไม่มีโทเคน → ขึ้นหน้ากรอกรหัส ไม่ใช่จอว่าง", async () => {
    installFetch({ "GET /api/auth/status": { enabled: true } });
    await open("/");
    expect(await screen.findByPlaceholderText(/รหัสผ่าน/)).toBeTruthy();
  });
});
