export type JobStatus =
  | "queued"
  | "scheduled"
  | "training"
  | "exporting"
  | "creating_ollama"
  | "done"
  | "failed"
  | "stopped";

export interface BaseModel {
  id: string;
  label: string;
  params: string;
  vramFitGb: number;
  notes: string;
  recommended: boolean;
  builtin?: boolean;
}

export interface EvalPrompt {
  id: string;
  text: string;
  category: string;
  expect?: string[];
  must_not?: string[];
  red_flag?: boolean;
  pinned?: boolean;
}

export interface EvalResult {
  id: string;
  prompt_id: string;
  prompt_text: string;
  response: string;
  rating: number | null;
  passed?: boolean | null;
  red_flag?: boolean;
  missing?: string[];
  violated?: string[];
  total_s?: number | null;
  tokens_per_s?: number | null;
}

export interface EvalRun {
  id: string;
  model: string;
  created_at: number;
  results: EvalResult[];
}

export interface LeaderboardRow {
  model: string;
  avg_rating: number;
  rated_count: number;
}

export interface DatasetOption {
  id: string;
  label: string;
  sizeHint: string;
  notes: string;
  kind?: "huggingface" | "custom";
  file?: string;
}

export interface HFSearchResult {
  id: string;
  downloads: number;
  likes: number;
}

export interface QAPair {
  instruction: string;
  input?: string;
  output: string;
}

export interface LossPoint {
  step: number;
  loss: number;
  val_loss?: number; // loss ของชุดตรวจสอบ (มีเมื่อเปิดแบ่งชุด validation)
}

