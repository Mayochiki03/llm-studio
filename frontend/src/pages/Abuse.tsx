// ป้องกันถามซ้ำ/สแปม: ตั้งเกณฑ์ว่าถามซ้ำกี่ครั้งใช้คำตอบเดิม → เตือน → พักการใช้งาน, ลองจำลองก่อนบันทึก, ดูคนที่ถูกพักและปลดล็อก
// ตรรกะอยู่ที่ backend/abuse.py (กติกาล้วน ไม่ใช้ AI) เคสอันตรายไม่ถูกจำกัดเด็ดขาด
import { useCallback, useEffect, useRef, useState } from "react";
import { Save, FlaskConical, Unlock, RotateCcw, ShieldCheck, Timer } from "lucide-react";
import Topbar from "../components/Topbar";
import { Card, CardHeader } from "../components/Card";
import Button from "../components/Button";
import { Field, NumberInput, Notice, Pill, Spinner, TextArea, TextInput, Toggle } from "../components/ui";
import { toast, errText } from "../components/toast";
import { api, type AbuseConfig, type AbusePreset, type AbuseSimResult, type AbuseStatus } from "../api/client";

/** แปลงข้อความ "60, 300, 1800" เป็นรายการวินาที (ตัดค่าไม่ใช่ตัวเลข) */
export function parseCooldowns(text: string): number[] {
  return text.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0);
}

