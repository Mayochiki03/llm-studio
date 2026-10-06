export type JobStatus =
  | "queued"
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
}

export interface EvalResult {
  id: string;
  prompt_id: string;
  prompt_text: string;
  response: string;
  rating: number | null;
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
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}
