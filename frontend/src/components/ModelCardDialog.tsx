// การ์ดประจำโมเดล: ดูค่าเทรน/ชุดข้อมูล/ผลทดสอบ/สภาพคลังความรู้ในที่เดียว + ปุ่ม "เทรนใหม่ด้วยค่าเดิม"
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, RefreshCw, CheckCircle2, AlertTriangle, XCircle, Info, ChevronDown, ChevronRight } from "lucide-react";
import Button from "./Button";
import { Modal, Notice, Spinner, fmtDate, pct } from "./ui";
import { toast, errText } from "./toast";
import { api } from "../api/client";
import type { ModelCard, ModelVersion } from "../types";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-base-800 last:border-0 text-xs">
      <span className="text-base-400 shrink-0">{k}</span>
      <span className="text-base-100 text-right break-all">{v ?? "-"}</span>
    </div>
  );
}
/** หัวข้อที่พับได้ (ค่าเริ่มต้นพับ) เพื่อให้หน้าแรกของการ์ดสั้นและอ่านจบในหนึ่งแวบ */
function Section({ title, children, open: initOpen = false }: { title: string; children: React.ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initOpen);
  return (
    <div className="mb-2">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-xs text-base-300 hover:text-base-100 py-1.5 w-full text-left">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {title}
      </button>
      {open && <div className="rounded-lg bg-base-900/60 px-3 mb-1">{children}</div>}
    </div>
  );
}

const BADGE = {
  good: { icon: CheckCircle2, cls: "text-good bg-good/10 border-good/20" },
  warn: { icon: AlertTriangle, cls: "text-warn bg-warn/10 border-warn/20" },
  bad: { icon: XCircle, cls: "text-bad bg-bad/10 border-bad/20" },
  info: { icon: Info, cls: "text-accent-300 bg-accent-500/10 border-accent-500/20" },
} as const;

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "warn" }) {
  const c = tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-base-100";
  return (
    <div className="rounded-lg bg-base-900/60 px-3 py-2.5">
      <div className="text-[10px] text-base-500">{label}</div>
      <div className={`text-lg font-semibold ${c}`}>{value}</div>
    </div>
  );
}

/** กราฟเส้น loss เล็กๆ (train = ฟ้า, val = เหลือง) วาดด้วย SVG ไม่พึ่งไลบรารี */
export function LossSpark({ pts }: { pts: { step: number | null; train: number | null; val: number | null }[] }) {
  const tr = pts.map((p, i) => [i, p.train] as const).filter((x): x is readonly [number, number] => typeof x[1] === "number");
  const va = pts.map((p, i) => [i, p.val] as const).filter((x): x is readonly [number, number] => typeof x[1] === "number");
  const all = [...tr, ...va].map((x) => x[1]);
  if (all.length < 2) return null;
  const max = Math.max(...all), min = Math.min(...all), W = 300, H = 70, n = Math.max(1, pts.length - 1);
  const path = (xs: readonly (readonly [number, number])[]) =>
    xs.map(([i, v], k) => `${k ? "L" : "M"}${(i / n) * W},${H - ((v - min) / Math.max(1e-6, max - min)) * (H - 6) - 3}`).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16" preserveAspectRatio="none" role="img" aria-label="กราฟ loss">
        <path d={path(tr)} fill="none" stroke="#60a5fa" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
        {va.length > 1 && <path d={path(va)} fill="none" stroke="#fbbf24" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="flex gap-3 text-[10px] text-base-500"><span className="text-[#60a5fa]">— train</span><span className="text-[#fbbf24]">— val</span><span>ยิ่งต่ำยิ่งดี เส้นสองเส้นควรอยู่ใกล้กัน</span></div>
    </div>
  );
}

const f4 = (x: number | null | undefined) => (typeof x === "number" ? x.toFixed(3) : "-");

/** ข้อความสรุปการ์ดแบบข้อความล้วน ไว้คัดลอกแปะลงเอกสาร/บันทึกของทีม */
export function cardToText(c: ModelCard): string {
  const j = c.job;
  const lines = [
    `โมเดล: ${c.version.name}  (สถานะ ${c.version.status})`,
    `ฐาน: ${c.version.base_model}`,
    `ชุดข้อมูล: ${c.dataset.id} v${c.dataset.version || "-"}`,
  ];
  if (j) {
    lines.push(`ค่าเทรน: r=${j.r} alpha=${j.lora_alpha} seq=${j.max_seq_length} epochs=${j.num_train_epochs} lr=${j.learning_rate} val=${j.val_ratio}`);
    lines.push(`loss: train ${f4(j.final_train_loss)} / val ${f4(j.final_val_loss)} (ต่ำสุด ${f4(j.best_val_loss)})`);
  }
  lines.push(`ผลทดสอบล่าสุด: ผ่าน ${pct(c.eval.pass_rate)} red flag ${pct(c.eval.red_flag_recall)} (${c.eval.use_kb ? "มีคลังความรู้" : "ไม่มีคลังความรู้"})`);
  lines.push(`บันทึก: ${c.version.notes || "-"}`);
  return lines.join("\n");
}

