// ทดสอบ 0.8.4: เปรียบเทียบเบื้องหลังไม่หายเมื่อเปลี่ยนหน้า, ส่งต่อร่างข้อมูลสอน, จัดแถวผลเปรียบเทียบ, กราฟ loss ในการ์ด
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { splitRows } from "../components/CompareResultView";
import { progressText } from "../components/EvalCompare";
import { LossSpark } from "../components/ModelCardDialog";
import { saveFactsDraft, takeFactsDraft, hasFactsDraft } from "../lib/factsDraft";
import { installFetch } from "./mockApi";
import type { CompareResult } from "../types";

const wait = (ms = 120) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const ans = (passed: boolean | null) => ({ response: "ตอบ", passed, missing: [], violated: [] });
const RES: CompareResult = {
  models: ["a", "b"], use_kb: true, run_ids: {}, summaries: { a: { pass_rate: 1, red_flag_recall: 1, avg_latency_s: 1, avg_tokens_per_s: 5, count: 3 }, b: { pass_rate: 0.5, red_flag_recall: 0, avg_latency_s: 1, avg_tokens_per_s: 5, count: 3 } },
  rows: [
    { prompt_id: "1", prompt_text: "ผ่านทั้งคู่", answers: { a: ans(true), b: ans(true) } },
    { prompt_id: "2", prompt_text: "b พลาด", answers: { a: ans(true), b: ans(false) } },
    { prompt_id: "3", prompt_text: "red flag พลาด", red_flag: true, answers: { a: ans(false), b: ans(false) } },
  ],
};

describe("splitRows", () => {
  it("แยกข้อที่พลาด (red flag ขึ้นก่อน) ออกจากข้อที่ผ่านทั้งหมด", () => {
    const { failed, passed } = splitRows(RES);
    expect(failed.map((r) => r.prompt_id)).toEqual(["3", "2"]);
    expect(passed.map((r) => r.prompt_id)).toEqual(["1"]);
  });
});

describe("progressText", () => {
  it("บอกโมเดลที่เท่าไหร่ และข้อที่เท่าไหร่", () => {
    expect(progressText({ progress: { model: "faq-v5", model_index: 0, models_total: 2, done: 17, total: 52 } })).toBe("โมเดลที่ 1/2 (faq-v5) · ข้อ 17/52");
    expect(progressText({ progress: null })).toBe("");
  });
});

describe("ร่างข้อมูลสอนจากข้อที่พลาด", () => {
  beforeEach(() => localStorage.clear());
  it("อ่านได้ครั้งเดียวแล้วถูกลบ (กันเด้งซ้ำ)", () => {
    expect(takeFactsDraft()).toBeNull();
    saveFactsDraft({ facts: [{ topic: "ก", questions: ["ถาม"], answer: "", keywords: ["x"], kind: "missing_keyword" }], oos: ["ข"], note: "" });
    expect(hasFactsDraft()).toBe(true);
    const d = takeFactsDraft();
    expect(d?.facts[0].questions).toEqual(["ถาม"]);
    expect(hasFactsDraft()).toBe(false);
    expect(takeFactsDraft()).toBeNull();
  });
  it("ข้อมูลเสียไม่ทำให้พัง", () => {
    localStorage.setItem("llmstudio.factsDraft.v1", "{ไม่ใช่ json");
    expect(takeFactsDraft()).toBeNull();
  });
});

describe("LossSpark", () => {
  it("วาดกราฟเมื่อมีข้อมูลพอ และไม่วาดเมื่อจุดน้อยเกินไป", () => {
    const { container, rerender } = render(<LossSpark pts={[{ step: 1, train: 1, val: null }, { step: 2, train: 0.5, val: 0.6 }, { step: 3, train: 0.2, val: 0.4 }]} />);
    expect(container.querySelectorAll("path").length).toBe(2);
    rerender(<LossSpark pts={[{ step: 1, train: 1, val: null }]} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("เปรียบเทียบเบื้องหลัง: เปลี่ยนหน้าแล้วกลับมาต้องเห็นผลเดิม", () => {
  beforeEach(() => localStorage.clear());
  it("จำเลขงานไว้ แล้วโหลดผลจาก backend มาแสดงโดยไม่ต้องรันใหม่", async () => {
    localStorage.setItem("llmstudio.compare.v1", JSON.stringify({ picked: ["qwen2.5:3b"], pinnedOnly: true, useKb: true, jobId: "j1" }));
    installFetch({
      "GET /api/eval/compare/jobs": [],
      "GET /api/eval/compare/jobs/j1": { id: "j1", status: "done", created_at: 1, finished_at: 2, models: ["a", "b"], use_kb: true, n_prompts: 3, error: null, progress: null, result: RES },
      "GET /api/eval/compare/jobs/j1/analysis": { models: { a: { failed: 1, groups: [] }, b: { failed: 2, groups: [{ kind: "wrong_number", label: "เลข/เวลาผิด", advice: "ใช้คลังความรู้", count: 1, prompt_ids: ["2"] }] } }, differences: [] },
    });
    render(<MemoryRouter initialEntries={["/eval"]}><App /></MemoryRouter>);
    await wait(300);
    expect(await screen.findByText("ทดสอบแบบมีคลังความรู้", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("red flag พลาด")).toBeTruthy();                       // ข้อที่พลาดแสดงทันที
    expect(screen.queryByText("ผ่านทั้งคู่")).toBeNull();                          // ข้อที่ผ่านพับไว้
    expect(screen.getByText(/เลข\/เวลาผิด 1 ข้อ/)).toBeTruthy();                   // วิเคราะห์ขึ้น
    expect(screen.getByText(/CSV \(Excel\)/)).toBeTruthy();                       // ปุ่มส่งออก
  });

  it("งานที่กำลังรัน แสดงแถบความคืบหน้าและปุ่มหยุด", async () => {
    localStorage.setItem("llmstudio.compare.v1", JSON.stringify({ picked: [], pinnedOnly: true, useKb: false, jobId: "j2" }));
    installFetch({
      "GET /api/eval/compare/jobs": [],
      "GET /api/eval/compare/jobs/j2": { id: "j2", status: "running", created_at: 1, finished_at: null, models: ["a", "b"], use_kb: false, n_prompts: 52, error: null,
        progress: { model: "a", model_index: 0, models_total: 2, done: 17, total: 52 }, result: null },
    });
    render(<MemoryRouter initialEntries={["/eval"]}><App /></MemoryRouter>);
    await wait(300);
    expect(await screen.findByText(/โมเดลที่ 1\/2 \(a\) · ข้อ 17\/52/)).toBeTruthy();
    expect(screen.getByText("หยุด")).toBeTruthy();
  });
});
