import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import Topbar from "../components/Topbar";
import { Card } from "../components/Card";
import Button from "../components/Button";
import { api, ApiError } from "../api/client";
import type { BaseModel, DatasetOption, Hardware, PiiScan, PreflightResult } from "../types";
import { Check, Cpu, Database, Sliders, Rocket, AlertTriangle, Plus, Trash2, X, Search, Sparkles, Zap, Scale, Gem, CalendarClock, BookOpen } from "lucide-react";
import { Meter, Modal, NumberInput, Notice, Pill, TextArea, Toggle, inputCls } from "../components/ui";
import { PiiSummary } from "./Datasets";
import { toast, errText } from "../components/toast";
import SearchHFDialog from "../components/SearchHFDialog";
import CustomDatasetDialog from "../components/CustomDatasetDialog";

const STEPS = ["โมเดลพื้นฐาน", "ชุดข้อมูล", "ตั้งค่าการเทรน", "ตรวจและเริ่ม"];

// ชุดค่าสำเร็จรูป: เลือกอันเดียวแทนการปรับเลขเอง (batch/accum ปล่อยให้ระบบเลือกตามการ์ดจอ)
interface Preset {
  id: string;
  label: string;
  icon: typeof Zap;
  desc: string;
  time: string;
  r: number;
  epochs: number;
  seq: number;
  sample: number;
  lr: number;
  val: number;
}
const PRESETS: Preset[] = [
  // ค่าที่ลองแล้วได้ผลกับชุด FAQ ที่สร้างจากตารางข้อเท็จจริง (ราว 800 ตัวอย่าง): 3 รอบพอ เพราะ val_loss นิ่งหลังรอบที่ ~2.7, ความยาว 512 พอสำหรับถามตอบสั้น
  { id: "faq", label: "FAQ ชุดข้อมูลเล็ก (แนะนำ)", icon: BookOpen, desc: "ถามตอบสั้นจากตารางข้อเท็จจริง ราว 300-1,000 ตัวอย่าง", time: "ประมาณ 15-40 นาที (ตามจำนวนข้อมูล)", r: 32, epochs: 2, seq: 512, sample: 2000, lr: 2e-4, val: 0.1 },
  { id: "quick", label: "ทดลองเร็ว", icon: Zap, desc: "เช็คว่าระบบและข้อมูลใช้ได้ ผลยังไม่ละเอียด", time: "ประมาณ 10-30 นาที", r: 8, epochs: 1, seq: 512, sample: 500, lr: 2e-4, val: 0 },
  { id: "balanced", label: "สมดุล", icon: Scale, desc: "คุณภาพกับเวลาพอดีสำหรับใช้งานทั่วไป", time: "ประมาณ 1-3 ชม.", r: 16, epochs: 2, seq: 1024, sample: 2000, lr: 2e-4, val: 0.1 },
  { id: "quality", label: "คุณภาพสูง", icon: Gem, desc: "ข้อมูลยาว เรียนละเอียด ต้องใช้การ์ดจอใหญ่", time: "ประมาณ 3-8 ชม.", r: 32, epochs: 3, seq: 2048, sample: 5000, lr: 1e-4, val: 0.1 },
];

/** ตรวจชื่อโมเดลผลลัพธ์: ไม่ว่าง ใช้ตัวอักษรที่ Ollama รับได้ และไม่ซ้ำกับงานที่ยังใช้อยู่ — คืนข้อความ error หรือ "" ถ้าใช้ได้ */
export function checkOutputName(name: string, used: string[]): string {
  const n = name.trim();
  if (!n) return "ต้องตั้งชื่อโมเดลผลลัพธ์";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n)) return "ใช้ได้เฉพาะ a-z, 0-9, จุด, ขีดกลาง, ขีดล่าง (ไม่เกิน 64 ตัว)";
  if (used.some((u) => u.toLowerCase() === n.toLowerCase())) return `มีงานที่ใช้ชื่อ ${n} อยู่แล้ว ลองเปลี่ยนเป็น ${n}-v2`;
  return "";
}

