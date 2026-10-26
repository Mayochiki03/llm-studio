// คำศัพท์ที่เจอในโปรแกรม อธิบายเป็นภาษาคนทั่วไป: ค้นหาได้ และเรียงตามลำดับที่ใช้งานจริง
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import Topbar from "../components/Topbar";
import { Card } from "../components/Card";
import { Empty } from "../components/ui";

export interface Term { word: string; alias?: string; meaning: string; group: string }

export const TERMS: Term[] = [
  { group: "ข้อมูล", word: "คลังความรู้", alias: "Knowledge Base, KB, RAG", meaning: "เอกสารของเราที่เก็บไว้ให้โมเดล \"เปิดอ่านก่อนตอบ\" เหมือนให้พนักงานเปิดคู่มือก่อนตอบลูกค้า แก้เอกสารแล้วคำตอบเปลี่ยนทันที ไม่ต้องเทรนใหม่ เหมาะกับข้อมูลที่ต้องแม่น เช่น เบอร์โทร เวลา ราคา" },
  { group: "ข้อมูล", word: "RAG กับการเทรน ต่างกันอย่างไร", alias: "RAG, fine-tune", meaning: "RAG = เปิดเอกสารอ่านก่อนตอบ (ข้อเท็จจริงแม่น แก้ได้ทันที) ส่วนการเทรน = ฝึกนิสัยการตอบ น้ำเสียง และขอบเขต ไม่ใช่การท่องข้อเท็จจริง ระบบนี้ใช้ทั้งคู่ เทรนให้ตอบสุภาพตามขอบเขต แล้วให้ RAG ป้อนข้อเท็จจริง" },
  { group: "ข้อมูล", word: "ชิ้นความรู้", alias: "chunk", meaning: "เอกสารยาวถูกหั่นเป็นท่อนสั้นๆ เพื่อให้ค้นเจอเฉพาะส่วนที่เกี่ยวกับคำถาม" },
  { group: "ข้อมูล", word: "เวกเตอร์", alias: "embedding", meaning: "ตัวเลขที่ใช้แทน \"ความหมาย\" ของข้อความ ทำให้ค้นเจอแม้ใช้คำไม่ตรงกัน เช่น ถามว่า \"เปิดกี่โมง\" เจอเอกสาร \"เวลาทำการ\"" },
  { group: "ข้อมูล", word: "ชุดข้อมูลสอน", alias: "dataset, ชุดข้อมูลเทรน", meaning: "ตัวอย่างคำถาม-คำตอบที่ใช้ \"สอน\" โมเดลให้ตอบแบบที่เราต้องการ ยิ่งหลากหลายยิ่งดี ซ้ำๆ เยอะโมเดลจะท่องจำ" },
  { group: "ข้อมูล", word: "ข้อมูลระบุตัวตน", alias: "PII", meaning: "เลขบัตรประชาชน HN เบอร์โทร อีเมล ชื่อจริง ฯลฯ ระบบตรวจและเตือนก่อนเอาไปใช้ ห้ามใส่ข้อมูลผู้ป่วยจริงในชุดข้อมูลสอนหรือส่งออกนอกเครื่อง" },
  { group: "การเทรน", word: "เทรน", alias: "fine-tune", meaning: "สอนโมเดลที่มีอยู่แล้วเพิ่มเติมด้วยตัวอย่างของเรา ปรับ \"น้ำเสียง รูปแบบ และขอบเขต\" ได้ดี แต่ไม่เหมาะกับการจำตัวเลข/ข้อเท็จจริงให้แม่นทุกตัว" },
  { group: "การเทรน", word: "โมเดลฐาน", alias: "base model", meaning: "โมเดลต้นแบบที่ยังไม่ได้สอนเรื่องของเรา เราเอามาเทรนต่อ เช่น Typhoon2 3B" },
  { group: "การเทรน", word: "LoRA / QLoRA", meaning: "วิธีเทรนแบบประหยัด สอนเฉพาะ \"ส่วนเสริมเล็กๆ\" แทนทั้งโมเดล ทำให้เทรนบนการ์ดจอ 4 GB ได้" },
  { group: "การเทรน", word: "r / alpha", meaning: "ขนาดของส่วนเสริมที่สอน ค่ามาก = จำได้มากแต่ใช้ทรัพยากรมาก ค่าเริ่มต้นของระบบเหมาะกับงานทั่วไปแล้ว" },
  { group: "การเทรน", word: "รอบ", alias: "epoch", meaning: "จำนวนครั้งที่โมเดลอ่านข้อมูลทั้งชุด รอบมากไป = ท่องจำ รอบน้อยไป = เรียนไม่พอ" },
  { group: "การเทรน", word: "loss", meaning: "ตัวเลขความผิดพลาดของโมเดลตอนฝึก ยิ่งต่ำยิ่งเรียนได้ แต่ต่ำไม่ได้แปลว่าตอบถูกเสมอ" },
  { group: "การเทรน", word: "val_loss", alias: "validation loss", meaning: "ความผิดพลาดบนข้อมูลที่กันไว้ไม่ให้เรียน ใช้ดูว่าโมเดลเรียนรู้จริงหรือแค่ท่องจำ ถ้า loss ลงแต่ val_loss ขึ้น แปลว่าท่องจำเกิน" },
  { group: "การเทรน", word: "ท่องจำเกิน", alias: "overfitting", meaning: "โมเดลจำตัวอย่างที่เห็นได้ดีมากแต่ตอบคำถามสำนวนใหม่ไม่ดี" },
  { group: "การเทรน", word: "VRAM", meaning: "หน่วยความจำของการ์ดจอ ใช้ตอนเทรนและตอนรันโมเดล ถ้าเต็มจะเทรนไม่ผ่าน ปิดโมเดลอื่นที่ค้างอยู่ก่อน" },
  { group: "การเทรน", word: "batch", alias: "batch size, accum", meaning: "จำนวนตัวอย่างที่เรียนพร้อมกันต่อก้าว ระบบเลือกให้เองตามการ์ดจอ" },
  { group: "ทดสอบ", word: "โจทย์ทดสอบ", alias: "eval prompt", meaning: "คำถามที่เรารู้คำตอบที่ต้องมี ใช้วัดโมเดลทุกครั้งที่เทรนใหม่ จะได้เทียบรุ่นเก่า-ใหม่ด้วยเกณฑ์เดียวกัน" },
  { group: "ทดสอบ", word: "เคสอันตราย", alias: "red flag", meaning: "คำถามที่ตอบผิดแล้วเสี่ยง เช่น อยากทำร้ายตัวเอง อาการรุนแรง ระบบวัดแยกว่าโมเดลจับได้กี่ %" },
  { group: "ทดสอบ", word: "ผ่านเกณฑ์", meaning: "คำตอบมีคำสำคัญครบที่กำหนดไว้ และไม่มีคำต้องห้าม (ตรวจอัตโนมัติด้วยคำ ไม่ได้อ่านความหมาย จึงควรอ่านคำตอบจริงด้วย)" },
  { group: "ใช้งานจริง", word: "โมเดลที่ใช้งานจริง", alias: "ทะเบียนโมเดล", meaning: "โมเดลตัวเดียวที่ระบบอื่น (เว็บ, LINE) จะเรียกใช้ โมเดลใหม่ต้องผ่านขั้น รอตรวจ → อนุมัติ → ใช้งานจริง ย้อนกลับตัวเก่าได้ทุกเมื่อ" },
  { group: "ใช้งานจริง", word: "รอตรวจ / อนุมัติ / เก็บถาวร", meaning: "สถานะของโมเดล: รอตรวจ = เพิ่งสร้าง ยังไม่ผ่านการดู, อนุมัติ = คนตรวจผลแล้วให้ใช้ได้, เก็บถาวร = ซ่อนไว้ไม่ใช้แล้วแต่ยังเก็บประวัติ" },
  { group: "ใช้งานจริง", word: "Ollama", meaning: "โปรแกรมที่รันโมเดลบนเครื่องเรา (ตัวที่ \"ตอบ\" จริงๆ) โมเดลที่เทรนเสร็จจะถูกส่งเข้า Ollama" },
  { group: "ใช้งานจริง", word: "GGUF", meaning: "ไฟล์โมเดลแบบบีบอัดที่ Ollama อ่านได้ ระบบแปลงให้เองหลังเทรนเสร็จ" },
  { group: "ใช้งานจริง", word: "ขอบเขตการตอบ", meaning: "กติกาว่าระบบตอบอะไรได้: เคสอันตรายตอบข้อความตายตัว หัวข้อต้องห้ามไม่ตอบ ไม่มีเอกสารรองรับก็บอกว่าไม่มีข้อมูล ตั้งได้จากหน้าเว็บ" },
  { group: "ใช้งานจริง", word: "system prompt", meaning: "คำสั่งตั้งต้นที่บอกโมเดลว่าเป็นใคร ตอบสุภาพแค่ไหน ต้องทำอะไร ไม่ควรทำอะไร" },
  { group: "ใช้งานจริง", word: "temperature", meaning: "ความ \"สร้างสรรค์\" ของคำตอบ ต่ำ = ตอบนิ่งและตรง (แนะนำงานโรงพยาบาล) สูง = หลากหลายแต่เสี่ยงแต่งเอง" },
  { group: "ใช้งานจริง", word: "คีย์ API", alias: "API key, token", meaning: "รหัสลับที่ระบบอื่นใช้ยืนยันตัวตนเวลาเรียกโมเดลของเรา แยกคีย์ตามระบบ ปิด/ลบรายอันได้ คีย์จริงแสดงครั้งเดียวตอนสร้าง" },
];

