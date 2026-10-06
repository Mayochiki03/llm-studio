import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Topbar from "../components/Topbar";
import { Card, CardHeader } from "../components/Card";
import Button from "../components/Button";
import StatusBadge from "../components/StatusBadge";
import { api } from "../api/client";
import type { Job, OllamaModel } from "../types";
import { FlaskConical, Boxes, ArrowRight, Clock } from "lucide-react";

function timeAgo(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "เมื่อครู่";
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชม.ที่แล้ว`;
  return `${Math.floor(s / 86400)} วันที่แล้ว`;
}

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.listJobs(), api.ollamaModels()])
      .then(([j, m]) => {
        setJobs(j);
        setModels(m.models ?? []);
      })
      .finally(() => setLoading(false));
    const t = setInterval(() => api.listJobs().then(setJobs).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, []);

  const active = jobs.filter((j) => ["training", "exporting", "creating_ollama", "queued"].includes(j.status));

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="ภาพรวม" subtitle="สถานะงานเทรนและโมเดลทั้งหมดในที่เดียว" />

      <div className="p-4 md:p-8 space-y-6 max-w-6xl">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatTile label="งานที่กำลังทำงาน" value={active.length} accent="accent" />
          <StatTile label="งานเทรนทั้งหมด" value={jobs.length} accent="base" />
          <StatTile label="โมเดลใน Ollama" value={models.length} accent="good" />
        </div>

        <div className="flex flex-col sm:flex-row gap-4">
          <Link to="/train" className="flex-1">
            <Card className="p-5 hover:border-accent-500/50 transition-colors cursor-pointer h-full">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-accent-500/15 flex items-center justify-center">
                    <FlaskConical size={18} className="text-accent-400" />
                  </div>
                  <div>
                    <div className="text-sm font-medium">เริ่มเทรนโมเดลใหม่</div>
                    <div className="text-xs text-base-400">เลือกโมเดลพื้นฐาน + dataset แล้วกดเริ่มได้เลย</div>
                  </div>
                </div>
                <ArrowRight size={16} className="text-base-500" />
              </div>
            </Card>
          </Link>
          <Link to="/models" className="flex-1">
            <Card className="p-5 hover:border-accent-500/50 transition-colors cursor-pointer h-full">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-good/15 flex items-center justify-center">
                    <Boxes size={18} className="text-good" />
                  </div>
                  <div>
                    <div className="text-sm font-medium">จัดการโมเดล</div>
                    <div className="text-xs text-base-400">ทดสอบแชท ลบ หรือดูขนาดไฟล์</div>
                  </div>
                </div>
                <ArrowRight size={16} className="text-base-500" />
              </div>
            </Card>
          </Link>
        </div>

        <Card>
          <CardHeader
            title="งานเทรนล่าสุด"
            subtitle={loading ? "กำลังโหลด..." : `${jobs.length} งานทั้งหมด`}
            action={
              <Link to="/train">
                <Button variant="secondary" className="text-xs py-1.5">
                  <FlaskConical size={14} /> งานใหม่
                </Button>
              </Link>
            }
          />
          <div className="border-t border-base-800">
            {jobs.length === 0 && !loading && (
              <div className="px-5 py-10 text-center text-sm text-base-500">
                ยังไม่มีงานเทรน — กด "งานใหม่" เพื่อเริ่มต้น
              </div>
            )}
            {jobs.slice(0, 8).map((j) => (
              <Link
                to={`/jobs/${j.id}`}
                key={j.id}
                className="flex items-center justify-between px-5 py-3.5 border-b border-base-800 last:border-0 hover:bg-base-850 transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{j.output_name}</div>
                  <div className="text-xs text-base-500 flex items-center gap-1.5 mt-0.5">
                    <Clock size={11} /> {timeAgo(j.updated_at)} · {j.base_model.split("/").pop()}
                  </div>
                </div>
                <StatusBadge status={j.status} />
              </Link>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "accent" | "good" | "base";
}) {
  const color = accent === "accent" ? "text-accent-400" : accent === "good" ? "text-good" : "text-base-100";
  return (
    <Card className="px-5 py-4">
      <div className="text-xs text-base-400">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${color}`}>{value}</div>
    </Card>
  );
}