export default function ModelCardDialog({ v, onClose }: { v: ModelVersion; onClose: () => void }) {
  const nav = useNavigate();
  const [c, setC] = useState<ModelCard | null>(null);
  useEffect(() => {
    api.registryCard(v.id).then(setC).catch((e) => { toast(errText(e), "bad"); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.id]);

  function retrain() {
    if (!c?.retrain) return;
    onClose();
    nav("/train", { state: { retrain: c.retrain } }); // หน้าเทรนอ่านค่าไปกรอกให้ ผู้ใช้ตรวจ/แก้ก่อนกดเริ่ม
  }
  async function copy() {
    if (!c) return;
    try { await navigator.clipboard.writeText(cardToText(c)); toast("คัดลอกแล้ว"); } catch { toast("คัดลอกไม่ได้", "bad"); }
  }

  const j = c?.job;
  const rf = c?.eval.red_flag_recall;
  return (
    <Modal title={`การ์ดโมเดล ${v.name}`} onClose={onClose} wide
      footer={<>
        <Button variant="ghost" onClick={copy} disabled={!c}><Copy size={14} /> คัดลอกสรุป</Button>
        <Button onClick={retrain} disabled={!c?.retrain}><RefreshCw size={14} /> เทรนใหม่ด้วยค่าเดิม</Button>
      </>}>
      {!c ? <Spinner /> : (
        <>
          <p className="text-sm text-base-100 mb-3">{c.headline ?? c.version.name}</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <Kpi label="ผ่านเกณฑ์" value={c.eval.at ? pct(c.eval.pass_rate) : "-"} />
            <Kpi label="จับ red flag" value={c.eval.at ? pct(rf) : "-"} tone={rf == null ? undefined : rf >= 1 ? "good" : "bad"} />
            <Kpi label="val loss" value={f4(j?.final_val_loss)} />
            <Kpi label="รอบที่เทรน" value={j ? String(j.num_train_epochs) : "-"} />
          </div>
          {(c.badges ?? []).length > 0 && (
            <div className="space-y-1.5 mb-3">
              {(c.badges ?? []).map((b, i) => {
                const B = BADGE[b.tone]; const Icon = B.icon;
                return <div key={i} className={`flex items-start gap-2 text-xs rounded-lg border px-3 py-2 ${B.cls}`}><Icon size={14} className="shrink-0 mt-0.5" /><span>{b.text}</span></div>;
              })}
            </div>
          )}
          {(c.loss_curve ?? []).length > 1 && <div className="mb-3 rounded-lg bg-base-900/60 px-3 py-2.5"><LossSpark pts={c.loss_curve!} /></div>}

          <Section title="ที่มาและบันทึก">
            <Row k="โมเดลฐาน" v={c.version.base_model || "-"} />
            <Row k="ชุดข้อมูล" v={`${c.dataset.id || "-"}${c.dataset.version ? ` v${c.dataset.version}` : ""}`} />
            <Row k="สร้างเมื่อ" v={fmtDate(c.version.created_at)} />
            <Row k="บันทึกของเรา" v={c.version.notes || "ยังไม่มี"} />
          </Section>
          {j ? (
            <Section title="ค่าที่ใช้เทรน">
              <Row k="r / alpha" v={`${j.r} / ${j.lora_alpha}`} />
              <Row k="ความยาวข้อความสูงสุด" v={j.max_seq_length} />
              <Row k="learning rate" v={j.learning_rate} />
              <Row k="สัดส่วนข้อมูลตรวจ (val)" v={j.val_ratio} />
              <Row k="batch / accum" v={`${j.batch_size || "อัตโนมัติ"} / ${j.grad_accum || "อัตโนมัติ"}`} />
              <Row k="รูปแบบ template" v={j.template_mode} />
              <Row k="loss ตอนจบ (train / val)" v={`${f4(j.final_train_loss)} / ${f4(j.final_val_loss)}`} />
              <Row k="val_loss ต่ำสุด" v={f4(j.best_val_loss)} />
            </Section>
          ) : (
            <Notice tone="warn">โมเดลนี้ไม่มีประวัติเทรนในระบบนี้ (เพิ่มเอง/นำเข้า) จึงไม่มีค่าเทรนและเทรนซ้ำด้วยค่าเดิมไม่ได้</Notice>
          )}
          <Section title="ผลทดสอบล่าสุด">
            <Row k="วิธีทดสอบ" v={c.eval.at ? (c.eval.use_kb ? "มีคลังความรู้และขอบเขต" : "ไม่มีคลังความรู้ (วัดแค่ความจำโมเดล)") : "ยังไม่เคยทดสอบ"} />
            <Row k="จำนวนข้อ / เมื่อ" v={c.eval.at ? `${c.eval.n_prompts ?? c.eval.count ?? "-"} ข้อ / ${fmtDate(c.eval.at)}` : "-"} />
          </Section>
          <Section title="สภาพระบบตอนนี้ (ไว้เทียบเวลาทดสอบซ้ำ)">
            <Row k="คลังความรู้" v={`${c.environment_now.kb_enabled}/${c.environment_now.kb_docs} เอกสารที่เปิดใช้`} />
            <Row k="แก้คลังล่าสุด" v={c.environment_now.kb_last_update ? fmtDate(c.environment_now.kb_last_update) : "-"} />
            <Row k="ค่าความเกี่ยวข้องขั้นต่ำ / จำนวนชิ้นที่ดึง" v={`${c.environment_now.kb_min_score} / ${c.environment_now.kb_top_k}`} />
            <Row k="รหัสขอบเขต+system prompt" v={c.environment_now.scope_hash} />
          </Section>
          {c.retrain && <p className="text-[11px] text-base-500 mt-2">เทรนใหม่จะกรอกค่าเดิมให้ในหน้าเทรน ตั้งชื่อใหม่ให้อัตโนมัติ ({String(c.retrain.output_name)}) ไม่เขียนทับรุ่นเดิม และให้คุณตรวจก่อนกดเริ่ม</p>}
        </>
      )}
    </Modal>
  );
}
