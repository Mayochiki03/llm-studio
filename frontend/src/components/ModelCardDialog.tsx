// การ์ดประจำโมเดล: ดูค่าเทรน/ชุดข้อมูล/ผลทดสอบ/สภาพคลังความรู้ในที่เดียว + ปุ่ม "เทรนใหม่ด้วยค่าเดิม"
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, RefreshCw } from "lucide-react";
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
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-[11px] uppercase tracking-wide text-base-500 mb-1">{title}</div>
      <div className="rounded-lg bg-base-900/60 px-3">{children}</div>
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
  return (
    <Modal title={`การ์ดโมเดล ${v.name}`} onClose={onClose} wide
      footer={<>
        <Button variant="ghost" onClick={copy} disabled={!c}><Copy size={14} /> คัดลอกสรุป</Button>
        <Button onClick={retrain} disabled={!c?.retrain}><RefreshCw size={14} /> เทรนใหม่ด้วยค่าเดิม</Button>
      </>}>
      {!c ? <Spinner /> : (
        <>
          <Section title="ที่มา">
            <Row k="โมเดลฐาน" v={c.version.base_model || "-"} />
            <Row k="ชุดข้อมูล" v={`${c.dataset.id || "-"}${c.dataset.version ? ` v${c.dataset.version}` : ""}`} />
            <Row k="สร้างเมื่อ" v={fmtDate(c.version.created_at)} />
            <Row k="บันทึกของเรา" v={c.version.notes || "ยังไม่มี (ควรบันทึกว่ารุ่นนี้แก้อะไรจากรุ่นก่อน)"} />
          </Section>
          {j ? (
            <Section title="ค่าที่ใช้เทรน">
              <Row k="r / alpha" v={`${j.r} / ${j.lora_alpha}`} />
              <Row k="ความยาวข้อความสูงสุด" v={j.max_seq_length} />
              <Row k="รอบ (epochs)" v={j.num_train_epochs} />
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
            <Row k="ผ่านเกณฑ์" v={pct(c.eval.pass_rate)} />
            <Row k="จับ red flag ได้" v={pct(c.eval.red_flag_recall)} />
            <Row k="วิธีทดสอบ" v={c.eval.at ? (c.eval.use_kb ? "มีคลังความรู้และขอบเขต" : "ไม่มีคลังความรู้ (วัดแค่ความจำโมเดล)") : "ยังไม่เคยทดสอบ"} />
            <Row k="จำนวนข้อ / เมื่อ" v={c.eval.at ? `${c.eval.n_prompts ?? c.eval.count ?? "-"} ข้อ / ${fmtDate(c.eval.at)}` : "-"} />
          </Section>
          <Section title="สภาพระบบตอนนี้ (ไว้เทียบเวลาทดสอบซ้ำ)">
            <Row k="คลังความรู้" v={`${c.environment_now.kb_enabled}/${c.environment_now.kb_docs} เอกสารที่เปิดใช้`} />
            <Row k="แก้คลังล่าสุด" v={c.environment_now.kb_last_update ? fmtDate(c.environment_now.kb_last_update) : "-"} />
            <Row k="ค่าความเกี่ยวข้องขั้นต่ำ / จำนวนชิ้นที่ดึง" v={`${c.environment_now.kb_min_score} / ${c.environment_now.kb_top_k}`} />
            <Row k="รหัสขอบเขต+system prompt" v={c.environment_now.scope_hash} />
          </Section>
          {c.retrain && <p className="text-[11px] text-base-500">เทรนใหม่จะกรอกค่าข้างบนให้ในหน้าเทรน ตั้งชื่อใหม่ให้อัตโนมัติ ({String(c.retrain.output_name)}) ไม่เขียนทับรุ่นเดิม และให้คุณตรวจก่อนกดเริ่ม</p>}
        </>
      )}
    </Modal>
  );
}