export interface Job {
  id: string;
  base_model: string;
  dataset: string;
  output_name: string;
  r: number;
  lora_alpha: number;
  max_seq_length: number;
  num_train_epochs: number;
  sample_size: number;
  status: JobStatus;
  created_at: number;
  updated_at: number;
  loss_points: LossPoint[];
  error?: string | null;
  log_tail: string[];
  start_at?: number | null;
  started_at?: number | null;
  finished_at?: number | null;
  preset?: string;
  batch_size?: number;
  grad_accum?: number;
  learning_rate?: number;
  packing?: boolean;
  val_ratio?: number;
  template_mode?: string;
  dataset_version?: number | string;
  timed_out?: boolean;
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface Settings {
  ollama_url: string;
  embed_model: string;
  network_mode: "safe" | "fast";
  unload_before_train: boolean;
  reload_after_train: boolean;
  keep_alive: string;
  default_system_prompt: string;
  kb_chunk_size: number;
  kb_chunk_overlap: number;
  kb_top_k: number;
  kb_min_score: number;
  max_train_minutes: number;
  cors_origins: string[];
  auth?: { enabled: boolean };
  auto_backup: boolean;
  backup_keep: number;
  kb_pii_block: boolean;
}

export interface Gpu {
  index: number;
  name: string;
  vram_total_gb: number;
  vram_used_gb: number;
  vram_free_gb: number;
  temp_c?: number;
  util_pct?: number;
}

export interface GpuLive {
  gpu: Gpu | null;
  ts: number;
  cpu_pct: number | null;
  ram_used_gb: number | null;
  ram_total_gb: number | null;
  net_rx: number | null;
  net_tx: number | null;
}

export interface Hardware {
  gpus: Gpu[];
  gpu: Gpu | null;
  ram: { total_gb: number; available_gb: number };
  disk: { total_gb: number; free_gb: number; used_gb?: number };
  cpu: { threads: number; name?: string };
  os: string;
  ollama_up?: boolean;
  ollama_running?: { name: string; size_gb: number }[];
}

export interface PreflightCheck {
  key: string;
  level: "ok" | "tight" | "no";
  title: string;
  detail: string;
}

export interface PreflightResult {
  level: "ok" | "tight" | "no";
  summary: string;
  vram_need_gb: number;
  disk_need_gb: number;
  checks: PreflightCheck[];
  recommended: { batch_size: number; grad_accum: number; packing: boolean; workers: number; note?: string };
  params_b: number;
  batch_used: number;
}

export interface QueueInfo {
  running: Job | null;
  waiting: { id: string; output_name: string; base_model: string; status: string; start_at?: number | null; position: number }[];
}

export interface KbDoc {
  id: string;
  title: string;
  kind: "text" | "qa" | "file";
  category: string;
  tags: string[];
  enabled: boolean | number;
  version: number;
  source_name: string;
  raw_text?: string;
  preview?: string;
  chunks: number;
  embedded: number;
  updated_at: number;
  created_at: number;
}

export interface KbStats {
  docs: number;
  enabled: number;
  chunks: number;
  embedded: number;
  embed_model: string;
}

export interface KbHit {
  doc_id: string;
  title: string;
  text: string;
  score: number;
  category?: string;
}

export interface KbHistory {
  id: number;
  doc_id: string;
  version: number;
  ts: number;
  action: string;
  title: string;
  raw_text: string;
}

export interface DatasetVersion {
  id: string;
  dataset_id: string;
  version: number;
  count: number;
  note: string;
  source: string;
  created_at: number;
}

export interface PiiScan {
  total: number;
  flagged: number;
  blocking: number;
  by_type: Record<string, number>;
  items: { index: number; field: string; type: string; sample: string }[];
}

export interface ModelVersion {
  id: string;
  name: string;
  base_model: string;
  job_id: string;
  dataset_id: string;
  dataset_version: string;
  status: "candidate" | "approved" | "active" | "archived";
  notes: string;
  eval: {
    pass_rate?: number | null;
    red_flag_recall?: number | null;
    avg_latency_s?: number | null;
    avg_tokens_per_s?: number | null;
    count?: number;
    at?: number;
  };
  created_at: number;
  approved_by: string;
  approved_at: number | null;
  activated_at: number | null;
}

export interface ModelEvent {
  id: number;
  ts: number;
  version_id: string;
  event: string;
  detail: string;
  actor: string;
}

export interface CompareAnswer {
  response: string;
  passed: boolean | null;
  missing: string[];
  violated: string[];
  total_s?: number | null;
  tokens_per_s?: number | null;
}

export interface CompareResult {
  models: string[];
  rows: { prompt_id: string; prompt_text?: string; red_flag?: boolean; answers: Record<string, CompareAnswer> }[];
  summaries: Record<string, { pass_rate: number | null; red_flag_recall: number | null; avg_latency_s: number | null; avg_tokens_per_s: number | null; count: number }>;
  run_ids: Record<string, string>;
}

export interface DiskItem {
  name: string;
  label: string;
  kind: string;
  deletable: boolean;
  size_gb: number;
}

export interface DiskInfo {
  disk: { total_gb: number; free_gb: number };
  breakdown: { total_gb: number; items: DiskItem[] };
}

export interface BackupInfo {
  name: string;
  size_mb: number;
  created_at?: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

export interface TuningRec {
  key: string;
  value: string;
  why: string;
  how: string;
}

export interface Dashboard {
  active_model: ModelVersion | null;
  kb: KbStats;
  queue: QueueInfo;
  recent_jobs: Job[];
  hardware: Hardware;
  ollama_up: boolean;
  registry_counts: Record<string, number>;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  enabled: number | boolean;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
}

export interface KbTest {
  id: string;
  question: string;
  expect_doc_ids: string[];
  expect_titles: string[];
  note: string;
}

export interface KbTestRun {
  mode: string;
  total: number;
  hits: number;
  hit_rate: number | null;
  mrr: number | null;
  results: { id: string; question: string; expect_titles: string[]; hit: boolean; rank: number | null; found_titles: string[] }[];
}

export interface PiiScanKb {
  scanned: number;
  flagged: { doc_id: string; title: string; by_type: Record<string, number> }[];
}

export interface PiiGate {
  code: "pii";
  by_type: Record<string, number>;
  samples: { type: string; sample: string }[];
  message: string;
}