export default function NewTraining() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [baseModels, setBaseModels] = useState<BaseModel[]>([]);
  const [datasets, setDatasets] = useState<DatasetOption[]>([]);

  const [baseModel, setBaseModel] = useState("");
  const [dataset, setDataset] = useState("");
  const [outputName, setOutputName] = useState("my-model-lora");
  const [usedNames, setUsedNames] = useState<string[]>([]); // ชื่อผลลัพธ์ของงานที่ยังใช้อยู่ (กันซ้ำ)
  useEffect(() => {
    api.listJobs().then((js) => setUsedNames(js.filter((j) => j.status !== "failed" && j.status !== "stopped").map((j) => j.output_name))).catch(() => {});
  }, []);
  const [r, setR] = useState(32);
  const [loraAlpha, setLoraAlpha] = useState(32);
  const [maxSeqLength, setMaxSeqLength] = useState(512);
  const [epochs, setEpochs] = useState(2);
  const [sampleSize, setSampleSize] = useState(2000);
  const [mode, setMode] = useState<"easy" | "adv">("easy");
  const [presetId, setPresetId] = useState("faq");
  const [lr, setLr] = useState(2e-4);
  const [batchSize, setBatchSize] = useState(0);
  const [gradAccum, setGradAccum] = useState(0);
  const [packing, setPacking] = useState(false);
  const [valRatio, setValRatio] = useState(0.1);
  const [templateMode, setTemplateMode] = useState<"auto" | "legacy">("auto");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxMinutes, setMaxMinutes] = useState(0);
  const [startAt, setStartAt] = useState("");
  const [hw, setHw] = useState<Hardware | null>(null);
  const [pf, setPf] = useState<PreflightResult | null>(null);
  const [pfBusy, setPfBusy] = useState(false);
  const [gate, setGate] = useState<null | { kind: "pii"; scan: PiiScan; msg: string } | { kind: "preflight"; pf: PreflightResult; msg: string }>(null);
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
    }).catch(() => {});
  }

  function loadDatasets() {
    api.datasets().then((d) => {
      setDatasets(d);
      setDataset((prev) => (d.some((x) => x.id === prev) ? prev : d[0]?.id ?? ""));
    }).catch(() => {});
  }

  useEffect(() => {
    loadModels();
    loadDatasets();
    api.hardware().then(setHw).catch(() => {});
  }, []);

  const vram = hw?.gpu?.vram_total_gb ?? 0;

  // ใช้ชุดค่าสำเร็จรูป: การ์ดเล็ก (<6GB) ลดความยาวข้อความสูงสุดเหลือ 512 เพื่อไม่ให้หน่วยความจำเต็ม
  function applyPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    setR(p.r);
    setLoraAlpha(p.r);
    setEpochs(p.epochs);
    setMaxSeqLength(vram > 0 && vram < 6 ? Math.min(p.seq, 512) : p.seq);
    setSampleSize(p.sample);
    setLr(p.lr);
    setValRatio(p.val);
    setBatchSize(0);
    setGradAccum(0);
    setPacking(false);
  }

  // ตั้งค่าเริ่มต้นตามการ์ดจอครั้งเดียวหลังรู้ VRAM
  useEffect(() => {
    if (hw) applyPreset("faq");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hw]);

  // เข้าขั้นตอนสุดท้าย (หรือเปลี่ยนค่า) แล้วประเมินทรัพยากรให้ทันที
  useEffect(() => {
    if (step !== 3 || !baseModel) return;
    setPfBusy(true);
    const t = setTimeout(() => {
      api.preflight({ base_model: baseModel, max_seq_length: maxSeqLength, batch_size: batchSize || undefined })
        .then(setPf)
        .catch(() => setPf(null))
        .finally(() => setPfBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [step, baseModel, maxSeqLength, batchSize]);

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
  const nameError = checkOutputName(outputName, usedNames);
  const canGoNext = step === 0 ? !!baseModel : step === 1 ? !!dataset : step === 2 ? !nameError : true;

  async function startTraining(opts: { pii_ack?: boolean; force?: boolean } = {}) {
    setSubmitting(true);
    setErr(null);
    setGate(null);
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
        preset: mode === "easy" ? presetId : "custom",
        batch_size: batchSize,
        grad_accum: gradAccum,
        learning_rate: lr,
        packing,
        val_ratio: valRatio,
        system_prompt: systemPrompt,
        template_mode: templateMode,
        start_at: startAt ? Math.floor(new Date(startAt).getTime() / 1000) : null,
        max_minutes: maxMinutes,
        ...opts,
      });
      toast(job.status === "scheduled" ? "ตั้งเวลาเริ่มเทรนแล้ว" : "เข้าคิวเทรนแล้ว");
      nav(`/jobs/${job.id}`);
    } catch (e: any) {
      // 409 = ด่านตรวจไม่ผ่าน (ข้อมูลระบุตัวตน / ทรัพยากรไม่พอ) ให้ผู้ใช้เห็นรายละเอียดแล้วตัดสินใจเอง
      if (e instanceof ApiError && e.status === 409 && e.detail?.code === "pii") {
        setGate({ kind: "pii", scan: e.detail.scan, msg: e.detail.message });
      } else if (e instanceof ApiError && e.status === 409 && e.detail?.code === "preflight") {
        setGate({ kind: "preflight", pf: e.detail.preflight, msg: e.detail.message });
      } else {
        setErr(errText(e));
      }
    } finally {
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

            {selectedBase && vram > 0 && selectedBase.vramFitGb > vram && (
              <div className="flex items-start gap-2 text-xs text-warn bg-warn/10 border border-warn/20 rounded-lg px-3 py-2.5 mt-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  โมเดลนี้ต้องการ VRAM ประมาณ {selectedBase.vramFitGb} GB แต่เครื่องนี้มี {vram} GB อาจเทรนไม่สำเร็จ ขั้นตอนสุดท้ายระบบจะตรวจให้อีกครั้ง
                  หรือเอาไปเทรนบน Colab/เซิร์ฟเวอร์แล้วนำเข้าที่หน้า{" "}
                  <Link to="/import" className="underline text-warn hover:text-warn/80">"นำเข้าโมเดล"</Link>
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
              <NumberInput value={sampleSize} onChange={setSampleSize} min={1} />
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
          <Card className="p-5 space-y-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sliders size={16} className="text-accent-400" /> ตั้งค่าการเทรน
              </div>
              <div className="flex gap-1 bg-base-850 rounded-lg p-1">
                {([["easy", "แบบง่าย"], ["adv", "ขั้นสูง"]] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setMode(k)} className={`px-3 py-1.5 rounded-md text-xs ${mode === k ? "bg-base-700 text-base-100" : "text-base-400"}`}>{l}</button>
                ))}
              </div>
            </div>

            <Field label="ชื่อโมเดลผลลัพธ์" hint="ตั้งให้จำง่าย เช่น sud-followup-v2 (ใช้เป็นชื่อใน Ollama ด้วย)">
              <input value={outputName} onChange={(e) => setOutputName(e.target.value)} className={inputCls} />
              {nameError && <p className="text-xs text-red-300 mt-1.5">{nameError}</p>}
            </Field>

            {mode === "easy" && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {PRESETS.map((p) => (
                    <button key={p.id} onClick={() => applyPreset(p.id)}
                      className={`text-left p-4 rounded-lg border transition-colors ${presetId === p.id ? "border-accent-500 bg-accent-500/5" : "border-base-800 hover:border-base-700"}`}>
                      <p.icon size={18} className={presetId === p.id ? "text-accent-400" : "text-base-500"} />
                      <div className="text-sm font-medium mt-2">{p.label}</div>
                      <p className="text-xs text-base-400 mt-1">{p.desc}</p>
                      <p className="text-[11px] text-base-500 mt-2">{p.time} (บนการ์ดระดับกลาง)</p>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-base-500">
                  ระบบเลือก batch size และตัวเร่งความเร็วให้เองตามการ์ดจอ{hw?.gpu ? ` (${hw.gpu.name}, ${hw.gpu.vram_total_gb} GB)` : ""}
                  {vram > 0 && vram < 6 && " · การ์ดนี้เล็ก จึงจำกัดความยาวข้อความไว้ที่ 512"}
                </p>
              </>
            )}

            {mode === "adv" && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <Field label="LoRA r" hint="ยิ่งสูงยิ่งจำรายละเอียดได้มาก แต่กิน VRAM เพิ่ม"><NumberInput value={r} onChange={setR} /></Field>
                  <Field label="LoRA alpha" hint="ปกติตั้งเท่ากับ r"><NumberInput value={loraAlpha} onChange={setLoraAlpha} /></Field>
                  <Field label="max_seq_length" hint="การ์ด 4GB แนะนำ 512"><NumberInput value={maxSeqLength} onChange={setMaxSeqLength} step={128} /></Field>
                  <Field label="epochs" hint="จำนวนรอบที่อ่านข้อมูลทั้งชุด"><NumberInput value={epochs} onChange={setEpochs} /></Field>
                  <Field label="learning rate" hint="ปกติ 0.0002 ถ้าค่า loss แกว่งให้ลดลง"><NumberInput value={lr} onChange={setLr} step={0.00005} /></Field>
                  <Field label="สัดส่วนข้อมูลตรวจสอบ" hint="0.1 = กันไว้ 10% เพื่อดูว่าโมเดลท่องจำหรือไม่ ใส่ 0 เพื่อปิด"><NumberInput value={valRatio} onChange={setValRatio} step={0.05} /></Field>
                  <Field label="batch size" hint="0 = ระบบเลือกให้ตามการ์ดจอ"><NumberInput value={batchSize} onChange={setBatchSize} /></Field>
                  <Field label="gradient accumulation" hint="0 = ระบบเลือกให้"><NumberInput value={gradAccum} onChange={setGradAccum} /></Field>
                </div>
                <Toggle checked={packing} onChange={setPacking} label="Packing (ยัดหลายตัวอย่างในหนึ่งชุด)" hint="เร็วขึ้นมากถ้าตัวอย่างสั้น แต่เป็นตัวเลือกทดลอง ทดสอบกับข้อมูลเล็กก่อน" />
                <Toggle checked={templateMode === "legacy"} onChange={(v) => setTemplateMode(v ? "legacy" : "auto")}
                  label="ใช้รูปแบบ prompt แบบเดิม (Gemma)" hint="ปกติปล่อยปิด ระบบใช้รูปแบบของโมเดลนั้นเอง เปิดเฉพาะถ้าผลเทรนแบบอัตโนมัติผิดปกติ หรือต้องการให้เหมือนโมเดลรุ่นก่อน" />
                <Field label="System prompt สำหรับข้อมูลชุดนี้" hint="เว้นว่าง = ใช้ค่าเริ่มต้นจากหน้าตั้งค่า">
                  <TextArea rows={3} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="จำนวนตัวอย่างที่ใช้"><NumberInput value={sampleSize} onChange={setSampleSize} step={100} /></Field>
                  <Field label="เวลาสูงสุด (นาที)" hint="0 = ตามค่าในหน้าตั้งค่า"><NumberInput value={maxMinutes} onChange={setMaxMinutes} step={30} /></Field>
                </div>
              </div>
            )}

            <Field label="ตั้งเวลาเริ่ม (ไม่บังคับ)" hint="เว้นว่าง = เข้าคิวและเริ่มทันทีที่การ์ดจอว่าง เหมาะกับสั่งตอนเย็นให้เริ่มตอนกลางคืน">
              <div className="flex items-center gap-2">
                <CalendarClock size={16} className="text-base-500 shrink-0" />
                <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className={inputCls} />
              </div>
            </Field>
          </Card>
        )}

        {step === 3 && (
          <Card className="p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium mb-1">
              <Rocket size={16} className="text-accent-400" /> ตรวจก่อนเริ่ม
            </div>
            <dl className="divide-y divide-base-800 text-sm">
              <Row k="โมเดลพื้นฐาน" v={selectedBase?.label ?? baseModel} />
              <Row k="ชุดข้อมูล" v={datasets.find((d) => d.id === dataset)?.label ?? dataset} />
              <Row k="จำนวนตัวอย่าง" v={sampleSize.toLocaleString()} />
              <Row k="ชื่อผลลัพธ์" v={outputName} />
              <Row k="แบบ" v={mode === "easy" ? PRESETS.find((p) => p.id === presetId)?.label ?? presetId : "ขั้นสูง"} />
              <Row k="r / alpha" v={`${r} / ${loraAlpha}`} />
              <Row k="max_seq_length" v={String(maxSeqLength)} />
              <Row k="epochs" v={String(epochs)} />
              {startAt && <Row k="เริ่มเมื่อ" v={new Date(startAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })} />}
            </dl>

            <div className="border border-base-800 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">ความพร้อมของเครื่อง</div>
                {pfBusy ? <span className="text-xs text-base-500">กำลังตรวจ...</span> : pf && (
                  <Pill tone={pf.level === "ok" ? "good" : pf.level === "tight" ? "warn" : "bad"}>{pf.summary}</Pill>
                )}
              </div>
              {pf && (
                <>
                  {pf.checks.map((c) => (
                    <div key={c.key} className="space-y-1">
                      <div className="flex items-center gap-2 text-xs">
                        <span className={`w-2 h-2 rounded-full ${c.level === "ok" ? "bg-good" : c.level === "tight" ? "bg-warn" : "bg-bad"}`} />
                        <span className="text-base-200">{c.title}</span>
                      </div>
                      <p className="text-[11px] text-base-400 pl-4">{c.detail}</p>
                    </div>
                  ))}
                  {pf.checks.find((c) => c.key === "vram") && hw?.gpu && (
                    <Meter pct={(pf.vram_need_gb / hw.gpu.vram_total_gb) * 100} />
                  )}
                  <p className="text-[11px] text-base-500">
                    ระบบจะใช้ batch {pf.batch_used}{batchSize ? " (ที่คุณกำหนด)" : " (เลือกให้ตามการ์ดจอ)"}
                    {pf.recommended.note ? ` · ${pf.recommended.note}` : ""}
                  </p>
                </>
              )}
            </div>
            {err && <Notice tone="bad">{err}</Notice>}
          </Card>
        )}

        {gate?.kind === "pii" && (
          <Modal title="พบข้อมูลที่อาจระบุตัวตนได้" onClose={() => setGate(null)}
            footer={<>
              <Button variant="ghost" onClick={() => setGate(null)}>กลับไปแก้ข้อมูล</Button>
              <Button variant="danger" onClick={() => startTraining({ pii_ack: true })}>ยืนยันว่าเป็นข้อมูลสมมติ แล้วเริ่มเทรน</Button>
            </>}>
            <p className="text-sm text-base-300">{gate.msg}</p>
            <PiiSummary scan={gate.scan} />
          </Modal>
        )}
        {gate?.kind === "preflight" && (
          <Modal title="เครื่องอาจไม่พอสำหรับงานนี้" onClose={() => setGate(null)}
            footer={<>
              <Button variant="ghost" onClick={() => setGate(null)}>กลับไปปรับค่า</Button>
              <Button variant="danger" onClick={() => startTraining({ force: true })}>ฝืนเริ่ม (เสี่ยงล้มเหลว)</Button>
            </>}>
            <p className="text-sm text-base-300">{gate.msg}</p>
            {gate.pf.checks.filter((c) => c.level !== "ok").map((c) => (
              <Notice key={c.key} tone={c.level === "no" ? "bad" : "warn"}><b>{c.title}</b><div>{c.detail}</div></Notice>
            ))}
          </Modal>
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
            <Button onClick={() => startTraining()} disabled={submitting || !!nameError}>
              {submitting ? "กำลังส่งเข้าคิว..." : startAt ? "ตั้งเวลาเทรน" : "เริ่มเทรน"} <Rocket size={15} />
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
