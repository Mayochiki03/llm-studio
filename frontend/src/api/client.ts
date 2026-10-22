import type {
  BaseModel,
  DatasetOption,
  EvalPrompt,
  EvalRun,
  HFSearchResult,
  Job,
  LeaderboardRow,
  OllamaModel,
  QAPair,
  Settings,
  Hardware,
  PreflightResult,
  QueueInfo,
  KbDoc,
  KbStats,
  KbHit,
  KbHistory,
  DatasetVersion,
  PiiScan,
  ModelVersion,
  ModelEvent,
  CompareResult,
  DiskInfo,
  BackupInfo,
  AuditRow,
  TuningRec,
  Dashboard,
  ApiKey,
  KbTest,
  KbTestRun,
  PiiScanKb,
} from "../types";

const BASE = "/api";
const TOKEN_KEY = "llm-studio-token";

/** อ่าน/เก็บโทเคนล็อกอิน (ห่อ try/catch เผื่อเบราว์เซอร์ปิดการเก็บข้อมูล) */
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setToken(t: string) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ไม่มีที่เก็บก็ข้ามไป ต้องล็อกอินใหม่ทุกครั้งที่รีเฟรช */
  }
}

/** error จาก backend: เก็บ status และรายละเอียด (detail) ไว้ให้หน้าเว็บตัดสินใจ เช่น 409 ของ Preflight/PII */
export class ApiError extends Error {
  status: number;
  detail: any;
  constructor(status: number, detail: any, message: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** แปลงคำตอบ error ของ FastAPI เป็นข้อความอ่านง่าย */
async function toError(res: Response): Promise<ApiError> {
  let detail: any = null;
  try {
    detail = (await res.json()).detail;
  } catch {
    /* ไม่ใช่ JSON */
  }
  if (res.status === 401) window.dispatchEvent(new Event("auth-required"));
  const msg =
    typeof detail === "string"
      ? detail
      : detail?.message ?? (res.status === 401 ? "ต้องเข้าสู่ระบบ" : `${res.status} ${res.statusText}`);
  return new ApiError(res.status, detail, msg);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw await toError(res);
  return res.json();
}

const json = (body: unknown) => JSON.stringify(body);
const post = <T,>(path: string, body?: unknown) =>
  req<T>(path, { method: "POST", body: body === undefined ? undefined : json(body) });
const put = <T,>(path: string, body: unknown) => req<T>(path, { method: "PUT", body: json(body) });
const del = <T,>(path: string) => req<T>(path, { method: "DELETE" });

/** ดาวน์โหลดไฟล์ที่ต้องแนบโทเคน (ลิงก์ตรงใช้ไม่ได้เมื่อเปิดล็อกอิน) */
export async function downloadFile(path: string, filename: string) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw await toError(res);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const api = {
  health: () => req<{ ok: boolean; project_root: string; version?: string; auth?: boolean; ollama?: boolean }>("/health"),

  baseModels: () => req<BaseModel[]>("/catalog/base-models"),
  addBaseModel: (m: Omit<BaseModel, "builtin">) =>
    req<BaseModel[]>("/catalog/base-models", { method: "POST", body: JSON.stringify(m) }),
  deleteBaseModel: (id: string) =>
    req<BaseModel[]>(`/catalog/base-models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  datasets: () => req<DatasetOption[]>("/catalog/datasets"),
  addHFDataset: (d: { id: string; label: string; sizeHint?: string; notes?: string }) =>
    req<DatasetOption[]>("/catalog/datasets", { method: "POST", body: JSON.stringify(d) }),
  deleteDataset: (id: string) =>
    req<DatasetOption[]>(`/catalog/datasets/${encodeURIComponent(id)}`, { method: "DELETE" }),
  createCustomDataset: (label: string, notes: string, examples: QAPair[]) =>
    req<DatasetOption[]>("/catalog/custom-datasets", {
      method: "POST",
      body: JSON.stringify({ label, notes, examples }),
    }),

  searchHFModels: (q: string) => req<{ results: HFSearchResult[] }>(`/hf/search/models?q=${encodeURIComponent(q)}`),
  searchHFDatasets: (q: string) => req<{ results: HFSearchResult[] }>(`/hf/search/datasets?q=${encodeURIComponent(q)}`),

  aiStatus: () => req<{ configured: boolean; provider: string }>("/ai/status"),
  generateDataset: (raw_text: string, num_pairs: number) =>
    req<{ ok: boolean; pairs?: QAPair[]; error?: string }>("/ai/generate-dataset", {
      method: "POST",
      body: JSON.stringify({ raw_text, num_pairs }),
    }),

  listJobs: () => req<Job[]>("/jobs"),
  getJob: (id: string) => req<Job>(`/jobs/${id}`),
  createJob: (body: {
    base_model: string;
    dataset: string;
    output_name: string;
    r: number;
    lora_alpha: number;
    max_seq_length: number;
    num_train_epochs: number;
    sample_size: number;
    preset?: string;
    batch_size?: number;
    grad_accum?: number;
    learning_rate?: number;
    packing?: boolean;
    val_ratio?: number;
    system_prompt?: string;
    template_mode?: "auto" | "legacy";
    start_at?: number | null;
    max_minutes?: number;
    pii_ack?: boolean;
    force?: boolean;
  }) => req<Job>("/jobs", { method: "POST", body: JSON.stringify(body) }),
  stopJob: (id: string) => req<{ ok: boolean }>(`/jobs/${id}/stop`, { method: "POST" }),
  resumeJob: (id: string) => req<Job>(`/jobs/${id}/resume`, { method: "POST" }),
  cleanupJob: (id: string) =>
    req<{ ok: boolean; removed: string[] }>(`/jobs/${id}/cleanup`, { method: "POST" }),


exportGguf: (id: string, quantization = "q4_k_m") =>
    req<{
      gguf_file: any; ok: boolean; gguf_dir: string 
}>(`/jobs/${id}/export`, {
      method: "POST",
      body: JSON.stringify({ job_id: id, quantization }),
    }),

  listGgufFiles: (id: string) =>
    req<{ gguf_dir: string | null; files: string[] }>(`/jobs/${id}/gguf-files`),

  
  createOllamaModel: (body: {
    model_name: string;
    gguf_path: string;
    system_prompt?: string;
    stop_token?: string;
    num_ctx?: number;
    temperature?: number;
    job_id?: string;
    base_model?: string;
  }) => req<{ ok: boolean; stdout: string; stderr: string }>("/ollama/create", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  // กรองรายการที่ไม่มีชื่อออก กันข้อมูลผิดรูปจาก Ollama ทำให้หน้า Models/Playground พัง
  ollamaModels: () =>
    req<{ models: OllamaModel[] }>("/ollama/models").then((r) => ({
      ...r,
      models: (Array.isArray(r?.models) ? r.models : []).filter((m) => m && typeof m.name === "string" && m.name),
    })),
  ollamaChat: (model: string, message: string) =>
    req<{ reply?: string; error?: string }>("/ollama/chat", {
      method: "POST",
      body: JSON.stringify({ model, message }),
    }),
  deleteOllamaModel: (name: string) =>
    req<{ ok: boolean }>(`/ollama/models/${encodeURIComponent(name)}`, { method: "DELETE" }),

  jobSocket: (id: string) => {
    const t = getToken();
    return new WebSocket(`${location.origin.replace("http", "ws")}/api/jobs/${id}/ws${t ? `?token=${encodeURIComponent(t)}` : ""}`);
  },

  evalPrompts: () => req<EvalPrompt[]>("/eval/prompts"),
  addEvalPrompt: (text: string, category: string) =>
    req<EvalPrompt[]>("/eval/prompts", { method: "POST", body: JSON.stringify({ text, category }) }),
  deleteEvalPrompt: (id: string) => req<EvalPrompt[]>(`/eval/prompts/${id}`, { method: "DELETE" }),
  runEval: (model: string, prompt_ids: string[]) =>
    req<EvalRun>("/eval/run", { method: "POST", body: JSON.stringify({ model, prompt_ids }) }),
  evalRuns: () => req<EvalRun[]>("/eval/runs"),
  rateResult: (runId: string, resultId: string, rating: number) =>
    req<EvalRun>(`/eval/runs/${runId}/results/${resultId}/rate`, {
      method: "POST",
      body: JSON.stringify({ rating }),
    }),
  leaderboard: () => req<LeaderboardRow[]>("/eval/leaderboard"),
  updateEvalPrompt: (id: string, patch: Partial<Pick<EvalPrompt, "text" | "category" | "expect" | "must_not" | "red_flag" | "pinned">>) =>
    put<EvalPrompt[]>(`/eval/prompts/${id}`, patch),
  compare: (models: string[], pinned_only: boolean, prompt_ids: string[] = []) =>
    post<CompareResult>("/eval/compare", { models, pinned_only, prompt_ids }),

  // ---- ใหม่ใน 0.5 ----
  authStatus: () => req<{ enabled: boolean }>("/auth/status"),
  login: (password: string) => post<{ ok: boolean; token: string }>("/auth/login", { password }),
  setPassword: (password: string) => post<{ ok: boolean; token: string }>("/auth/set-password", { password }),
  disableAuth: () => post<{ ok: boolean }>("/auth/disable"),

  settings: () => req<Settings>("/settings"),
  saveSettings: (patch: Partial<Settings>) => put<Settings>("/settings", patch),

  dashboard: () => req<Dashboard>("/dashboard"),
  hardware: () => req<Hardware>("/system/hardware"),
  preflight: (body: { base_model: string; max_seq_length: number; batch_size?: number; export_after?: boolean }) =>
    post<PreflightResult>("/preflight", body),
  queue: () => req<QueueInfo>("/queue"),
  prioritize: (id: string) => post<QueueInfo>(`/jobs/${id}/prioritize`),

  // คลังความรู้
  kbStats: () => req<KbStats>("/kb/stats"),
  kbCategories: () => req<string[]>("/kb/categories"),
  kbDocs: (q = "", category = "", kind = "") =>
    req<KbDoc[]>(`/kb/docs?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&kind=${encodeURIComponent(kind)}`),
  kbDoc: (id: string) => req<KbDoc>(`/kb/docs/${id}`),
  kbAdd: (b: { title: string; text: string; category: string; tags: string[]; pii_ack?: boolean }) =>
    post<{ doc: KbDoc; embed: { error?: string } }>("/kb/docs", b),
  kbAddQa: (b: { question: string; answer: string; category: string; tags: string[]; pii_ack?: boolean }) =>
    post<{ doc: KbDoc; embed: { error?: string } }>("/kb/qa", b),
  kbUpdate: (id: string, b: Partial<{ title: string; text: string; category: string; tags: string[]; enabled: boolean; pii_ack: boolean }>) =>
    put<{ doc: KbDoc; embed: { error?: string } }>(`/kb/docs/${id}`, b),
  kbDelete: (id: string) => del<{ ok: boolean }>(`/kb/docs/${id}`),
  kbHistory: (id: string) => req<KbHistory[]>(`/kb/docs/${id}/history`),
  kbRestore: (id: string, hid: number) => post<{ doc: KbDoc }>(`/kb/docs/${id}/restore/${hid}`),
  kbPreviewChunks: (text: string, size?: number, overlap?: number) =>
    post<{ count: number; chunks: string[] }>("/kb/preview-chunks", { text, size, overlap }),
  kbUpload: (files: File[], category: string, tags: string, pii_ack = false) => {
    const f = new FormData();
    f.append("pii_ack", pii_ack ? "true" : "false");
    files.forEach((x) => f.append("files", x));
    f.append("category", category);
    f.append("tags", tags);
    return req<{ added: number; files: { file: string; ok: boolean; docs?: number; error?: string; pii?: boolean }[]; embed: { error?: string } }>(
      "/kb/upload",
      { method: "POST", body: f }
    );
  },
  kbEmbed: () => post<{ embedded_now: number; remaining: number; error?: string }>("/kb/embed"),
  kbSearch: (query: string, top_k?: number) =>
    post<{ mode: string; note?: string; hits: KbHit[] }>("/kb/search", { query, top_k }),
  kbImport: (text: string) => post<{ added?: number; skipped?: number; error?: string }>("/kb/import", { text }),

  /** แชทแบบสตรีม (NDJSON) เรียก onEvent ทีละบรรทัด; ยกเลิกได้ด้วย signal */
  playground: async (
    body: { model: string; message: string; history: { role: string; content: string }[]; use_kb: boolean; system_prompt?: string; temperature?: number; top_k?: number },
    onEvent: (ev: any) => void,
    signal?: AbortSignal
  ) => {
    const res = await fetch(`${BASE}/playground/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: json(body),
      signal,
    });
    if (!res.ok || !res.body) throw await toError(res);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          try {
            onEvent(JSON.parse(line));
          } catch {
            /* บรรทัดเสีย ข้าม */
          }
        }
      }
    }
  },

  // ชุดข้อมูล
  dsScan: (examples: QAPair[]) => post<PiiScan>("/datasets/scan", { examples }),
  dsVersions: (id: string) => req<DatasetVersion[]>(`/datasets/${id}/versions`),
  dsPreview: (id: string, version = 0) => req<{ total: number; examples: QAPair[] }>(`/datasets/${id}/preview?version=${version}&limit=20`),
  dsScanOne: (id: string) => req<PiiScan>(`/datasets/${id}/scan`),
  dsAppend: (id: string, examples: QAPair[], note = "") => post<any>(`/datasets/${id}/append`, { examples, note }),
  dsRestore: (id: string, version: number) => post<any>(`/datasets/${id}/restore`, { version }),
  dsFromKb: (label: string, notes = "") => post<any>("/datasets/from-kb", { label, notes }),

  // ทะเบียนโมเดล
  registry: () => req<ModelVersion[]>("/registry"),
  registryEvents: (vid = "") => req<ModelEvent[]>(`/registry/events?version_id=${vid}`),
  registryAdd: (name: string, base_model = "", notes = "") => post<ModelVersion>("/registry", { name, base_model, notes }),
  registryApprove: (id: string) => post<ModelVersion>(`/registry/${id}/approve`),
  registryActivate: (id: string) => post<ModelVersion>(`/registry/${id}/activate`),
  registryArchive: (id: string) => post<ModelVersion>(`/registry/${id}/archive`),
  registryRollback: () => post<ModelVersion>("/registry/rollback"),
  registryNotes: (id: string, notes: string) => put<ModelVersion>(`/registry/${id}/notes`, { notes }),
  registryDelete: (id: string) => del<{ ok: boolean }>(`/registry/${id}`),
  registryEval: (id: string) => post<ModelVersion>(`/registry/${id}/eval`),

  // ระบบ
  disk: () => req<DiskInfo>("/system/disk"),
  diskDelete: (name: string) => del<{ ok: boolean; freed_gb: number }>(`/system/disk/${encodeURIComponent(name)}`),
  cleanupScripts: () => post<{ removed: number }>("/system/cleanup-scripts"),
  backups: () => req<BackupInfo[]>("/system/backups"),
  backupCreate: () => post<BackupInfo>("/system/backups"),
  backupRestore: (name: string) => post<{ ok: boolean; safety_backup: string }>(`/system/backups/${encodeURIComponent(name)}/restore`),
  backupRestoreUpload: (file: File) => {
    const f = new FormData();
    f.append("file", file);
    return req<{ ok: boolean; safety_backup: string }>("/system/restore-upload", { method: "POST", body: f });
  },
  audit: (limit = 200) => req<AuditRow[]>(`/system/audit?limit=${limit}`),
  ollamaTuning: () => req<TuningRec[]>("/system/ollama-tuning"),

  // ---- 0.6.0 ----
  kbPiiScan: () => req<PiiScanKb>("/kb/pii-scan"),
  kbTests: () => req<KbTest[]>("/kb/tests"),
  kbTestAdd: (question: string, expect_doc_ids: string[]) => post<KbTest>("/kb/tests", { question, expect_doc_ids }),
  kbTestDelete: (id: string) => del<{ ok: boolean }>(`/kb/tests/${id}`),
  kbTestRun: () => post<KbTestRun>("/kb/tests/run"),

  apiKeys: () => req<ApiKey[]>("/apikeys"),
  apiKeyCreate: (name: string) => post<{ id: string; name: string; key: string }>("/apikeys", { name }),
  apiKeyEnable: (id: string, enabled: boolean) => post<ApiKey[]>(`/apikeys/${id}/enabled`, { enabled }),
  apiKeyDelete: (id: string) => del<{ ok: boolean }>(`/apikeys/${id}`),

  logs: (name: "backend" | "client", lines = 300) => req<{ name: string; lines: string[] }>(`/system/logs/${name}?lines=${lines}`),
  diagnostics: () => req<Record<string, unknown>>("/system/diagnostics"),
};
