// ให้ AI (Gemini) ช่วยอ่านผลเทรนเป็นภาษาไทย หลังเทรนเสร็จเท่านั้น (ไม่ทำระหว่างเทรน จึงไม่รบกวนเครื่อง)
// ส่งเฉพาะ "ตัวเลข" (ค่าตั้งต้น + loss) ไม่ส่งข้อมูลเทรน/ชื่อ/log และต้องดูข้อมูลที่จะส่งแล้วกดยืนยันทุกครั้ง
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Card, CardHeader } from "./Card";
import Button from "./Button";
import { Modal, Notice } from "./ui";
import { toast, errText } from "./toast";
import { api } from "../api/client";

// ตัดเครื่องหมาย markdown (**ตัวหนา**, # หัวข้อ, ` ) ที่โมเดลมักแถมมา ให้เหลือข้อความธรรมดา
export function plainText(t: string): string {
  return t.replace(/\*\*/g, "").replace(/^#{1,6}\s*/gm, "").replace(/`/g, "");
}

export default function AiSummaryCard({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [prev, setPrev] = useState<{ digest: unknown; configured: boolean } | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function openPreview() {
    setErr(null);
    try { setPrev(await api.jobAiDigest(jobId)); setOpen(true); } catch (e) { toast(errText(e), "bad"); }
  }
  async function send() {
    setBusy(true); setErr(null);
    try {
      const r = await api.jobAiSummary(jobId);
      if (r.ok && r.text) { setText(r.text); setOpen(false); } else setErr(r.error ?? "ไม่สำเร็จ");
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader title="ให้ AI ช่วยอ่านผลเทรน" subtitle="สรุปเป็นภาษาไทยว่า loss ดีไหม เสี่ยงอะไร รอบหน้าควรปรับอะไร (ส่งเฉพาะตัวเลข ไม่ส่งข้อมูลจริง)" />
      <div className="px-5 pb-5 space-y-3">
        {text ? (
          <div className="text-sm text-base-200 whitespace-pre-wrap leading-relaxed">{plainText(text)}</div>
        ) : (
          <div className="text-xs text-base-400">ยังไม่ได้สรุป — กดปุ่มเพื่อดูข้อมูลที่จะส่งก่อน ยังไม่มีอะไรถูกส่งออกจนกว่าจะกดยืนยัน</div>
        )}
        <Button variant="secondary" onClick={openPreview}><Sparkles size={14} /> {text ? "สรุปใหม่" : "ดูข้อมูลที่จะส่ง และให้ AI สรุป"}</Button>
        {text && <div className="text-[11px] text-base-500">AI อ่านได้แค่ loss ไม่รู้ว่าโมเดลตอบถูกไหม ผลจริงดูที่หน้า "ทดสอบและเปรียบเทียบ"</div>}
      </div>

      {open && prev && (
        <Modal title="ข้อมูลที่จะส่งให้ Gemini" onClose={() => setOpen(false)}
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>ยกเลิก</Button><Button onClick={send} disabled={busy || !prev.configured}>{busy ? "กำลังสรุป..." : "ยืนยันและส่ง"}</Button></>}>
          <Notice tone="good"><div>ส่งเฉพาะตัวเลขด้านล่างนี้ ไม่ส่งชื่อชุดข้อมูล ชื่อโมเดล ตัวอย่างเทรน log หรือข้อมูลผู้ป่วย</div></Notice>
          {!prev.configured && <Notice tone="warn"><div>ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน <code>backend/.env</code> (restart backend หลังใส่) ปุ่มส่งจึงยังกดไม่ได้</div></Notice>}
          {err && <Notice tone="bad"><div>{err}</div></Notice>}
          <pre className="text-[11px] bg-base-850 border border-base-800 rounded-lg p-3 overflow-auto max-h-64 font-mono-log">{JSON.stringify(prev.digest, null, 1)}</pre>
        </Modal>
      )}
    </Card>
  );
}
