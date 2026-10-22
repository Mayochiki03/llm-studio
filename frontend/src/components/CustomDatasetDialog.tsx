import { useEffect, useState } from "react";
import { X, Sparkles, Plus, Trash2, Save, AlertCircle } from "lucide-react";
import Button from "./Button";
import { api } from "../api/client";
import type { QAPair } from "../types";
import { NumberInput } from "../components/ui";

export default function CustomDatasetDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [rawText, setRawText] = useState("");
  const [numPairs, setNumPairs] = useState(8);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [pairs, setPairs] = useState<QAPair[]>([]);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.aiStatus().then((s) => setAiConfigured(s.configured));
  }, []);

  async function generate() {
    if (!rawText.trim()) return;
    setGenerating(true);
    setGenError(null);
    try {
      const r = await api.generateDataset(rawText.trim(), numPairs);
      if (r.ok && r.pairs) {
        setPairs((prev) => [...prev, ...r.pairs!]);
      } else {
        setGenError(r.error ?? "สร้างไม่สำเร็จ");
      }
    } finally {
      setGenerating(false);
    }
  }

  function addRow() {
    setPairs((prev) => [...prev, { instruction: "", output: "" }]);
  }

  function updateRow(i: number, field: keyof QAPair, value: string) {
    setPairs((prev) => prev.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)));
  }

  function removeRow(i: number) {
    setPairs((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function save() {
    if (!name.trim() || pairs.length === 0) return;
    setSaving(true);
    try {
      await api.createCustomDataset(name.trim(), notes, pairs);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-base-900 border border-base-800 rounded-xl2 shadow-card w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-14 border-b border-base-800 shrink-0">
          <div className="text-sm font-medium">เพิ่มชุดข้อมูลของฉัน</div>
          <button onClick={onClose} className="text-base-400 hover:text-base-100">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* AI-assisted section */}
          <div className="border border-base-800 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles size={15} className="text-accent-400" /> ให้ AI ช่วยแปลงข้อความดิบเป็นคำถาม-คำตอบ
            </div>

            {aiConfigured === false && (
              <div className="flex items-start gap-2 text-xs text-warn bg-warn/10 border border-warn/20 rounded-lg px-3 py-2.5">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                ยังไม่ได้ตั้งค่า Gemini API key — ใส่ในไฟล์ <code className="text-warn">backend/.env</code> เป็น{" "}
                <code className="text-warn">GEMINI_API_KEY=...</code> แล้ว restart backend (ดูวิธีขอคีย์ฟรีได้ในหน้า
                "ตั้งค่า") ตอนนี้ยังเพิ่มแถวเองด้านล่างได้ตามปกติ
              </div>
            )}

            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={5}
              placeholder="วางข้อความดิบที่นี่ เช่น รายละเอียดโรงพยาบาล, FAQ, คู่มือบริการ ฯลฯ"
              disabled={aiConfigured === false}
              className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500 resize-none disabled:opacity-50"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-base-400">
                จำนวนคู่ที่ต้องการ
                <NumberInput value={numPairs} onChange={setNumPairs} min={1}
                  className="w-16 bg-base-850 border border-base-700 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-accent-500" />
              </div>
              <Button
                variant="secondary"
                onClick={generate}
                disabled={generating || aiConfigured === false || !rawText.trim()}
              >
                <Sparkles size={14} /> {generating ? "กำลังสร้าง..." : "ให้ AI ช่วยแปลง"}
              </Button>
            </div>
            {genError && <div className="text-xs text-bad">{genError}</div>}
          </div>

          {/* Editable pairs table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">คู่คำถาม-คำตอบ ({pairs.length})</span>
              <Button variant="ghost" className="text-xs py-1" onClick={addRow}>
                <Plus size={13} /> เพิ่มแถวเอง
              </Button>
            </div>
            {pairs.length === 0 && (
              <div className="text-xs text-base-500 text-center py-6 border border-dashed border-base-800 rounded-lg">
                ยังไม่มีข้อมูล — ใช้ AI ช่วยสร้างด้านบน หรือกด "เพิ่มแถวเอง"
              </div>
            )}
            {pairs.map((p, i) => (
              <div key={i} className="border border-base-800 rounded-lg p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <textarea
                    value={p.instruction}
                    onChange={(e) => updateRow(i, "instruction", e.target.value)}
                    placeholder="คำถาม / instruction"
                    rows={2}
                    className="flex-1 bg-base-850 border border-base-700 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-accent-500 resize-none"
                  />
                  <button onClick={() => removeRow(i)} className="text-base-500 hover:text-bad mt-1.5 shrink-0">
                    <Trash2 size={14} />
                  </button>
                </div>
                <textarea
                  value={p.output}
                  onChange={(e) => updateRow(i, "output", e.target.value)}
                  placeholder="คำตอบ / output"
                  rows={2}
                  className="w-full bg-base-850 border border-base-700 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-accent-500 resize-none"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="p-4 border-t border-base-800 shrink-0 space-y-3">
          <div className="flex gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ชื่อชุดข้อมูล (เช่น ข้อมูลโรงพยาบาล)"
              className="flex-1 bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
            />
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="หมายเหตุ (ไม่บังคับ)"
              className="flex-1 bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={save} disabled={saving || !name.trim() || pairs.length === 0}>
              <Save size={15} /> {saving ? "กำลังบันทึก..." : `บันทึกเป็นชุดข้อมูล (${pairs.length} คู่)`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
