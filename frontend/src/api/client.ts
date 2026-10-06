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
} from "../types";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  health: () => req<{ ok: boolean; project_root: string }>("/health"),

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
  }) => req<{ ok: boolean; stdout: string; stderr: string }>("/ollama/create", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  ollamaModels: () => req<{ models: OllamaModel[] }>("/ollama/models"),
  ollamaChat: (model: string, message: string) =>
    req<{ reply?: string; error?: string }>("/ollama/chat", {
      method: "POST",
      body: JSON.stringify({ model, message }),
    }),
  deleteOllamaModel: (name: string) =>
    req<{ ok: boolean }>(`/ollama/models/${encodeURIComponent(name)}`, { method: "DELETE" }),

  jobSocket: (id: string) => new WebSocket(`${location.origin.replace("http", "ws")}/api/jobs/${id}/ws`),

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
};