export default function Glossary() {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return TERMS.filter((t) => !k || `${t.word} ${t.alias ?? ""} ${t.meaning}`.toLowerCase().includes(k));
  }, [q]);
  const groups = Array.from(new Set(list.map((t) => t.group)));

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="คำศัพท์" subtitle="ความหมายของคำที่เจอในโปรแกรม" />
      <div className="p-4 md:p-8 max-w-3xl space-y-5">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาคำ เช่น epoch, RAG, อนุมัติ"
            className="w-full bg-base-850 border border-base-800 rounded-lg pl-9 pr-3 py-2 text-sm text-base-100 outline-none focus:border-accent-500" />
        </div>
        {list.length === 0 && <Empty title="ไม่พบคำนี้" hint="ลองคำอื่น หรือพิมพ์ภาษาอังกฤษ" />}
        {groups.map((g) => (
          <div key={g} className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-base-500">{g}</div>
            <Card className="divide-y divide-base-800">
              {list.filter((t) => t.group === g).map((t) => (
                <div key={t.word} className="px-5 py-3.5">
                  <div className="text-sm font-medium text-base-100">{t.word}{t.alias && <span className="text-base-500 font-normal"> · {t.alias}</span>}</div>
                  <p className="text-sm text-base-300 mt-1">{t.meaning}</p>
                </div>
              ))}
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
