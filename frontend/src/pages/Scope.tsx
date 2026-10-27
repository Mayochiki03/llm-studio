// ขอบเขตการตอบ: ตั้งว่าระบบ "ควรตอบเอง / ตอบตายตัว / บอกว่าไม่มีข้อมูล" เมื่อไหร่ แก้ได้ทันทีโดยไม่ต้องเทรนใหม่
// ใช้กับทั้งหน้า "ลองคุย" และ API ที่ระบบอื่นเรียก (กฎเดียวกัน) — ตรรกะอยู่ที่ backend/guard.py
import { useEffect, useState } from "react";
import { Plus, Trash2, Save, RotateCcw, FlaskConical, ShieldAlert, Ban, MessageSquareQuote } from "lucide-react";
import Topbar from "../components/Topbar";
import { Card, CardHeader } from "../components/Card";
import Button from "../components/Button";
import { Field, NumberInput, Notice, Pill, Spinner, TextArea, TextInput, Toggle } from "../components/ui";
import { toast, errText } from "../components/toast";
import { api, type ScopeConfig, type ScopeRule, type ScopeTestResult } from "../api/client";

/** แปลงข้อความ "บรรทัดละคำ" หรือคั่นด้วย comma เป็นรายการคำ (ตัดว่าง/ซ้ำ) */
export function splitWords(text: string): string[] {
  return Array.from(new Set(text.split(/[\n,，]/).map((x) => x.trim()).filter(Boolean)));
}

const newRule = (kind: ScopeRule["kind"]): ScopeRule => ({
  id: `rule-${Date.now().toString(36)}`, name: kind === "red_flag" ? "เคสอันตรายใหม่" : kind === "canned" ? "คำตอบสำเร็จรูปใหม่" : "หัวข้อต้องห้ามใหม่", kind, enabled: true, keywords: [], reply: "",
});

