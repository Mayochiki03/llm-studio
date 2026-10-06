import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import Topbar from "../components/Topbar";
import { Card, CardHeader } from "../components/Card";
import Button from "../components/Button";
import StatusBadge from "../components/StatusBadge";
import LogViewer from "../components/LogViewer";
import { api } from "../api/client";
import type { Job } from "../types";
import { ChevronLeft, Download, Package, Trash2, MessageSquare, PlayCircle } from "lucide-react";

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [lossPoints, setLossPoints] = useState<{ step: number; loss: number }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [ggufFile, setGgufFile] = useState<string | null>(null);
  const [ggufDir, setGgufDir] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .getJob(id)
      .then((j) => {
        setJob(j);
        setLogLines(j.log_tail ?? []);
        setLossPoints(j.loss_points ?? []);
      })
      .catch(() => setNotFound(true));

    const ws = api.jobSocket(id);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      const payload = JSON.parse(ev.data);
      if (payload.type === "log") setLogLines((prev) => [...prev.slice(-1999), payload.line]);
      if (payload.type === "loss") setLossPoints((prev) => [...prev, payload.point]);
      if (payload.type === "status")
        setJob((prev) => (prev ? { ...prev, status: payload.status, error: payload.error ?? prev.error } : prev));
    };
    return () => ws.close();
  }, [id]);

  if (notFound) {
    return (
      <div className="flex-1 overflow-y-auto">
        <Topbar title="รายละเอียดงาน" />
        <div className="p-4 md:p-8 max-w-2xl space-y-4">
          <div className="text-sm text-bad bg-bad/10 border border-bad/20 rounded-lg px-4 py-3">
            ไม่พบงานนี้ในระบบ — อาจถูกลบไปแล้ว หรือสร้างไว้ตั้งแต่ก่อนอัปเดตเวอร์ชันที่เริ่มบันทึกงานลงดิสก์
            (เวอร์ชันนี้ขึ้นไปจะไม่หายอีกแม้ปิด/รีสตาร์ท backend)
          </div>
          <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-accent-400 hover:underline">
            <ChevronLeft size={14} /> กลับหน้าภาพรวม
          </Link>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex-1 overflow-y-auto">
        <Topbar title="รายละเอียดงาน" />
        <div className="p-8 text-sm text-base-400">กำลังโหลด...</div>
      </div>
    );
  }

  const isDone = job.status === "done";
  const isRunning = ["training", "exporting", "creating_ollama", "queued"].includes(job.status);

  async function doExport() {
    if (!id) return;
    setBusy("export");
    setActionMsg(null);
    try {
      const r = await api.exportGguf(id);
      setGgufFile(r.gguf_file);
      setGgufDir(r.gguf_dir);
      setActionMsg(
        r.ok
          ? r.gguf_file
            ? `แปลง GGUF สำเร็จ → ${r.gguf_dir}`
            : `แปลง GGUF สำเร็จ แต่หาไฟล์ .gguf ที่สร้างไม่เจอใน ${r.gguf_dir} — เช็คโฟลเดอร์ด้วยตัวเองก่อนกด "สร้างเข้า Ollama"`
          : "แปลง GGUF ไม่สำเร็จ ดู log ด้านบน"
      );
    } finally {
      setBusy(null);
    }
  }

  async function doCreateOllama() {
    if (!job) return;
    setBusy("ollama");
    setActionMsg(null);
    let file = ggufFile;
    let dir = ggufDir;
    if (!file || !dir) {
      const found = await api.listGgufFiles(id!);
      file = found.files[0] ?? null;
      dir = found.gguf_dir;
      if (file) setGgufFile(file);
      if (dir) setGgufDir(dir);
    }
    if (!file || !dir) {
      setActionMsg('ยังไม่เจอไฟล์ .gguf — กด "แปลงเป็น GGUF" ก่อน');
      setBusy(null);
      return;
    }
    try {
      const r = await api.createOllamaModel({
        model_name: job.output_name,
        gguf_path: `./${dir}/${file}`,
      });
      setActionMsg(
        r.ok
          ? `สร้างโมเดล "${job.output_name}" เข้า Ollama แล้ว — ไปทดสอบแชทได้ที่หน้าโมเดล`
          : `สร้างไม่สำเร็จ: ${r.stderr || "ดู log"}`
      );
    } finally {
      setBusy(null);
    }
  }

  async function doResume() {
    if (!id) return;
    setBusy("resume");
    setActionMsg(null);
    try {
      const j = await api.resumeJob(id);
      setJob(j);
      setActionMsg("กำลังรันต่อจาก checkpoint ล่าสุด (ถ้ามี) — ดู log ด้านล่าง");
    } catch (e) {
      setActionMsg(`รันต่อไม่สำเร็จ: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function doCleanup() {
    if (!id) return;
    if (!confirm("ลบไฟล์โมเดล/checkpoint ของงานนี้ทั้งหมด? (ลบแล้วกู้คืนไม่ได้)")) return;
    setBusy("cleanup");
    try {
      const r = await api.cleanupJob(id);
      setActionMsg(`ลบแล้ว: ${r.removed.join(", ") || "ไม่มีไฟล์ให้ลบ"}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title={job.output_name} subtitle={job.base_model} />

      <div className="p-4 md:p-8 max-w-4xl space-y-6">
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-base-400 hover:text-base-200">
          <ChevronLeft size={14} /> กลับหน้าภาพรวม
        </Link>

        <div className="flex items-center justify-between">
          <StatusBadge status={job.status} />
          <div className="flex gap-2">
            {isRunning && id && (
              <Button variant="danger" className="text-xs py-1.5" onClick={() => api.stopJob(id)}>
                หยุดงาน
              </Button>
            )}
            {(job.status === "stopped" || job.status === "failed") && id && (
              <Button
                variant="secondary"
                className="text-xs py-1.5"
                disabled={busy !== null}
                onClick={doResume}
              >
                <PlayCircle size={14} /> {busy === "resume" ? "กำลังรันต่อ..." : "กลับมารันต่อ"}
              </Button>
            )}
          </div>
        </div>
        {(job.status === "stopped" || job.status === "failed") && (
          <p className="text-[11px] text-base-500 -mt-3">
            ระบบเซฟ checkpoint ทุก 20 step ระหว่างเทรน กด "กลับมารันต่อ" จะรันต่อจาก checkpoint ล่าสุดถ้ามี
            ไม่ได้เริ่มเทรนใหม่ตั้งแต่ต้น
          </p>
        )}

        {job.error && (
          <div className="text-sm text-bad bg-bad/10 border border-bad/20 rounded-lg px-4 py-3">{job.error}</div>
        )}

        <Card>
          <CardHeader title="Loss ระหว่างเทรน" subtitle={`${lossPoints.length} จุดข้อมูล`} />
          <div className="px-5 pb-5 h-56">
            {lossPoints.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={lossPoints}>
                  <CartesianGrid stroke="#232d3d" strokeDasharray="3 3" />
                  <XAxis dataKey="step" stroke="#7489a3" fontSize={11} />
                  <YAxis stroke="#7489a3" fontSize={11} domain={["auto", "auto"]} />
                  <Tooltip
                    contentStyle={{ background: "#131a24", border: "1px solid #232d3d", borderRadius: 8, fontSize: 12 }}
                  />
                  <Line type="monotone" dataKey="loss" stroke="#4f8cff" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-base-500">
                ยังไม่มีข้อมูล loss — จะเริ่มขึ้นกราฟหลัง step แรกของการเทรน
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Log แบบเรียลไทม์" />
          <div className="px-5 pb-5">
            <LogViewer lines={logLines} />
          </div>
        </Card>

        <Card>
          <CardHeader title="ขั้นตอนถัดไป" subtitle="แปลงเป็น GGUF แล้วดึงเข้า Ollama เพื่อทดสอบ" />
          <div className="px-5 pb-5 space-y-3">
            {actionMsg && (
              <div className="text-xs text-base-200 bg-base-850 border border-base-700 rounded-lg px-3 py-2.5">
                {actionMsg}
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              <Button variant="secondary" disabled={!isDone || busy !== null} onClick={doExport}>
                <Package size={15} /> {busy === "export" ? "กำลังแปลง..." : "แปลงเป็น GGUF"}
              </Button>
              <Button variant="secondary" disabled={!isDone || busy !== null} onClick={doCreateOllama}>
                <Download size={15} /> {busy === "ollama" ? "กำลังสร้าง..." : "สร้างเข้า Ollama"}
              </Button>
              <Link to="/models">
                <Button variant="secondary">
                  <MessageSquare size={15} /> ไปทดสอบแชท
                </Button>
              </Link>
              <Button variant="danger" disabled={busy !== null} onClick={doCleanup} className="ml-auto">
                <Trash2 size={15} /> ลบไฟล์งานนี้
              </Button>
            </div>
            {!isDone && (
              <p className="text-[11px] text-base-500">ต้องรอให้สถานะเป็น "เสร็จแล้ว" ก่อนถึงจะแปลง GGUF ได้</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