/** วินาที → ข้อความอ่านง่าย (เช่น 90 → "1 นาที 30 วินาที") */
export function fmtSecs(s: number): string {
  if (s < 60) return `${s} วินาที`;
  if (s < 3600) return `${Math.floor(s / 60)} นาที${s % 60 ? ` ${s % 60} วินาที` : ""}`;
  return `${Math.floor(s / 3600)} ชั่วโมง${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} นาที` : ""}`;
}

const ACTION: Record<string, { label: string; tone: "good" | "info" | "warn" | "bad" }> = {
  allow: { label: "ให้โมเดลตอบ", tone: "good" },
  cached: { label: "ใช้คำตอบเดิม", tone: "info" },
  warn: { label: "เตือน", tone: "warn" },
  block: { label: "พักการใช้งาน", tone: "bad" },
};
const REASON: Record<string, string> = { repeat: "ถามซ้ำ", cooldown: "ยังอยู่ในช่วงพัก", rate: "ถามถี่เกินต่อนาที", long: "ข้อความยาวเกิน", "": "" };

export default function Abuse() {
  const [cfg, setCfg] = useState<AbuseConfig | null>(null);
  const [presets, setPresets] = useState<Record<string, AbusePreset>>({});
  const [def, setDef] = useState<AbuseConfig | null>(null);
  const [status, setStatus] = useState<AbuseStatus | null>(null);
  const [cdText, setCdText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [simQ, setSimQ] = useState("ขอเวลาทำการหน่อย");
  const [simN, setSimN] = useState(12);
  const [simGap, setSimGap] = useState(5);
  const [sim, setSim] = useState<AbuseSimResult | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const load = useCallback(() => api.abuse().then((r) => {
    setPresets(r.presets); setDef(r.default); setStatus(r.status);
    if (!dirtyRef.current) { setCfg(r.config); setCdText(r.config.cooldown_s.join(", ")); }   // ระหว่างแก้อยู่ ไม่ทับค่าที่พิมพ์
  }).catch((e) => toast(errText(e), "bad")), []);

  useEffect(() => {
    load();
    const t = setInterval(() => { api.abuse().then((r) => setStatus(r.status)).catch(() => {}); }, 5000);   // สถานะสดทุก 5 วินาที
    return () => clearInterval(t);
  }, [load]);

  if (!cfg || !def) return <div className="flex-1"><Topbar title="ป้องกันถามซ้ำ/สแปม" /><Spinner /></div>;

  const edit = (p: Partial<AbuseConfig>) => { setCfg({ ...cfg, ...p, preset: "custom" }); setDirty(true); };
  const current = (): AbuseConfig => ({ ...cfg, cooldown_s: parseCooldowns(cdText) });

  function applyPreset(name: string) {
    const p = presets[name];
    if (!p) return;
    setCfg({ ...cfg!, ...p, preset: name }); setCdText(p.cooldown_s.join(", ")); setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const r = await api.saveAbuse(current());
      setCfg(r.config); setCdText(r.config.cooldown_s.join(", ")); setDirty(false);
      toast("บันทึกแล้ว มีผลทันที ไม่ต้องรีสตาร์ท");
    } catch (e) { toast(errText(e), "bad"); } finally { setSaving(false); }
  }

  async function runSim() {
    try { setSim(await api.abuseSimulate(current(), simQ, simN, simGap)); } catch (e) { toast(errText(e), "bad"); }
  }

  async function unlock(client: string) {
    try { await api.abuseUnlock(client); toast("ปลดล็อกแล้ว"); load(); } catch (e) { toast(errText(e), "bad"); }
  }

  async function resetAll() {
    if (!confirm("ล้างสถานะทั้งหมด (ประวัติถามซ้ำ ช่วงพัก แคชคำตอบ) ?")) return;
    try { await api.abuseReset(); toast("ล้างแล้ว"); load(); } catch (e) { toast(errText(e), "bad"); }
  }

  const c = status?.counters;

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="ป้องกันถามซ้ำ/สแปม" subtitle="ถามซ้ำหลายครั้งหรือยิงถี่ ระบบจะเบาแรงลงเป็นขั้น เพื่อไม่ให้เปลือง GPU" />
      <div className="p-4 md:p-8 max-w-3xl space-y-5">
        <Notice tone="info">
          ยิ่งถามซ้ำ ระบบยิ่งเบาแรง: <b>ใช้คำตอบเดิม</b> (ไม่เรียกโมเดล) → <b>เตือนสุภาพ</b> → <b>พักการใช้งานชั่วคราว</b> (พักนานขึ้นถ้าทำซ้ำอีก)
          เคสอันตรายและกฎตอบตายตัว <b>ไม่ถูกจำกัดเด็ดขาด</b> ระบบไม่เก็บตัวข้อความคำถามไว้ เก็บแค่ความยาวกับรหัสย่อ
        </Notice>

        <Card>
          <CardHeader title="ภาพรวมและชุดค่าสำเร็จรูป" subtitle="เลือกชุดค่าแล้วปรับต่อได้ละเอียดด้านล่าง" />
          <div className="px-5 pb-5 space-y-4">
            <Toggle checked={cfg.enabled} onChange={(v) => { setCfg({ ...cfg, enabled: v }); setDirty(true); }} label="เปิดใช้การป้องกันถามซ้ำ/สแปม" hint="ใช้กับ API ที่ระบบอื่นเรียก (แยกรายคนได้ด้วย client_id)" />
            <div className="flex flex-wrap gap-2">
              {Object.entries(presets).map(([k, p]) => (
                <button key={k} type="button" onClick={() => applyPreset(k)} title={p.hint}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition ${cfg.preset === k ? "border-accent-400 text-accent-300 bg-base-850" : "border-base-700 text-base-300 hover:border-base-500"}`}>
                  {p.label}
                </button>
              ))}
              {cfg.preset === "custom" && <Pill>กำหนดเอง</Pill>}
            </div>
            {presets[cfg.preset] && <p className="text-xs text-base-500">{presets[cfg.preset].hint}</p>}
            <Toggle checked={cfg.exempt_playground} onChange={(v) => { setCfg({ ...cfg, exempt_playground: v }); setDirty(true); }} label="ไม่จำกัดหน้า 'ลองคุยกับโมเดล'" hint="เจ้าหน้าที่ทดสอบเองจึงไม่ควรโดนพัก ปิดเมื่อต้องการลองดูอาการจริงในหน้านั้น" />
          </div>
        </Card>

        <Card>
          <CardHeader title="เกณฑ์ถามซ้ำ" subtitle="นับคำถามเดียวกัน (ต่างแค่ช่องว่าง/วรรคตอนถือว่าเหมือนกัน) ภายในช่วงเวลาที่กำหนด" />
          <div className="px-5 pb-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="นับย้อนหลัง (วินาที)" hint="เช่น 600 = ดูเฉพาะที่ถามซ้ำใน 10 นาทีล่าสุด"><NumberInput value={cfg.window_s} step={30} min={10} onChange={(v) => edit({ window_s: v })} /></Field>
              <Field label="เก็บคำตอบเดิมไว้ (วินาที)" hint="ใช้ตอบซ้ำโดยไม่เรียกโมเดล"><NumberInput value={cfg.cache_ttl_s} step={30} min={10} onChange={(v) => edit({ cache_ttl_s: v })} /></Field>
              <Field label="ถามซ้ำเกิน ... ครั้ง → ใช้คำตอบเดิม" hint={`ครั้งที่ ${cfg.cache_after + 1} เป็นต้นไป`}><NumberInput value={cfg.cache_after} min={0} onChange={(v) => edit({ cache_after: v })} /></Field>
              <Field label="ถามซ้ำเกิน ... ครั้ง → เตือน" hint={`ครั้งที่ ${cfg.warn_after + 1} เป็นต้นไป`}><NumberInput value={cfg.warn_after} min={1} onChange={(v) => edit({ warn_after: v })} /></Field>
              <Field label="ถามซ้ำเกิน ... ครั้ง → พักการใช้งาน" hint={`ครั้งที่ ${cfg.block_after + 1} เป็นต้นไป`}><NumberInput value={cfg.block_after} min={1} onChange={(v) => edit({ block_after: v })} /></Field>
              <Field label="ระยะพักแต่ละครั้ง (วินาที คั่นด้วย comma)" hint={`ตอนนี้: ${parseCooldowns(cdText).map(fmtSecs).join(" → ") || "ยังไม่ถูกต้อง"} (ครั้งสุดท้ายใช้ซ้ำ)`}>
                <TextInput value={cdText} onChange={(e) => { setCdText(e.target.value); setCfg({ ...cfg, preset: "custom" }); setDirty(true); }} />
              </Field>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="เพดานอื่นๆ" subtitle="กันยิงถี่และข้อความยาวผิดปกติ (ไม่ขึ้นกับว่าถามซ้ำหรือไม่)" />
          <div className="px-5 pb-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="ถามได้สูงสุดต่อนาที (ต่อคน)"><NumberInput value={cfg.rate_per_min} min={1} onChange={(v) => edit({ rate_per_min: v })} /></Field>
            <Field label="ความยาวข้อความสูงสุด (ตัวอักษร)"><NumberInput value={cfg.max_chars} step={100} min={50} onChange={(v) => edit({ max_chars: v })} /></Field>
            <Field label="ล้างประวัติทำผิดเมื่อสงบนาน (วินาที)" hint="หลังพักแล้วไม่ทำผิดนานเท่านี้ ครั้งหน้าพักสั้นกลับไปเท่าเดิม"><NumberInput value={cfg.strike_decay_s} step={300} min={60} onChange={(v) => edit({ strike_decay_s: v })} /></Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="ข้อความที่ตอบ" />
          <div className="px-5 pb-5 space-y-3">
            <Field label="เมื่อเตือน"><TextArea rows={2} value={cfg.warn_reply} onChange={(e) => edit({ warn_reply: e.target.value })} /></Field>
            <Field label="เมื่อถูกพักการใช้งาน"><TextArea rows={2} value={cfg.block_reply} onChange={(e) => edit({ block_reply: e.target.value })} /></Field>
            <Field label="เมื่อถามถี่เกินต่อนาที"><TextArea rows={2} value={cfg.rate_reply} onChange={(e) => edit({ rate_reply: e.target.value })} /></Field>
            <Field label="เมื่อข้อความยาวเกิน"><TextArea rows={2} value={cfg.long_reply} onChange={(e) => edit({ long_reply: e.target.value })} /></Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="ลองจำลอง" subtitle="ถามข้อเดียวซ้ำ ๆ แล้วดูว่าแต่ละครั้งระบบทำอะไร ใช้ค่าที่กำลังแก้อยู่ (ยังไม่ต้องบันทึก) ไม่เรียกโมเดลจริง" />
          <div className="px-5 pb-5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 items-end">
              <Field label="คำถาม"><TextInput value={simQ} onChange={(e) => setSimQ(e.target.value)} /></Field>
              <Field label="ถามกี่ครั้ง"><NumberInput value={simN} min={1} max={60} onChange={setSimN} className="w-24" /></Field>
              <Field label="ห่างกัน (วินาที)"><NumberInput value={simGap} min={0} onChange={setSimGap} className="w-24" /></Field>
            </div>
            <Button variant="secondary" onClick={runSim} disabled={!simQ.trim()}><FlaskConical size={14} /> จำลอง</Button>
            {sim && (
              <div className="space-y-2">
                <Notice tone="good">ถาม {sim.total} ครั้ง เรียกโมเดลจริงแค่ <b>{sim.model_calls}</b> ครั้ง ประหยัด <b>{sim.saved}</b> ครั้ง</Notice>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-base-500"><th className="py-1 pr-3">ครั้งที่</th><th className="pr-3">เวลา</th><th className="pr-3">ผล</th><th>หมายเหตุ</th></tr></thead>
                    <tbody>
                      {sim.rows.map((r) => (
                        <tr key={r.n} className="border-t border-base-800">
                          <td className="py-1 pr-3">{r.n}</td>
                          <td className="pr-3">{fmtSecs(Math.round(r.at_s))}</td>
                          <td className="pr-3"><Pill tone={ACTION[r.action]?.tone}>{ACTION[r.action]?.label ?? r.action}</Pill></td>
                          <td className="text-base-400">{REASON[r.reason] ?? r.reason}{r.action === "block" && r.retry_after ? ` · รอ ${fmtSecs(r.retry_after)}` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="สถานะสด" subtitle="อัปเดตทุก 5 วินาที (เก็บในหน่วยความจำ รีสตาร์ท backend แล้วเริ่มใหม่)" />
          <div className="px-5 pb-5 space-y-4">
            {c && (
              <div className="flex flex-wrap gap-2 text-xs">
                <Pill tone="good">ให้โมเดลตอบ {c.allow}</Pill><Pill tone="info">ใช้คำตอบเดิม {c.cached}</Pill><Pill tone="warn">เตือน {c.warn}</Pill>
                <Pill tone="bad">พัก {c.block}</Pill><Pill>ถี่เกิน {c.rate}</Pill><Pill>ยาวเกิน {c.long}</Pill>
              </div>
            )}
            {status && status.cooling.length === 0 && <div className="text-sm text-base-500 flex items-center gap-2"><ShieldCheck size={15} /> ตอนนี้ไม่มีใครถูกพัก</div>}
            {status?.cooling.map((x) => (
              <div key={x.client} className="flex items-center justify-between gap-3 border border-base-800 rounded-lg p-3">
                <div className="min-w-0 text-sm"><div className="text-base-100 break-all">{x.client}</div><div className="text-[11px] text-base-500 flex items-center gap-1"><Timer size={11} /> เหลือ {fmtSecs(x.retry_after)} · ทำผิดมาแล้ว {x.strikes} ครั้ง</div></div>
                <Button variant="secondary" className="text-xs py-1.5 shrink-0" onClick={() => unlock(x.client)}><Unlock size={13} /> ปลดล็อก</Button>
              </div>
            ))}
            {status && status.events.length > 0 && (
              <div className="overflow-x-auto">
                <div className="text-xs text-base-400 mb-1">เหตุการณ์ล่าสุด</div>
                <table className="w-full text-xs">
                  <tbody>
                    {status.events.slice(0, 12).map((e, i) => (
                      <tr key={i} className="border-t border-base-800">
                        <td className="py-1 pr-3 text-base-500 whitespace-nowrap">{fmtSecs(e.age_s)}ก่อน</td>
                        <td className="pr-3 break-all">{e.client}</td>
                        <td className="pr-3"><Pill tone={ACTION[e.action]?.tone}>{ACTION[e.action]?.label ?? e.action}</Pill></td>
                        <td className="text-base-500">{REASON[e.reason] ?? e.reason} · ครั้งที่ {e.count} · ยาว {e.len} · #{e.hash}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Button variant="ghost" className="text-xs" onClick={resetAll}><RotateCcw size={13} /> ล้างสถานะและแคชทั้งหมด</Button>
          </div>
        </Card>

        <div className="flex items-center justify-between gap-3 sticky bottom-0 bg-base-950/90 backdrop-blur py-3">
          <Button variant="ghost" onClick={() => { setCfg(def); setCdText(def.cooldown_s.join(", ")); setDirty(true); }}><RotateCcw size={14} /> คืนค่าเริ่มต้น</Button>
          <div className="flex items-center gap-3">
            {dirty && <span className="text-xs text-warn">มีการแก้ไขที่ยังไม่บันทึก</span>}
            <Button onClick={save} disabled={!dirty || saving}><Save size={14} /> {saving ? "กำลังบันทึก..." : "บันทึก"}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
