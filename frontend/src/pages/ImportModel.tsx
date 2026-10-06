import { useState } from "react";
import Topbar from "../components/Topbar";
import { Card, CardHeader } from "../components/Card";
import Button from "../components/Button";
import { api } from "../api/client";
import { Cloud, FolderInput, CheckCircle2, ExternalLink } from "lucide-react";

export default function ImportModel() {
  const [name, setName] = useState("");
  const [ggufPath, setGgufPath] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(
    "คุณเป็นผู้ช่วยที่พูดภาษาไทยเป็นธรรมชาติ อบอุ่น และเข้าใจบริบทของผู้ใช้"
  );
  const [stopToken, setStopToken] = useState("<|eot_id|>");
  const [numCtx, setNumCtx] = useState(4096);
  const [temperature, setTemperature] = useState(0.7);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; stderr?: string } | null>(null);

  async function doImport() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.createOllamaModel({
        model_name: name.trim(),
        gguf_path: ggufPath.trim(),
        system_prompt: systemPrompt,
        stop_token: stopToken,
        num_ctx: numCtx,
        temperature,
      });
      setResult(r);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="นำเข้าโมเดล" subtitle="เอาโมเดลที่เทรนมาจากที่อื่น (เช่น Colab) เข้า Ollama โดยไม่ต้องเปิด cmd" />

      <div className="p-4 md:p-8 max-w-2xl space-y-6">
        <Card>
          <CardHeader title="เครื่องนี้เทรนไม่ไหว ต้องทำยังไง?" />
          <div className="px-5 pb-5 space-y-3 text-sm text-base-300">
            <Step n={1} icon={Cloud} title="เทรนบน Google Colab แทน">
              ใช้ GPU ฟรีของ Colab (T4, VRAM 16GB) รันสคริปต์เทรนแบบเดียวกับที่หน้า
              "เทรนโมเดลใหม่" สร้างให้ เพียงแต่ไปรันใน Colab notebook แทนเครื่องนี้
              — เทรนเสร็จ Colab จะแปลงเป็นไฟล์ <code className="text-accent-300">.gguf</code> ให้อัตโนมัติ
            </Step>
            <Step n={2} icon={FolderInput} title="ดาวน์โหลดไฟล์ .gguf มาที่เครื่องนี้">
              ดาวน์โหลดจาก Colab (แนะนำผ่าน Google Drive ถ้าไฟล์ใหญ่กว่า 2GB จะเสถียรกว่า)
              แล้ววางไฟล์ไว้ในโฟลเดอร์ไหนก็ได้บนเครื่อง จดที่อยู่ไฟล์ไว้
            </Step>
            <Step n={3} icon={CheckCircle2} title="กรอกฟอร์มด้านล่างแล้วกด 'นำเข้า'">
              ไม่ต้องพิมพ์คำสั่ง <code className="text-accent-300">ollama create</code> เอง
              ระบบจะสร้าง Modelfile และดึงเข้า Ollama ให้อัตโนมัติ พอเสร็จจะไปโผล่ที่หน้า
              "โมเดลของฉัน" ทันที
            </Step>
          </div>
        </Card>

        <Card>
          <CardHeader title="ฟอร์มนำเข้า" subtitle="กรอกให้ครบแล้วกดนำเข้า" />
          <div className="px-5 pb-5 space-y-3">
            <Field label="ชื่อโมเดล (จะไปโผล่ใน Ollama ด้วยชื่อนี้)">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="เช่น qwen-general"
                className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
              />
            </Field>
            <Field label="ที่อยู่ไฟล์ .gguf บนเครื่อง" hint="path แบบเต็ม เช่น ./qwen-general-gguf/qwen2.5-7b-instruct.Q4_K_M.gguf">
              <input
                value={ggufPath}
                onChange={(e) => setGgufPath(e.target.value)}
                placeholder="./qwen-general-gguf/qwen2.5-7b-instruct.Q4_K_M.gguf"
                className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500 font-mono-log"
              />
            </Field>
            <Field label="System prompt">
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={2}
                className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500 resize-none"
              />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="stop token" hint="Llama/Typhoon: <|eot_id|> · Qwen: <|im_end|>">
                <input
                  value={stopToken}
                  onChange={(e) => setStopToken(e.target.value)}
                  className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500 font-mono-log"
                />
              </Field>
              <Field label="num_ctx">
                <input
                  type="number"
                  value={numCtx}
                  onChange={(e) => setNumCtx(Number(e.target.value))}
                  className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
                />
              </Field>
              <Field label="temperature">
                <input
                  type="number"
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
                />
              </Field>
            </div>

            {result && (
              <div
                className={`text-xs rounded-lg px-3 py-2.5 border ${
                  result.ok ? "bg-good/10 border-good/20 text-good" : "bg-bad/10 border-bad/20 text-bad"
                }`}
              >
                {result.ok
                  ? "นำเข้าสำเร็จ! ไปทดสอบแชทได้ที่หน้า \"โมเดลของฉัน\""
                  : `นำเข้าไม่สำเร็จ: ${result.stderr || "เช็ค path ไฟล์อีกครั้ง"}`}
              </div>
            )}

            <div className="flex justify-end pt-1">
              <Button onClick={doImport} disabled={busy || !name.trim() || !ggufPath.trim()}>
                {busy ? "กำลังนำเข้า..." : "นำเข้าโมเดล"}
              </Button>
            </div>
          </div>
        </Card>

        <a
          href="https://colab.research.google.com/"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-xs text-base-400 hover:text-accent-400 justify-center"
        >
          เปิด Google Colab <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}

function Step({
  n,
  icon: Icon,
  title,
  children,
}: {
  n: number;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-base-800 flex items-center justify-center shrink-0 text-xs font-medium text-base-300">
        {n}
      </div>
      <div>
        <div className="flex items-center gap-1.5 font-medium text-base-100">
          <Icon size={14} className="text-accent-400" /> {title}
        </div>
        <p className="text-xs text-base-400 mt-1">{children}</p>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-base-400 block mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-base-500 mt-1">{hint}</p>}
    </div>
  );
}
