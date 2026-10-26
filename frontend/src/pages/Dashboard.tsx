import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Topbar from "../components/Topbar";
import { Card, CardHeader } from "../components/Card";
import Button from "../components/Button";
import StatusBadge from "../components/StatusBadge";
import { Meter, Notice, Pill, Spinner, timeAgo } from "../components/ui";
import { api } from "../api/client";
import type { Dashboard as D, Job } from "../types";
import { FlaskConical, ShieldCheck, BookOpen, Cpu, ArrowRight, Clock, MessageSquare, ListOrdered } from "lucide-react";

export default function Dashboard() {
  const [d, setD] = useState<D | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    const load = () => {
      api.dashboard().then((x) => { setD(x); setErr(""); }).catch((e) => setErr(e.message));
      api.listJobs().then(setJobs).catch(() => {});
    };
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  if (!d) return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="ภาพรวม" subtitle="สถานะทั้งระบบในที่เดียว" />
      {err ? <div className="p-8"><Notice tone="bad">โหลดข้อมูลไม่ได้: {err}</Notice></div> : <Spinner />}
    </div>
  );

  const gpu = d.hardware.gpu;
  const running = d.queue?.running ?? null;
  const waiting = d.queue?.waiting?.length ?? 0;
  const pending = d.kb.chunks - d.kb.embedded;

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="ภาพรวม" subtitle="สถานะทั้งระบบในที่เดียว" />
      <div className="p-4 md:p-8 space-y-6 max-w-6xl">
        {!d.ollama_up && <Notice tone="bad">เชื่อมต่อ Ollama ไม่ได้ Playground และการสร้างโมเดลจะใช้ไม่ได้ ตรวจว่า Ollama เปิดอยู่และที่อยู่ในตั้งค่าถูกต้อง</Notice>}
        {pending > 0 && <Notice tone="warn">คลังความรู้มี {pending} ชิ้นที่ยังไม่มีเวกเตอร์ <Link to="/kb" className="underline">ไปสร้างที่หน้าคลังความรู้</Link></Notice>}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Card className="p-5">
            <div className="flex items-center gap-2 text-xs text-base-400"><ShieldCheck size={14} /> โมเดลที่ใช้งานจริง</div>
            <div className="text-sm font-semibold mt-2 break-all">{d.active_model ? d.active_model.name : "ยังไม่มี"}</div>
            <div className="text-[11px] text-base-500 mt-1">
              {d.active_model ? `เปิดใช้ ${timeAgo(d.active_model.activated_at)}` : `รอตรวจ ${d.registry_counts.candidate ?? 0} · อนุมัติแล้ว ${d.registry_counts.approved ?? 0}`}
            </div>
            <Link to="/registry" className="text-xs text-accent-400 hover:underline mt-2 inline-block">ไปหน้าโมเดลที่ใช้งานจริง</Link>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-xs text-base-400"><ListOrdered size={14} /> คิวเทรน</div>
            <div className="text-sm font-semibold mt-2">{running ? `กำลังเทรน ${running.output_name}` : "ว่าง"}</div>
            <div className="text-[11px] text-base-500 mt-1">รอคิว {waiting} งาน</div>
            {running && <Link to={`/jobs/${running.id}`} className="text-xs text-accent-400 hover:underline mt-2 inline-block">ดูความคืบหน้า</Link>}
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-xs text-base-400"><BookOpen size={14} /> คลังความรู้</div>
            <div className="text-sm font-semibold mt-2">{d.kb.enabled} เอกสารที่เปิดใช้</div>
            <div className="text-[11px] text-base-500 mt-1">{d.kb.chunks} ชิ้น · เวกเตอร์ {d.kb.embedded}/{d.kb.chunks}</div>
            <Link to="/kb" className="text-xs text-accent-400 hover:underline mt-2 inline-block">จัดการความรู้</Link>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-xs text-base-400"><Cpu size={14} /> การ์ดจอ</div>
            {gpu ? (
              <>
                <div className="text-sm font-semibold mt-2 truncate">{gpu.name}</div>
                <div className="mt-2"><Meter pct={(gpu.vram_used_gb / gpu.vram_total_gb) * 100} /></div>
                <div className="text-[11px] text-base-500 mt-1">VRAM ว่าง {gpu.vram_free_gb} / {gpu.vram_total_gb} GB · ดิสก์ว่าง {d.hardware.disk.free_gb} GB</div>
              </>
            ) : <div className="text-sm text-warn mt-2">ไม่พบ GPU</div>}
          </Card>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <QuickLink to="/train" icon={<FlaskConical size={18} className="text-accent-400" />} bg="bg-accent-500/15" title="เริ่มเทรนโมเดลใหม่" sub="เลือกแบบง่ายแล้วกดเริ่ม" />
          <QuickLink to="/playground" icon={<MessageSquare size={18} className="text-good" />} bg="bg-good/15" title="ลองถามโมเดล" sub="Playground พร้อมคลังความรู้" />
          <QuickLink to="/kb" icon={<BookOpen size={18} className="text-warn" />} bg="bg-warn/15" title="เพิ่มความรู้" sub="โมเดลตอบได้ทันทีโดยไม่ต้องเทรน" />
        </div>

        <Card>
          <CardHeader title="งานเทรนล่าสุด" subtitle={`${jobs.length} งานทั้งหมด`}
            action={<Link to="/train"><Button variant="secondary" className="text-xs py-1.5"><FlaskConical size={14} /> งานใหม่</Button></Link>} />
          <div className="border-t border-base-800">
            {jobs.length === 0 && <div className="px-5 py-10 text-center text-sm text-base-500">ยังไม่มีงานเทรน กด "งานใหม่" เพื่อเริ่มต้น</div>}
            {jobs.slice(0, 8).map((j) => (
              <Link to={`/jobs/${j.id}`} key={j.id} className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-base-800 last:border-0 hover:bg-base-850 transition-colors">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{j.output_name}</div>
                  <div className="text-xs text-base-500 flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <Clock size={11} /> {timeAgo(j.updated_at)} · {j.base_model.split("/").pop()}
                    {j.status === "scheduled" && j.start_at && <Pill tone="info">เริ่ม {new Date(j.start_at * 1000).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}</Pill>}
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

function QuickLink({ to, icon, bg, title, sub }: { to: string; icon: React.ReactNode; bg: string; title: string; sub: string }) {
  return (
    <Link to={to}>
      <Card className="p-5 hover:border-accent-500/50 transition-colors h-full">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-10 h-10 rounded-lg ${bg} flex items-center justify-center shrink-0`}>{icon}</div>
            <div className="min-w-0">
              <div className="text-sm font-medium">{title}</div>
              <div className="text-xs text-base-400">{sub}</div>
            </div>
          </div>
          <ArrowRight size={16} className="text-base-500 shrink-0" />
        </div>
      </Card>
    </Link>
  );
}
