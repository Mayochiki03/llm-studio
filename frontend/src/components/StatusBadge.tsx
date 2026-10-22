import type { JobStatus } from "../types";

const MAP: Record<JobStatus, { label: string; cls: string }> = {
  queued: { label: "รอคิว", cls: "bg-base-700 text-base-200" },
  scheduled: { label: "ตั้งเวลาไว้", cls: "bg-accent-500/15 text-accent-300" },
  training: { label: "กำลังเทรน", cls: "bg-accent-500/15 text-accent-300 animate-pulse" },
  exporting: { label: "กำลังแปลง GGUF", cls: "bg-accent-500/15 text-accent-300 animate-pulse" },
  creating_ollama: { label: "กำลังสร้างเข้า Ollama", cls: "bg-accent-500/15 text-accent-300 animate-pulse" },
  done: { label: "เสร็จแล้ว", cls: "bg-good/15 text-good" },
  failed: { label: "ล้มเหลว", cls: "bg-bad/15 text-bad" },
  stopped: { label: "หยุดแล้ว", cls: "bg-warn/15 text-warn" },
};

export default function StatusBadge({ status }: { status: JobStatus }) {
  const m = MAP[status] ?? MAP.queued;
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}
