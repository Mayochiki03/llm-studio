import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import Topbar from "../components/Topbar";
import { Card } from "../components/Card";
import Button from "../components/Button";
import { api } from "../api/client";
import type { BaseModel, DatasetOption } from "../types";
import { Check, Cpu, Database, Sliders, Rocket, AlertTriangle, Plus, Trash2, X, Search, Sparkles } from "lucide-react";
import SearchHFDialog from "../components/SearchHFDialog";
import CustomDatasetDialog from "../components/CustomDatasetDialog";

const STEPS = ["โมเดลพื้นฐาน", "ชุดข้อมูล", "พารามิเตอร์", "ตรวจสอบ"];

export default function NewTraining() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [baseModels, setBaseModels] = useState<BaseModel[]>([]);
  const [datasets, setDatasets] = useState<DatasetOption[]>([]);

  const [baseModel, setBaseModel] = useState("");
  const [dataset, setDataset] = useState("");
  const [outputName, setOutputName] = useState("my-model-lora");
  const [r, setR] = useState(8);
  const [loraAlpha, setLoraAlpha] = useState(8);
  const [maxSeqLength, setMaxSeqLength] = useState(512);
  const [epochs, setEpochs] = useState(1);
  const [sampleSize, setSampleSize] = useState(2000);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAddModel, setShowAddModel] = useState(false);
  const [showSearchModels, setShowSearchModels] = useState(false);
  const [showSearchDatasets, setShowSearchDatasets] = useState(false);
  const [showCustomDataset, setShowCustomDataset] = useState(false);

  function loadModels() {
    api.baseModels().then((m) => {
      setBaseModels(m);
      setBaseModel((prev) => (m.some((x) => x.id === prev) ? prev : m.find((x) => x.recommended)?.id ?? m[0]?.id ?? ""));
    });
  }

  function loadDatasets() {
    api.datasets().then((d) => {
      setDatasets(d);
      setDataset((prev) => (d.some((x) => x.id === prev) ? prev : d[0]?.id ?? ""));
    });
  }

  useEffect(() => {
    loadModels();
    loadDatasets();
  }, []);

  async function removeModel(id: string) {
    if (!confirm("เอาโมเดลนี้ออกจากรายการ? (ไม่ได้ลบไฟล์จริงบนเครื่อง แค่เอาออกจากลิสต์ให้เลือก)")) return;
    await api.deleteBaseModel(id);
    loadModels();
  }

  async function pickFromHFModels(id: string) {
    await api.addBaseModel({ id, label: id.split("/").pop() || id, params: "?", vramFitGb: 8, notes: "เพิ่มจากการค้นหา Hugging Face — เช็ค VRAM ที่ต้องใช้เองก่อนเทรน", recommended: false });
    loadModels();
    setBaseModel(id);
  }

  async function pickFromHFDatasets(id: string) {
    await api.addHFDataset({ id, label: id.split("/").pop() || id, sizeHint: "", notes: "เพิ่มจากการค้นหา Hugging Face" });
    loadDatasets();
    setDataset(id);
  }

  async function removeDataset(id: string) {
    if (!confirm("ลบชุดข้อมูลนี้ออกจากรายการ?")) return;
    await api.deleteDataset(id);
    loadDatasets();
  }

  const selectedBase = baseModels.find((m) => m.id === baseModel);
  const canGoNext = step === 0 ? !!baseModel : step === 1 ? !!dataset : step === 2 ? !!outputName.trim() : true;

  async function startTraining() {
    setSubmitting(true);
    setErr(null);
    try {
      const job = await api.createJob({
        base_model: baseModel,
        dataset,
        output_name: outputName.trim(),
        r,
        lora_alpha: loraAlpha,
        max_seq_length: maxSeqLength,
        num_train_epochs: epochs,
        sample_size: sampleSize,
      });
      nav(`/jobs/${job.id}`);
    } catch (e: any) {
      setErr(e.message ?? "เริ่มงานไม่สำเร็จ");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="เทรนโมเดลใหม่" subtitle="ตั้งค่าแล้วกดเริ่ม ระบบจะรันสคริปต์เทรนให้อัตโนมัติ" />

      <div className="p-4 md:p-8 max-w-3xl space-y-6">
        {/* Stepper */}
        <div className="flex items-center">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center flex-1 last:flex-none">
              <div className="flex items-center gap-2">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium shrink-0 ${
                    i < step
                      ? "bg-good text-base-950"
                      : i === step
                      ? "bg-accent-500 text-base-950"
                      : "bg-base-800 text-base-400"
                  }`}
                >
                  {i < step ? <Check size={14} /> : i + 1}
                </div>
                <span className={`text-xs whitespace-nowrap ${i === step ? "text-base-100 font-medium" : "text-base-500"}`}>
                  {label}
                </span>
              </div>
              {i < STEPS.length - 1 && <div className="flex-1 h-px bg-base-800 mx-3" />}
            </div>
          ))}
        </div>

        {step === 0 && (
          <Card className="p-5 space-y-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Cpu size={16} className="text-accent-400" /> เลือกโมเดลพื้นฐาน
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" className="text-xs py-1.5" onClick={() => setShowSearchModels(true)}>
                  <Search size={14} /> ค้นหาจาก Hugging Face
                </Button>
                <Button variant="secondary" className="text-xs py-1.5" onClick={() => setShowAddModel(true)}>
                  <Plus size={14} /> เพิ่มเอง
                </Button>
              </div>
            </div>

            {baseModels.map((m) => (
              <div
                key={m.id}
                className={`flex items-start gap-3 p-3.5 rounded-lg border transition-colors ${
                  baseModel === m.id ? "border-accent-500 bg-accent-500/5" : "border-base-800 hover:border-base-700"
                }`}
              >
                <input
                  type="radio"
                  className="mt-1 accent-accent-500 cursor-pointer"
                  checked={baseModel === m.id}
                  onChange={() => setBaseModel(m.id)}
                />
                <label className="flex-1 min-w-0 cursor-pointer" onClick={() => setBaseModel(m.id)}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{m.label}</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-base-800 text-base-400">{m.params}</span>
                    {m.recommended && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-good/15 text-good">แนะนำสำหรับเครื่องนี้</span>
                    )}
                    {!m.builtin && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent-500/15 text-accent-300">เพิ่มเอง</span>
                    )}
                  </div>
                  <p className="text-xs text-base-400 mt-1">{m.notes}</p>
                  <p className="text-[11px] text-base-500 mt-0.5 font-mono-log">{m.id}</p>
                </label>
                {!m.builtin && (
                  <button
                    onClick={() => removeModel(m.id)}
                    className="text-base-500 hover:text-bad p-1 shrink-0"
                    title="เอาออกจากรายการ"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}

            {selectedBase && selectedBase.vramFitGb > 4 && (
              <div className="flex items-start gap-2 text-xs text-warn bg-warn/10 border border-warn/20 rounded-lg px-3 py-2.5 mt-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  โมเดลนี้ต้องการ VRAM มากกว่า 4GB การเทรนบนเครื่อง local (การ์ด 4GB) อาจไม่สำเร็จ — ระบบจะยังสร้างสคริปต์เทรนให้ แต่แนะนำให้เอาไปรันบน Colab แทน
                  พอได้ไฟล์ GGUF กลับมาแล้ว ไปที่หน้า{" "}
                  <Link to="/import" className="underline text-warn hover:text-warn/80">
                    "นำเข้าโมเดล"
                  </Link>{" "}
                  เพื่อดึงเข้า Ollama โดยไม่ต้องใช้ cmd
                </span>
              </div>
            )}
          </Card>
        )}

        {showAddModel && (
          <AddModelDialog
            onClose={() => setShowAddModel(false)}
            onAdded={() => {
              setShowAddModel(false);
              loadModels();
            }}
          />
        )}

        {step === 1 && (
          <Card className="p-5 space-y-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Database size={16} className="text-accent-400" /> เลือกชุดข้อมูล (dataset)
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" className="text-xs py-1.5" onClick={() => setShowSearchDatasets(true)}>
                  <Search size={14} /> ค้นหาจาก Hugging Face
                </Button>
                <Button variant="secondary" className="text-xs py-1.5" onClick={() => setShowCustomDataset(true)}>
                  <Sparkles size={14} /> เพิ่มของฉัน
                </Button>
              </div>
            </div>
            {datasets.map((d) => (
              <div
                key={d.id}
                className={`flex items-start gap-3 p-3.5 rounded-lg border transition-colors ${
                  dataset === d.id ? "border-accent-500 bg-accent-500/5" : "border-base-800 hover:border-base-700"
                }`}
              >
                <input
                  type="radio"
                  className="mt-1 accent-accent-500 cursor-pointer"
                  checked={dataset === d.id}
                  onChange={() => setDataset(d.id)}
                />
                <label className="flex-1 min-w-0 cursor-pointer" onClick={() => setDataset(d.id)}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{d.label}</span>
                    {d.sizeHint && <span className="text-[11px] px-1.5 py-0.5 rounded bg-base-800 text-base-400">{d.sizeHint}</span>}
                    {d.kind === "custom" && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent-500/15 text-accent-300">ของฉัน</span>
                    )}
                  </div>
                  <p className="text-xs text-base-400 mt-1">{d.notes}</p>
                </label>
                <button
                  onClick={() => removeDataset(d.id)}
                  className="text-base-500 hover:text-bad p-1 shrink-0"
                  title="ลบออกจากรายการ"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <div className="pt-2">
              <label className="text-xs text-base-400 block mb-1.5">จำนวนตัวอย่างที่จะใช้ (sample size)</label>
              <input
                type="number"
                value={sampleSize}
                onChange={(e) => setSampleSize(Number(e.target.value))}
                className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
              />
              <p className="text-[11px] text-base-500 mt-1">เริ่มจากน้อยๆ (1,000-2,000) เพื่อทดลองเร็ว ค่อยเพิ่มทีหลังได้ — ถ้าเป็นชุดข้อมูล "ของฉัน" ที่มีไม่กี่ตัวอย่าง ใส่ตัวเลขสูงไว้ได้เลย ระบบจะใช้เท่าที่มีจริง</p>
            </div>
          </Card>
        )}

        {showSearchModels && (
          <SearchHFDialog kind="model" onClose={() => setShowSearchModels(false)} onPick={pickFromHFModels} />
        )}
        {showSearchDatasets && (
          <SearchHFDialog kind="dataset" onClose={() => setShowSearchDatasets(false)} onPick={pickFromHFDatasets} />
        )}
        {showCustomDataset && (
          <CustomDatasetDialog
            onClose={() => setShowCustomDataset(false)}
            onSaved={() => {
              setShowCustomDataset(false);
              loadDatasets();
            }}
          />
        )}

        {step === 2 && (
          <Card className="p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium mb-1">
              <Sliders size={16} className="text-accent-400" /> พารามิเตอร์การเทรน
            </div>
            <Field label="ชื่อโมเดลผลลัพธ์ (output folder)">
              <input
                value={outputName}
                onChange={(e) => setOutputName(e.target.value)}
                className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="LoRA r" hint="ยิ่งสูงยิ่งจำรายละเอียดได้มาก แต่กิน VRAM เพิ่ม">
                <NumberInput value={r} onChange={setR} />
              </Field>
              <Field label="LoRA alpha" hint="ปกติตั้งเท่ากับ r">
                <NumberInput value={loraAlpha} onChange={setLoraAlpha} />
              </Field>
              <Field label="max_seq_length" hint="4GB VRAM แนะนำ 512">
                <NumberInput value={maxSeqLength} onChange={setMaxSeqLength} step={128} />
              </Field>
              <Field label="epochs">
                <NumberInput value={epochs} onChange={setEpochs} step={1} />
              </Field>
            </div>
          </Card>
        )}

        {step === 3 && (
          <Card className="p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium mb-1">
              <Rocket size={16} className="text-accent-400" /> ตรวจสอบก่อนเริ่ม
            </div>
            <dl className="divide-y divide-base-800 text-sm">
              <Row k="โมเดลพื้นฐาน" v={selectedBase?.label ?? baseModel} />
              <Row k="ชุดข้อมูล" v={datasets.find((d) => d.id === dataset)?.label ?? dataset} />
              <Row k="จำนวนตัวอย่าง" v={sampleSize.toLocaleString()} />
              <Row k="ชื่อผลลัพธ์" v={outputName} />
              <Row k="r / alpha" v={`${r} / ${loraAlpha}`} />
              <Row k="max_seq_length" v={String(maxSeqLength)} />
              <Row k="epochs" v={String(epochs)} />
            </dl>
            {err && (
              <div className="text-xs text-bad bg-bad/10 border border-bad/20 rounded-lg px-3 py-2.5">{err}</div>
            )}
          </Card>
        )}

        <div className="flex justify-between pt-2">
          <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            ย้อนกลับ
          </Button>
          {step < 3 ? (
            <Button onClick={() => setStep((s) => Math.min(3, s + 1))} disabled={!canGoNext}>
              ถัดไป
            </Button>
          ) : (
            <Button onClick={startTraining} disabled={submitting}>
              {submitting ? "กำลังเริ่ม..." : "เริ่มเทรน"} <Rocket size={15} />
            </Button>
          )}
        </div>
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

function NumberInput({ value, onChange, step = 1 }: { value: number; onChange: (n: number) => void; step?: number }) {
  return (
    <input
      type="number"
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
    />
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="text-base-400">{k}</dt>
      <dd className="font-medium text-base-100 truncate max-w-[60%] text-right">{v}</dd>
    </div>
  );
}

function AddModelDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [params, setParams] = useState("");
  const [vramFitGb, setVramFitGb] = useState(4);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!id.trim() || !label.trim()) return;
    setSaving(true);
    try {
      await api.addBaseModel({ id: id.trim(), label: label.trim(), params: params || "?", vramFitGb, notes, recommended: false });
      onAdded();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-base-900 border border-base-800 rounded-xl2 shadow-card w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-14 border-b border-base-800">
          <div className="text-sm font-medium">เพิ่มโมเดลพื้นฐานใหม่</div>
          <button onClick={onClose} className="text-base-400 hover:text-base-100">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <Field label="Hugging Face repo id" hint="คัดลอกมาจากหน้าโมเดลบน huggingface.co เช่น scb10x/llama3.1-typhoon2-8b-instruct">
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="org/model-name"
              className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500 font-mono-log"
            />
          </Field>
          <Field label="ชื่อที่จะแสดง">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="ขนาดพารามิเตอร์" hint="เช่น 3B, 7B">
              <input
                value={params}
                onChange={(e) => setParams(e.target.value)}
                className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
              />
            </Field>
            <Field label="VRAM ที่ต้องใช้ (GB)" hint="ถ้าไม่ชัวร์ประมาณสูงไว้ก่อน">
              <NumberInput value={vramFitGb} onChange={setVramFitGb} />
            </Field>
          </div>
          <Field label="หมายเหตุ">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500 resize-none"
            />
          </Field>
        </div>
        <div className="px-5 pb-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button onClick={save} disabled={saving || !id.trim() || !label.trim()}>
            {saving ? "กำลังบันทึก..." : "เพิ่มโมเดล"}
          </Button>
        </div>
      </div>
    </div>
  );
}
