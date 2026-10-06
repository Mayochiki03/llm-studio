import { useEffect, useState } from "react";
import Topbar from "../components/Topbar";
import { Card, CardHeader } from "../components/Card";
import { api } from "../api/client";
import { CheckCircle2, XCircle, ExternalLink } from "lucide-react";

export default function Settings() {
  const [root, setRoot] = useState<string>("...");
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    api.health().then((h) => setRoot(h.project_root)).catch(() => setRoot("เชื่อมต่อ backend ไม่ได้"));
    api.aiStatus().then((s) => setAiConfigured(s.configured)).catch(() => setAiConfigured(null));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="ตั้งค่า" subtitle="ข้อมูลพื้นฐานของเครื่องมือนี้" />
      <div className="p-4 md:p-8 max-w-2xl space-y-6">
        <Card>
          <CardHeader title="ตำแหน่งโปรเจกต์" subtitle="ที่เก็บโมเดล, dataset cache และสคริปต์ที่สร้างขึ้นระหว่างเทรน" />
          <div className="px-5 pb-5">
            <code className="block bg-base-950 border border-base-800 rounded-lg px-3 py-2.5 text-xs text-base-300 break-all">
              {root}
            </code>
          </div>
        </Card>
        <Card>
          <CardHeader title="AI ช่วยเตรียม dataset (Gemini)" subtitle="ใช้ตอนกด 'ให้ AI ช่วยแปลง' ในหน้าเทรนโมเดลใหม่" />
          <div className="px-5 pb-5 space-y-3 text-sm">
            {aiConfigured === null && <div className="text-base-500">กำลังเช็ค...</div>}
            {aiConfigured === true && (
              <div className="flex items-center gap-2 text-good">
                <CheckCircle2 size={16} /> ตั้งค่า Gemini API key ไว้แล้ว พร้อมใช้งาน
              </div>
            )}
            {aiConfigured === false && (
              <>
                <div className="flex items-center gap-2 text-warn">
                  <XCircle size={16} /> ยังไม่ได้ตั้งค่า Gemini API key
                </div>
                <ol className="text-xs text-base-400 space-y-1.5 list-decimal list-inside">
                  <li>
                    ขอ API key ฟรีที่{" "}
                    <a
                      href="https://aistudio.google.com/apikey"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent-400 hover:underline inline-flex items-center gap-1"
                    >
                      aistudio.google.com/apikey <ExternalLink size={10} />
                    </a>
                  </li>
                  <li>
                    สร้างไฟล์ชื่อ <code className="text-base-300">.env</code> ในโฟลเดอร์ <code className="text-base-300">backend</code>
                  </li>
                  <li>
                    ใส่บรรทัดเดียว: <code className="text-base-300">GEMINI_API_KEY=ค่าคีย์ของคุณ</code>
                  </li>
                  <li>ปิดแล้วเปิด backend ใหม่ (restart <code className="text-base-300">uvicorn</code>)</li>
                </ol>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="เกี่ยวกับ" />
          <div className="px-5 pb-5 text-sm text-base-400 space-y-2">
            <p>LLM Studio เป็นเครื่องมือควบคุมการเทรน/ทดสอบโมเดลภาษาไทยในเครื่อง local ครอบ Unsloth + Ollama ไว้ในหน้าเว็บเดียว</p>
            <p>ดูรายละเอียดวิธีติดตั้งและใช้งานได้ที่ README.md ในโปรเจกต์</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
