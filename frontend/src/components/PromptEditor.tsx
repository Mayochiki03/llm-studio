// แก้เงื่อนไขตรวจอัตโนมัติของโจทย์: คำที่ต้องมีในคำตอบ, คำที่ห้ามมี, ตรึงไว้ใช้ตอนอนุมัติ, เคส red flag
import { useState } from "react";
import Button from "./Button";
import { Field, Modal, TextArea, TextInput, Toggle } from "./ui";
import { toast, errText } from "./toast";
import { api } from "../api/client";
import type { EvalPrompt } from "../types";

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export default function PromptEditor({ prompt, onClose, onSaved }: { prompt: EvalPrompt; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(prompt.text);
  const [category, setCategory] = useState(prompt.category);
  const [expect, setExpect] = useState((prompt.expect ?? []).join("\n"));
  const [mustNot, setMustNot] = useState((prompt.must_not ?? []).join("\n"));
  const [pinned, setPinned] = useState(!!prompt.pinned);
  const [redFlag, setRedFlag] = useState(!!prompt.red_flag);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.updateEvalPrompt(prompt.id, { text, category, expect: lines(expect), must_not: lines(mustNot), pinned, red_flag: redFlag });
      toast("บันทึกโจทย์แล้ว");
      onSaved();
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="แก้โจทย์ทดสอบ" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>ยกเลิก</Button><Button onClick={save} disabled={busy || !text.trim()}>บันทึก</Button></>}>
      <Field label="คำถาม"><TextArea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Field label="หมวด"><TextInput value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
      <Field label="คำตอบต้องมีคำเหล่านี้ (บรรทัดละคำ)" hint="เช่น 1323 ถ้าคำตอบต้องมีเบอร์สายด่วน; ถ้ามีหลายบรรทัด ต้องมีครบทุกคำถึงจะผ่าน">
        <TextArea rows={3} value={expect} onChange={(e) => setExpect(e.target.value)} />
      </Field>
      <Field label="คำตอบห้ามมีคำเหล่านี้ (บรรทัดละคำ)" hint="เช่น ชื่อยาที่ไม่ควรแนะนำ">
        <TextArea rows={3} value={mustNot} onChange={(e) => setMustNot(e.target.value)} />
      </Field>
      <Toggle checked={pinned} onChange={setPinned} label="ตรึงโจทย์นี้" hint="โจทย์ที่ตรึงจะถูกใช้ตอนรันทดสอบเพื่ออนุมัติโมเดลในทะเบียน" />
      <Toggle checked={redFlag} onChange={setRedFlag} label="เป็นเคสสำคัญ (red flag)" hint="เคสที่โมเดลพลาดไม่ได้ เช่น ผู้ป่วยมีความเสี่ยงฉุกเฉิน ระบบจะแสดงอัตราการจับเคสนี้แยกให้" />
    </Modal>
  );
}