export default function Scope() {
  const [cfg, setCfg] = useState<ScopeConfig | null>(null);
  const [def, setDef] = useState<ScopeConfig | null>(null);
  const [minScore, setMinScore] = useState(0.2);
  const [topK, setTopK] = useState(4);
  const [sys, setSys] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [kwText, setKwText] = useState<Record<string, string>>({});   // ข้อความคำสำคัญที่กำลังพิมพ์ต่อกฎ (เก็บดิบไว้ให้พิมพ์ comma ได้ลื่น)
  const [talkText, setTalkText] = useState("");
  const [wlText, setWlText] = useState("");    // รายการเลขที่อนุญาต (พิมพ์ดิบ)
  const [probe, setProbe] = useState("");
  const [probeRes, setProbeRes] = useState<ScopeTestResult | null>(null);

  const load = () => api.scope().then((r) => {
    setCfg(r.scope); setDef(r.default); setMinScore(r.kb_min_score); setTopK(r.kb_top_k); setSys(r.default_system_prompt);
    setKwText(Object.fromEntries(r.scope.rules.map((x) => [x.id, x.keywords.join(", ")])));
    setTalkText(r.scope.smalltalk_keywords.join(", "));
    setWlText((r.scope.number_whitelist ?? []).join(", "));
    setDirty(false);
  }).catch((e) => toast(errText(e), "bad"));
  useEffect(() => { load(); }, []);

  if (!cfg || !def) return <div className="flex-1"><Topbar title="ขอบเขตการตอบ" /><Spinner /></div>;

  const edit = (p: Partial<ScopeConfig>) => { setCfg({ ...cfg, ...p }); setDirty(true); };
  const patchRule = (id: string, p: Partial<ScopeRule>) => edit({ rules: cfg.rules.map((r) => (r.id === id ? { ...r, ...p } : r)) });

  async function save() {
    if (!cfg) return;
    setSaving(true);
    try {
      const rules = cfg.rules.map((r) => ({ ...r, keywords: splitWords(kwText[r.id] ?? r.keywords.join(", ")) }));
      const r = await api.saveScope({ scope: { ...cfg, rules, smalltalk_keywords: splitWords(talkText), number_whitelist: splitWords(wlText) }, kb_min_score: minScore, kb_top_k: topK, default_system_prompt: sys });
      setCfg(r.scope);
      setKwText(Object.fromEntries(r.scope.rules.map((x) => [x.id, x.keywords.join(", ")])));
      setTalkText(r.scope.smalltalk_keywords.join(", "));
      setWlText((r.scope.number_whitelist ?? []).join(", "));
      setDirty(false);
      toast("บันทึกขอบเขตแล้ว มีผลทันที ไม่ต้องรีสตาร์ท");
    } catch (e) { toast(errText(e), "bad"); } finally { setSaving(false); }
  }

  async function runProbe() {
    try { setProbeRes(await api.scopeTest(probe)); } catch (e) { toast(errText(e), "bad"); }
  }

  function resetDefault() {
    if (!def || !confirm("คืนกฎและข้อความทั้งหมดเป็นค่าเริ่มต้น? (ยังไม่บันทึกจนกว่าจะกดบันทึก)")) return;
    setCfg(def);
    setKwText(Object.fromEntries(def.rules.map((x) => [x.id, x.keywords.join(", ")])));
    setTalkText(def.smalltalk_keywords.join(", "));
    setWlText((def.number_whitelist ?? []).join(", "));
    setDirty(true);
  }

  const RuleBox = ({ r }: { r: ScopeRule }) => (
    <div className={`border rounded-lg p-3 space-y-2.5 ${r.enabled ? "border-base-800" : "border-base-800 opacity-60"}`}>
      <div className="flex items-center gap-2">
        <TextInput value={r.name} onChange={(e) => patchRule(r.id, { name: e.target.value })} aria-label="ชื่อกฎ" />
        <Toggle checked={r.enabled} onChange={(v) => patchRule(r.id, { enabled: v })} label="เปิดใช้" />
        <button className="text-base-500 hover:text-bad p-1.5 shrink-0" aria-label="ลบกฎ" onClick={() => edit({ rules: cfg.rules.filter((x) => x.id !== r.id) })}><Trash2 size={15} /></button>
      </div>
      <Field label="ถ้าข้อความมีคำเหล่านี้ (คั่นด้วย comma หรือขึ้นบรรทัดใหม่)">
        <TextArea rows={2} value={kwText[r.id] ?? r.keywords.join(", ")} onChange={(e) => { setKwText({ ...kwText, [r.id]: e.target.value }); setDirty(true); }} />
      </Field>
      <Field label="ให้ตอบข้อความนี้ทันที (โมเดลไม่ได้เข้ามาเกี่ยว)">
        <TextArea rows={3} value={r.reply} onChange={(e) => patchRule(r.id, { reply: e.target.value })} />
      </Field>
    </div>
  );

  const red = cfg.rules.filter((r) => r.kind === "red_flag");
  const blocked = cfg.rules.filter((r) => r.kind === "blocked");
  const canned = cfg.rules.filter((r) => r.kind === "canned");

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="ขอบเขตการตอบ" subtitle="กำหนดว่าระบบตอบอะไรได้ ตอบอะไรไม่ได้ แก้ได้ทันทีโดยไม่ต้องเทรนใหม่" />
      <div className="p-4 md:p-8 max-w-3xl space-y-5">
        <Notice tone="info">
          ลำดับการตัดสินก่อนถึงโมเดล: ① ตรงกับ <b>เคสอันตราย</b> หรือ <b>หัวข้อต้องห้าม</b> → ตอบข้อความที่เขียนไว้ทันที ② ตรงกับ <b>คำตอบสำเร็จรูป</b> (เช่น แนะนำตัว) → ตอบข้อความที่เขียนไว้ ③ ทักทาย/ถามชื่อ → ให้โมเดลตอบ ④ ค้นคลังความรู้ไม่เจอเอกสารที่เกี่ยวข้อง → ตอบ "ไม่มีข้อมูล" ⑤ นอกนั้นให้โมเดลตอบจากเอกสารที่ค้นเจอ แล้วตรวจเลขในคำตอบกับเอกสารอีกชั้น
          ใช้กฎชุดเดียวกันทั้งหน้า "ลองคุยกับโมเดล" และ API ที่ระบบอื่นเรียก
        </Notice>

        <Card>
          <CardHeader title="ภาพรวม" subtitle="เปิด/ปิดทั้งชุด และคำตอบเมื่อไม่มีข้อมูล" />
          <div className="px-5 pb-5 space-y-4">
            <Toggle checked={cfg.enabled} onChange={(v) => edit({ enabled: v })} label="เปิดใช้ขอบเขตการตอบ" hint="ปิด = ทุกคำถามผ่านไปให้โมเดลตอบเอง (ไม่แนะนำเมื่อใช้งานจริง)" />
            <Toggle checked={cfg.require_context} onChange={(v) => edit({ require_context: v })} label="ต้องมีเอกสารรองรับ จึงจะให้โมเดลตอบ" hint="ถ้าค้นคลังความรู้ไม่เจอเรื่องที่เกี่ยวข้อง จะตอบ 'ไม่มีข้อมูล' เลย ไม่ปล่อยให้โมเดลเดา" />
            <Field label="ข้อความเมื่อไม่มีข้อมูล"><TextArea rows={2} value={cfg.no_info_reply} onChange={(e) => edit({ no_info_reply: e.target.value })} /></Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="เกณฑ์ความเกี่ยวข้องของเอกสาร (0-1)" hint="ยิ่งสูงยิ่งเข้มงวด เอกสารที่คะแนนต่ำกว่านี้ถือว่าไม่เกี่ยว ค่าเริ่มต้น 0.2">
                <NumberInput value={minScore} step={0.05} min={0} max={1} onChange={(v) => { setMinScore(v); setDirty(true); }} />
              </Field>
              <Field label="จำนวนชิ้นเอกสารที่ให้โมเดลอ่าน" hint="แนะนำ 3-5">
                <NumberInput value={topK} step={1} min={1} max={20} onChange={(v) => { setTopK(v); setDirty(true); }} />
              </Field>
            </div>
            <Field label="คำสั่งพื้นฐานให้โมเดล (system prompt)" hint="บอกบทบาท น้ำเสียง และกติกา เช่น ตอบภาษาไทยสุภาพ ลงท้ายค่ะ อ้างอิงเฉพาะเอกสารที่ให้">
              <TextArea rows={4} value={sys} onChange={(e) => { setSys(e.target.value); setDirty(true); }} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="เคสอันตราย (ตอบตายตัวด่วน)" subtitle="เช่น อยากทำร้ายตัวเอง ชัก หมดสติ ควรให้เบอร์ฉุกเฉินเสมอ ไม่ปล่อยให้โมเดลเรียบเรียงเอง" />
          <div className="px-5 pb-5 space-y-3">
            {red.length === 0 && <div className="text-sm text-base-500 flex items-center gap-2"><ShieldAlert size={15} /> ยังไม่มีเคสอันตราย</div>}
            {red.map((r) => <RuleBox key={r.id} r={r} />)}
            <Button variant="secondary" className="text-xs py-1.5" onClick={() => { const r = newRule("red_flag"); edit({ rules: [...cfg.rules, r] }); setKwText({ ...kwText, [r.id]: "" }); }}><Plus size={13} /> เพิ่มเคสอันตราย</Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="หัวข้อต้องห้าม" subtitle="เรื่องที่ระบบไม่ควรตอบเอง เช่น วินิจฉัยโรค แนะนำยา ให้ตอบข้อความที่กำหนดแทน" />
          <div className="px-5 pb-5 space-y-3">
            {blocked.length === 0 && <div className="text-sm text-base-500 flex items-center gap-2"><Ban size={15} /> ยังไม่มีหัวข้อต้องห้าม</div>}
            {blocked.map((r) => <RuleBox key={r.id} r={r} />)}
            <Button variant="secondary" className="text-xs py-1.5" onClick={() => { const r = newRule("blocked"); edit({ rules: [...cfg.rules, r] }); setKwText({ ...kwText, [r.id]: "" }); }}><Plus size={13} /> เพิ่มหัวข้อต้องห้าม</Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="คำตอบสำเร็จรูป" subtitle="คำถามที่คำตอบไม่เปลี่ยน เช่น แนะนำตัว ทำอะไรได้บ้าง ตอบข้อความตายตัวโดยไม่เรียกโมเดล (โมเดลเล็กมักตอบเลอะ) เคสอันตรายและหัวข้อต้องห้ามมาก่อนเสมอ" />
          <div className="px-5 pb-5 space-y-3">
            {canned.length === 0 && <div className="text-sm text-base-500 flex items-center gap-2"><MessageSquareQuote size={15} /> ยังไม่มีคำตอบสำเร็จรูป</div>}
            {canned.map((r) => <RuleBox key={r.id} r={r} />)}
            <Button variant="secondary" className="text-xs py-1.5" onClick={() => { const r = newRule("canned"); edit({ rules: [...cfg.rules, r] }); setKwText({ ...kwText, [r.id]: "" }); }}><Plus size={13} /> เพิ่มคำตอบสำเร็จรูป</Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="ตรวจเลขในคำตอบ" subtitle="เบอร์โทร เวลา ตัวเลข ที่โมเดลตอบต้องมีอยู่ในเอกสารที่ค้นมา ถ้าแต่งเลขเอง จะถูกแทนที่ด้วยข้อความปลอดภัย" />
          <div className="px-5 pb-5 space-y-4">
            <Toggle checked={cfg.verify_numbers} onChange={(v) => edit({ verify_numbers: v })} label="เปิดตรวจเลขหลังโมเดลตอบ" hint="ตรวจเฉพาะตอนใช้คลังความรู้และมีเอกสารที่ค้นเจอ ใช้ได้ทั้งหน้าลองคุยและ API" />
            <Field label="เลขที่อนุญาตเสมอ (คั่นด้วย comma)" hint="เช่น เบอร์ฉุกเฉินทั่วไป 1669, 1323 ที่โมเดลพูดได้แม้ไม่อยู่ในเอกสาร">
              <TextInput value={wlText} onChange={(e) => { setWlText(e.target.value); setDirty(true); }} />
            </Field>
            <Field label="ข้อความที่ใช้แทนเมื่อเลขไม่ตรง"><TextArea rows={2} value={cfg.number_reply} onChange={(e) => edit({ number_reply: e.target.value })} /></Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="คุยทั่วไป (ไม่ต้องมีเอกสาร)" subtitle="ข้อความสั้นที่มีคำเหล่านี้ เช่น ทักทาย ขอบคุณ ถามชื่อ จะผ่านไปให้โมเดลตอบได้" />
          <div className="px-5 pb-5">
            <TextArea rows={2} value={talkText} onChange={(e) => { setTalkText(e.target.value); setDirty(true); }} />
          </div>
        </Card>

        <Card>
          <CardHeader title="ลองข้อความ" subtitle="ดูว่าข้อความนี้จะถูกจัดการแบบไหน โดยไม่เรียกโมเดล (ใช้ค่าที่ บันทึกแล้ว เท่านั้น)" />
          <div className="px-5 pb-5 space-y-3">
            <div className="flex gap-2">
              <TextInput value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="พิมพ์คำถาม เช่น ที่จอดรถเสียค่าบริการไหม" onKeyDown={(e) => e.key === "Enter" && probe.trim() && runProbe()} />
              <Button variant="secondary" onClick={runProbe} disabled={!probe.trim()}><FlaskConical size={14} /> ลอง</Button>
            </div>
            {probeRes && (
              <div className="text-sm space-y-2">
                {probeRes.decision ? (
                  <Notice tone={probeRes.decision.kind === "red_flag" ? "bad" : probeRes.decision.kind === "canned" ? "info" : "warn"}>
                    <b>{probeRes.decision.kind === "red_flag" ? "เคสอันตราย" : probeRes.decision.kind === "blocked" ? "หัวข้อต้องห้าม" : probeRes.decision.kind === "canned" ? "คำตอบสำเร็จรูป" : "ไม่พบเอกสารที่เกี่ยวข้อง"}</b> ({probeRes.decision.rule_name}) ตอบทันทีว่า: {probeRes.decision.reply}
                  </Notice>
                ) : (
                  <Notice tone="good">ผ่านไปให้โมเดลตอบ{probeRes.smalltalk ? " (เป็นการคุยทั่วไป)" : ""}</Notice>
                )}
                {probeRes.hits.length > 0 && (
                  <div className="text-xs text-base-400">เอกสารที่ค้นเจอ: {probeRes.hits.map((h, i) => <span key={i} className="mr-2"><Pill>{h.title} · {h.score}</Pill></span>)}</div>
                )}
              </div>
            )}
          </div>
        </Card>

        <div className="flex items-center justify-between gap-3 sticky bottom-0 bg-base-950/90 backdrop-blur py-3">
          <Button variant="ghost" onClick={resetDefault}><RotateCcw size={14} /> คืนค่าเริ่มต้น</Button>
          <div className="flex items-center gap-3">
            {dirty && <span className="text-xs text-warn">มีการแก้ไขที่ยังไม่บันทึก</span>}
            <Button onClick={save} disabled={!dirty || saving}><Save size={14} /> {saving ? "กำลังบันทึก..." : "บันทึก"}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
