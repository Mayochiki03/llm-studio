// ตัวจำลอง backend สำหรับเทสต์: แทน fetch ด้วยตารางเส้นทาง → ข้อมูลตัวอย่างหน้าตาเหมือนของจริง
// path ที่ไม่ได้จำลองจะตอบ 404 เหมือน backend ที่ไม่มี endpoint นั้น (หน้าต้องไม่พังเพราะเรื่องนี้)
import { vi } from "vitest";

export type Handler = (url: URL, init?: RequestInit) => unknown | Response;
export type Routes = Record<string, Handler | unknown>;

const GPU = { name: "RTX 3050", vram_total_gb: 4, vram_used_gb: 1, vram_free_gb: 3, temp_c: 50, util_pct: 5 };
const HW = {
  gpus: [GPU], gpu: GPU, ram: { total_gb: 16, available_gb: 8 }, disk: { total_gb: 500, free_gb: 200 },
  cpu: { threads: 8, name: "cpu" }, os: "Linux", ollama_up: true, ollama_running: [],
};

/** ข้อมูลพื้นฐานที่ทุกหน้าใช้ ปรับเฉพาะส่วนต่อเทสต์ได้ด้วย overrides */
export function baseRoutes(): Routes {
  return {
    "GET /api/auth/status": { enabled: false },
    "GET /api/health": { ok: true, project_root: "/tmp/x", version: "0.6.0", auth: false, ollama: true },
    "GET /api/settings": {
      ollama_url: "http://localhost:11434", embed_model: "bge-m3", keep_alive: "30m", unload_before_train: true, reload_after_train: true,
      network_mode: "safe", max_train_minutes: 0, default_system_prompt: "", kb_chunk_size: 500, kb_chunk_overlap: 50, kb_top_k: 4,
      kb_min_score: 0.3, auth: { enabled: false }, cors_origins: [], auto_backup: true, backup_keep: 7, kb_pii_block: true,
    },
    "GET /api/ai/status": { configured: false, provider: "gemini" },
    "GET /api/catalog/base-models": [],
    "GET /api/catalog/datasets": [],
    "GET /api/jobs": [],
    "GET /api/queue": { running: null, waiting: [] },
    "GET /api/ollama/models": { models: [{ name: "qwen2.5:3b" }, { name: "bge-m3:latest" }] },
    "GET /api/eval/prompts": [],
    "GET /api/eval/runs": [],
    "GET /api/eval/leaderboard": [],
    "GET /api/kb/stats": { docs: 0, enabled: 0, chunks: 0, embedded: 0, embed_model: "bge-m3" },
    "GET /api/kb/categories": [],
    "GET /api/kb/docs": [],
    "GET /api/kb/tests": [],
    "GET /api/registry": [],
    "GET /api/registry/events": [],
    "GET /api/datasets": [],
    "GET /api/apikeys": [],
    "GET /api/audit": [],
    "GET /api/system/backups": [],
    "GET /api/system/ollama-tuning": [],
    "GET /api/system/logs/backend": { name: "backend", lines: ["2026-10-21 INFO started"] },
    "GET /api/system/logs/client": { name: "client", lines: [] },
    "GET /api/system/disk": { disk: { total_gb: 500, free_gb: 200 }, breakdown: { total_gb: 20, items: [] } },
    "GET /api/system/hardware": HW,
    "GET /api/dashboard": {
      active_model: null, kb: { docs: 0, enabled: 0, chunks: 0, embedded: 0, embed_model: "bge-m3" }, queue: { running: null, waiting: [] },
      recent_jobs: [], hardware: HW, ollama_up: true,
      registry_counts: { candidate: 0, approved: 0, active: 0, archived: 0 },
    },
  };
}

/** สร้าง Response แบบ JSON */
export const jsonRes = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** สร้าง Response แบบสตรีม NDJSON (ไว้เทสต์ Playground) */
export function ndjson(events: unknown[], chunk = 1): Response {
  const lines = events.map((e) => JSON.stringify(e) + "\n");
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      for (let i = 0; i < lines.length; i += chunk) {
        c.enqueue(enc.encode(lines.slice(i, i + chunk).join("")));
        await new Promise((r) => setTimeout(r, 0));
      }
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

/** ติดตั้ง fetch จำลอง คืนรายการคำขอที่ถูกเรียก (ไว้ assert) */
export function installFetch(overrides: Routes = {}) {
  const routes: Routes = { ...baseRoutes(), ...overrides };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* ข้อความธรรมดา */ } }
    calls.push({ method, path: url.pathname, body });
    const h = routes[`${method} ${url.pathname}`];
    if (h === undefined) return jsonRes({ detail: `ไม่ได้จำลอง ${method} ${url.pathname}` }, 404);
    const out = typeof h === "function" ? (h as Handler)(url, init) : h;
    return out instanceof Response ? out : jsonRes(out);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}
