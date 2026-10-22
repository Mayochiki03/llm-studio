import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, ExternalLink, Save, Lock, LockOpen } from "lucide-react";
import Topbar from "../components/Topbar";
import { Card, CardHeader } from "../components/Card";
import Button from "../components/Button";
import { Field, NumberInput, Notice, Spinner, TextArea, TextInput, Toggle } from "../components/ui";
import { toast, errText } from "../components/toast";
import { api, setToken } from "../api/client";
import ApiKeysCard from "../components/ApiKeysCard";
import type { Settings as S } from "../types";

export default function Settings() {
  const [root, setRoot] = useState<string>("...");
  const [version, setVersion] = useState("");
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [s, setS] = useState<S | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");

  const load = () => api.settings().then((x) => { setS(x); setDirty(false); }).catch((e) => toast(errText(e), "bad"));

  useEffect(() => {
    api.health().then((h) => { setRoot(h.project_root); setVersion(h.version ?? ""); }).catch(() => setRoot("เชื่อมต่อ backend ไม่ได้"));
    api.aiStatus().then((x) => setAiConfigured(x.configured)).catch(() => setAiConfigured(null));
    load();
  }, []);

  const set = <K extends keyof S>(k: K, v: S[K]) => {
    setS((p) => (p ? { ...p, [k]: v } : p));
    setDirty(true);
  };

  async function save() {
    if (!s) return;
    setSaving(true);
    try {
      const { auth: _a, cors_origins: _c, ...patch } = s; // ส่วนความปลอดภัยแก้แยกด้านล่าง
      setS(await api.saveSettings(patch));
      setDirty(false);
      toast("บันทึกตั้งค่าแล้ว");
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setSaving(false);
    }
  }

  async function enableAuth() {
    if (pw.length < 8) return toast("รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร", "bad");
    if (pw !== pw2) return toast("รหัสผ่านสองช่องไม่ตรงกัน", "bad");
    try {
      const r = await api.setPassword(pw);
      setToken(r.token);
      setPw(""); setPw2("");
      toast("ตั้งรหัสผ่านแล้ว ต่อไปต้องล็อกอินก่อนใช้งาน");
      load();
    } catch (e) { toast(errText(e), "bad"); }
  }

  async function disableAuth() {
    if (!confirm("ปิดการล็อกอิน? ใครเข้าถึงเว็บนี้ได้จะใช้งานได้ทั้งหมด")) return;
    try { await api.disableAuth(); setToken(""); toast("ปิดการล็อกอินแล้ว"); load(); } catch (e) { toast(errText(e), "bad"); }
  }

  if (!s) return (<div className="flex-1"><Topbar title="ตั้งค่า" /><Spinner /></div>);
  const authOn = !!s.auth?.enabled;

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="ตั้งค่า" subtitle="การเชื่อมต่อ การเทรน คลังความรู้ และความปลอดภัย" />
      <div className="p-4 md:p-8 max-w-2xl space-y-6">
        <Card>
          <CardHeader title="Ollama และโมเดลค้นหา" subtitle="ที่อยู่ของ Ollama และโมเดลที่ใช้สร้างเวกเตอร์ให้คลังความรู้" />
          <div className="px-5 pb-5 space-y-4">
            <Field label="ที่อยู่ Ollama" hint="เครื่องเดียวกันใช้ http://localhost:11434 ถ้าแยกเครื่องใส่ IP ของเซิร์ฟเวอร์">
              <TextInput value={s.ollama_url} onChange={(e) => set("ollama_url", e.target.value)} />
            </Field>
            <Field label="โมเดลสร้างเวกเตอร์ (embedding)" hint="แนะนำ bge-m3 รองรับภาษาไทยดี ต้องดึงก่อนด้วย: ollama pull bge-m3 ถ้าเปลี่ยนตัว ต้องกดสร้างเวกเตอร์ใหม่ในหน้าคลังความรู้">
              <TextInput value={s.embed_model} onChange={(e) => set("embed_model", e.target.value)} />
            </Field>
            <Field label="เก็บโมเดลไว้ใน VRAM นานเท่าไหร่หลังใช้งาน" hint="เช่น 30m, 2h, -1 (ไม่ปลด) ยิ่งนานยิ่งตอบเร็วแต่กิน VRAM">
              <TextInput value={s.keep_alive} onChange={(e) => set("keep_alive", e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="การเทรน" subtitle="ผลต่อทุกงานเทรนใหม่" />
          <div className="px-5 pb-5 space-y-4">
            <Toggle checked={s.unload_before_train} onChange={(v) => set("unload_before_train", v)} label="ปลดโมเดลใน Ollama ก่อนเริ่มเทรน" hint="คืน VRAM ให้การเทรน (แนะนำให้เปิดไว้ โดยเฉพาะการ์ด 4GB)" />
            <Toggle checked={s.reload_after_train} onChange={(v) => set("reload_after_train", v)} label="โหลดโมเดลกลับหลังเทรนเสร็จ" hint="ให้โมเดลที่ถูกปลดพร้อมตอบเหมือนเดิม" />
            <Field label="โหมดดาวน์โหลดโมเดล" hint="ปลอดภัย = ช้าแต่เสถียร (ค่าเริ่มต้น) · เร็ว = ใช้ตัวเร่งของ Hugging Face ถ้าติดตั้งแล้ว เหมาะกับเน็ตเซิร์ฟเวอร์ที่เร็ว">
              <select value={s.network_mode} onChange={(e) => set("network_mode", e.target.value as S["network_mode"])} className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm">
                <option value="safe">ปลอดภัย</option>
                <option value="fast">เร็ว</option>
              </select>
            </Field>
            <Field label="เวลาสูงสุดต่องานเทรน (นาที)" hint="0 = ไม่จำกัด ถ้าเกินระบบหยุดงานให้เองกันค้างทั้งคืน">
              <NumberInput value={s.max_train_minutes} onChange={(n) => set("max_train_minutes", Math.max(0, Math.round(n)))} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="คำสั่งตั้งต้นของโมเดล" subtitle="ใช้กับการเทรนและ Playground ถ้าไม่ได้ระบุเอง" />
          <div className="px-5 pb-5">
            <TextArea rows={4} value={s.default_system_prompt} onChange={(e) => set("default_system_prompt", e.target.value)} />
          </div>
        </Card>

        <Card>
          <CardHeader title="คลังความรู้" subtitle="วิธีตัดและค้นเอกสาร" />
          <div className="px-5 pb-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="ขนาดชิ้น (ตัวอักษร)" hint="เล็ก = แม่นแต่ขาดบริบท"><NumberInput value={s.kb_chunk_size} onChange={(n) => set("kb_chunk_size", Math.round(n))} step={50} /></Field>
            <Field label="ส่วนซ้อนทับ (ตัวอักษร)" hint="กันประโยคขาดกลางคัน"><NumberInput value={s.kb_chunk_overlap} onChange={(n) => set("kb_chunk_overlap", Math.round(n))} step={10} /></Field>
            <Field label="จำนวนชิ้นที่ส่งให้โมเดล"><NumberInput value={s.kb_top_k} onChange={(n) => set("kb_top_k", Math.round(n))} /></Field>
            <Field label="คะแนนขั้นต่ำ (0-1)" hint="สูง = เข้มงวด ไม่ส่งชิ้นที่เกี่ยวน้อย"><NumberInput value={s.kb_min_score} onChange={(n) => set("kb_min_score", n)} step={0.05} /></Field>
          </div>
          <div className="px-5 pb-5 text-[11px] text-base-500">เปลี่ยนขนาดชิ้นมีผลกับเอกสารที่เพิ่ม/แก้หลังจากนี้ เอกสารเดิมจะถูกตัดใหม่เมื่อแก้ไขและบันทึก</div>
        </Card>

        <Card>
          <CardHeader title="สำรองข้อมูลและความเป็นส่วนตัว" subtitle="สำรองอัตโนมัติวันละครั้ง และกันข้อมูลระบุตัวตนเข้าคลังความรู้" />
          <div className="px-5 pb-5 space-y-4">
            <Toggle checked={s.auto_backup} onChange={(v) => set("auto_backup", v)} label="สำรองข้อมูลอัตโนมัติวันละครั้ง" hint="เก็บไฟล์ studio-backup-auto-*.zip ไว้ในเครื่อง ดู/กู้คืนได้ที่หน้า เครื่องและพื้นที่" />
            <Field label="เก็บไฟล์สำรองอัตโนมัติกี่ชุด" hint="เกินจำนวนนี้จะลบชุดเก่าสุดให้เอง (ไม่แตะไฟล์ที่สำรองด้วยมือ)">
              <NumberInput value={s.backup_keep} onChange={(n) => set("backup_keep", Math.max(1, Math.round(n)))} />
            </Field>
            <Toggle checked={s.kb_pii_block} onChange={(v) => set("kb_pii_block", v)} label="เตือนเมื่อพบเลขบัตรประชาชน/เบอร์โทร/HN ในเอกสารที่เพิ่มเข้าคลังความรู้" hint="ต้องกดยืนยันก่อนจึงเพิ่มได้ (แนะนำให้เปิดไว้)" />
          </div>
        </Card>

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving || !dirty}><Save size={14} /> {saving ? "กำลังบันทึก..." : "บันทึกตั้งค่า"}</Button>
          {dirty && <span className="text-xs text-warn">มีการแก้ที่ยังไม่บันทึก</span>}
        </div>

        <Card>
          <CardHeader title="ความปลอดภัย" subtitle="รหัสผ่านเดียวสำหรับเข้าหน้าเว็บนี้ แนะนำให้เปิดเมื่อวางบนเซิร์ฟเวอร์ที่คนอื่นในเครือข่ายเข้าถึงได้" />
          <div className="px-5 pb-5 space-y-3">
            {authOn ? (
              <>
                <div className="flex items-center gap-2 text-sm text-good"><Lock size={15} /> เปิดการล็อกอินอยู่</div>
                <Button variant="danger" onClick={disableAuth}><LockOpen size={14} /> ปิดการล็อกอิน</Button>
              </>
            ) : <div className="flex items-center gap-2 text-sm text-warn"><LockOpen size={15} /> ยังไม่ได้ตั้งรหัสผ่าน ใครเข้าถึงเว็บนี้ก็ใช้งานได้</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={authOn ? "รหัสผ่านใหม่" : "ตั้งรหัสผ่าน"}><TextInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
              <Field label="ยืนยันรหัสผ่าน"><TextInput type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
            </div>
            <Button variant="secondary" onClick={enableAuth} disabled={!pw}><Lock size={14} /> {authOn ? "เปลี่ยนรหัสผ่าน" : "เปิดการล็อกอิน"}</Button>
            <Notice tone="info">ลืมรหัสผ่าน: ลบส่วน <code>auth</code> ในไฟล์ <code>studio_data/settings.json</code> แล้วรีสตาร์ท backend</Notice>
          </div>
        </Card>

        <ApiKeysCard />

        <Card>
          <CardHeader title="ตำแหน่งโปรเจกต์" subtitle="ที่เก็บโมเดล, dataset cache และสคริปต์ที่สร้างขึ้นระหว่างเทรน" />
          <div className="px-5 pb-5">
            <code className="block bg-base-950 border border-base-800 rounded-lg px-3 py-2.5 text-xs text-base-300 break-all">{root}</code>
          </div>
        </Card>

        <Card>
          <CardHeader title="AI ช่วยเตรียม dataset (Gemini)" subtitle="ใช้ตอนกด 'ให้ AI ช่วยแปลง' ตอนสร้างชุดข้อมูล (ส่งข้อความออกอินเทอร์เน็ต อย่าใส่ข้อมูลผู้ป่วยจริง)" />
          <div className="px-5 pb-5 space-y-3 text-sm">
            {aiConfigured === null && <div className="text-base-500">กำลังเช็ค...</div>}
            {aiConfigured === true && <div className="flex items-center gap-2 text-good"><CheckCircle2 size={16} /> ตั้งค่า Gemini API key ไว้แล้ว พร้อมใช้งาน</div>}
            {aiConfigured === false && (
              <>
                <div className="flex items-center gap-2 text-warn"><XCircle size={16} /> ยังไม่ได้ตั้งค่า Gemini API key</div>
                <ol className="text-xs text-base-400 space-y-1.5 list-decimal list-inside">
                  <li>ขอ API key ฟรีที่{" "}
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-accent-400 hover:underline inline-flex items-center gap-1">
                      aistudio.google.com/apikey <ExternalLink size={10} />
                    </a>
                  </li>
                  <li>สร้างไฟล์ชื่อ <code className="text-base-300">.env</code> ในโฟลเดอร์ <code className="text-base-300">backend</code></li>
                  <li>ใส่บรรทัดเดียว: <code className="text-base-300">GEMINI_API_KEY=ค่าคีย์ของคุณ</code></li>
                  <li>ปิดแล้วเปิด backend ใหม่</li>
                </ol>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="เกี่ยวกับ" />
          <div className="px-5 pb-5 text-sm text-base-400 space-y-2">
            <p>LLM Studio {version && `เวอร์ชัน ${version}`} เครื่องมือควบคุมการเทรน/ทดสอบโมเดลภาษาไทยในเครื่อง local ครอบ Unsloth + Ollama ไว้ในหน้าเว็บเดียว ข้อมูลทั้งหมดอยู่ในเครื่อง</p>
            <p>ดูวิธีติดตั้งและใช้งานได้ที่ README.md ในโปรเจกต์</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
