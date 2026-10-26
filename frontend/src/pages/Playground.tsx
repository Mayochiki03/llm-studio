// Playground: คุยกับโมเดลใน Ollama แบบสตรีม เลือกได้ว่าจะให้ดึงความรู้จากคลังมาช่วยตอบหรือไม่ และเห็นแหล่งที่มา
import { useEffect, useRef, useState } from "react";
import { Send, Square, Trash2, BookOpen, SlidersHorizontal, MessageSquare, ShieldCheck } from "lucide-react";
import Topbar from "../components/Topbar";
import Button from "../components/Button";
import { Card } from "../components/Card";
import { Empty, Field, Notice, Pill, TextArea, Toggle, NumberInput } from "../components/ui";
import { toast, errText } from "../components/toast";
import { api } from "../api/client";
import { reportError } from "../lib/clientLog";
import type { KbHit } from "../types";

interface Msg {
  role: "user" | "assistant";
  content: string;
  hits?: KbHit[];
  mode?: string;
  note?: string;
  stats?: string;
  error?: boolean;
  guard?: string; // ถูกตอบตามกฎขอบเขต (ชนิด/ชื่อกฎ) ไม่ได้ผ่านโมเดล
}

// เก็บบทสนทนาและตัวเลือกไว้ใน localStorage ของเบราว์เซอร์: สลับหน้า เปิดแท็บใหม่ หรือปิดเปิดเบราว์เซอร์แล้วยังอยู่
// (เดิมใช้ sessionStorage ซึ่งหายทันทีเมื่อเปิดแท็บใหม่) เก็บเฉพาะในเครื่องนี้ ล้างได้ด้วยปุ่ม "ล้างบทสนทนา"
// จำกัดแค่ข้อความล่าสุด MAX_KEEP ข้อความ กันเต็มโควตา ห่อ try/catch เผื่อเบราว์เซอร์ปิดการเก็บข้อมูล
const SAVE_KEY = "llmstudio.playground.v1";
const MAX_KEEP = 100;
interface Saved { msgs: Msg[]; model: string; useKb: boolean; scopeOn: boolean; system: string | null; temp: number; input: string }

function loadSaved(): Partial<Saved> {
  try {
    // รองรับข้อมูลเก่าที่ยังค้างใน sessionStorage ของแท็บนี้ด้วย
    const raw = localStorage.getItem(SAVE_KEY) ?? sessionStorage.getItem(SAVE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Partial<Saved>;
    const msgs = Array.isArray(o.msgs) ? o.msgs.filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant")) : [];
    // ถ้าออกจากหน้าตอนโมเดลยังตอบไม่จบ จะเหลือข้อความว่าง/ค้างครึ่งทาง: ทำเครื่องหมายให้รู้ว่าถูกตัด
    const last = msgs[msgs.length - 1];
    if (last && last.role === "assistant" && !last.stats && !last.error) {
      last.content = (last.content || "") + (last.content ? "\n\n" : "") + "(ถูกตัดเพราะออกจากหน้าก่อนตอบจบ)";
      last.error = !last.content.trim() ? true : false;
    }
    return { ...o, msgs };
  } catch {
    return {};
  }
}

export default function Playground() {
  const saved = useRef<Partial<Saved>>(loadSaved()).current;
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(saved.model ?? "");
  const [useKb, setUseKb] = useState(saved.useKb ?? true);
  const [scopeOn, setScopeOn] = useState(saved.scopeOn ?? true);
  const [system, setSystem] = useState(saved.system ?? "");
  const [temp, setTemp] = useState(typeof saved.temp === "number" ? saved.temp : 0.7);
  const [showOpts, setShowOpts] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(saved.msgs ?? []);
  const [input, setInput] = useState(saved.input ?? "");
  const [busy, setBusy] = useState(false);
  const [ollamaDown, setOllamaDown] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.ollamaModels()
      .then((r) => {
        // ป้องกันข้อมูลผิดรูปจาก Ollama/backend: เอาเฉพาะชื่อที่เป็นข้อความ และตัดชื่อซ้ำ ไม่ให้หน้าพัง
        const raw = Array.isArray(r?.models) ? r.models : [];
        const names = Array.from(new Set(raw.map((m) => (m && typeof m.name === "string" ? m.name : "")).filter((n) => n && !/embed|bge|minilm/i.test(n))));
        setModels(names);
        // ถ้ามีโมเดลที่ตั้งเป็นใช้งานจริงในทะเบียน ให้เลือกตัวนั้นก่อน
        api.registry().then((v) => {
          const act = v.find((x) => x.status === "active")?.name;
          // ใช้โมเดลที่เลือกไว้รอบก่อนถ้ายังมีอยู่ ไม่งั้นใช้ตัวที่ตั้งเป็นใช้งานจริง
          setModel((prev) => (prev && names.includes(prev) ? prev : act && names.includes(act) ? act : names[0] ?? ""));
        }).catch(() => setModel((prev) => (prev && names.includes(prev) ? prev : names[0] ?? "")));
      })
      .catch((e) => {
        reportError("playground.models", e);
        setOllamaDown(true);
      });
    // system prompt เริ่มต้นจากตั้งค่า เฉพาะเมื่อผู้ใช้ยังไม่เคยแก้ในรอบนี้
    api.settings().then((s) => setSystem((prev) => (saved.system ? prev : s.default_system_prompt))).catch(() => {});
    // ออกจากหน้าตอนกำลังสตรีมอยู่: ยกเลิกคำขอ กันค้างเบื้องหลังและกัน setState หลังหน้าปิด
    return () => abortRef.current?.abort();
  }, []);

  // บันทึกสถานะทุกครั้งที่เปลี่ยน
  useEffect(() => {
    try {
      const data: Saved = { msgs, model, useKb, scopeOn, system, temp, input };
      data.msgs = msgs.slice(-MAX_KEEP);
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      /* เก็บไม่ได้ก็ไม่เป็นไร แค่ไม่จำข้ามหน้า */
    }
  }, [msgs, model, useKb, scopeOn, system, temp, input]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" }); // ต้องไม่ return ค่า ไม่งั้น React เรียกเป็นฟังก์ชันล้างแล้วพัง (destroy is not a function)
  }, [msgs]);

  async function send() {
    const text = input.trim();
    if (!text || !model || busy) return;
    const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((p) => [...p, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    const patchLast = (fn: (m: Msg) => Msg) => setMsgs((p) => p.map((m, i) => (i === p.length - 1 ? fn(m) : m)));
    try {
      await api.playground(
        { model, message: text, history, use_kb: useKb, system_prompt: system, temperature: temp, apply_scope: scopeOn },
        (ev) => {
          if (ev.type === "sources") patchLast((m) => ({ ...m, hits: ev.hits, mode: ev.mode, note: ev.note, guard: ev.guard ? `${ev.guard.kind}|${ev.guard.rule}` : undefined }));
          else if (ev.type === "delta") patchLast((m) => ({ ...m, content: m.content + ev.text }));
          else if (ev.type === "error") patchLast((m) => ({ ...m, content: m.content || ev.error, error: true }));
          else if (ev.type === "done") {
            const parts: string[] = [];
            if (ev.total_s) parts.push(`${Number(ev.total_s).toFixed(1)} วินาที`);
            if (ev.tokens_per_s) parts.push(`${Number(ev.tokens_per_s).toFixed(1)} token/วินาที`);
            patchLast((m) => ({ ...m, stats: parts.join(" · ") }));
          }
        },
        ctl.signal
      );
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        reportError("playground.chat", e, `model=${model}`);
        patchLast((m) => ({ ...m, content: m.content || errText(e), error: true }));
        toast(errText(e), "bad");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <Topbar title="ลองคุยกับโมเดล" subtitle="ลองถามโมเดลจริงพร้อมคลังความรู้และขอบเขตการตอบ ก่อนนำไปใช้งาน" />

      <div className="px-4 md:px-8 py-3 border-b border-base-800 flex flex-wrap items-center gap-3">
        <select value={model} onChange={(e) => setModel(e.target.value)} className="bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm min-w-0 max-w-full">
          {models.length === 0 && <option value="">ไม่พบโมเดล</option>}
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-base-300 cursor-pointer select-none">
          <input type="checkbox" checked={useKb} onChange={(e) => setUseKb(e.target.checked)} className="accent-accent-500" />
          <BookOpen size={14} /> ใช้คลังความรู้
        </label>
        <label className="flex items-center gap-2 text-sm text-base-300 cursor-pointer select-none" title="เปิด = ใช้กฎตอบตายตัวและเงื่อนไข 'ต้องมีเอกสาร' เหมือนที่ระบบอื่นเจอผ่าน API ปิด = ดูว่าโมเดลล้วนๆ ตอบอะไร">
          <input type="checkbox" checked={scopeOn} onChange={(e) => setScopeOn(e.target.checked)} className="accent-accent-500" />
          <ShieldCheck size={14} /> ใช้ขอบเขตการตอบ
        </label>
        <button onClick={() => setShowOpts((s) => !s)} className="text-xs text-base-400 hover:text-base-100 flex items-center gap-1.5">
          <SlidersHorizontal size={13} /> ตัวเลือก
        </button>
        {msgs.length > 0 && (
          <button onClick={() => { if (!busy) { setMsgs([]); try { localStorage.removeItem(SAVE_KEY); sessionStorage.removeItem(SAVE_KEY); } catch { /* ข้าม */ } } }} className="ml-auto text-xs text-base-400 hover:text-bad flex items-center gap-1.5">
            <Trash2 size={13} /> ล้างบทสนทนา
          </button>
        )}
      </div>

      {showOpts && (
        <div className="px-4 md:px-8 py-4 border-b border-base-800 bg-base-900/50 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <Field label="System prompt (คำสั่งตั้งต้นของโมเดล)">
              <TextArea rows={3} value={system} onChange={(e) => setSystem(e.target.value)} />
            </Field>
          </div>
          <Field label="temperature" hint="ต่ำ = ตอบนิ่งและตรง, สูง = หลากหลาย (งานการแพทย์แนะนำต่ำ)">
            <NumberInput value={temp} onChange={setTemp} step={0.1} min={0} max={2} />
          </Field>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-5 space-y-4">
        {ollamaDown && <Notice tone="bad">เชื่อมต่อ Ollama ไม่ได้ ตรวจว่า Ollama เปิดอยู่ และที่อยู่ตรงกับในหน้าตั้งค่า</Notice>}
        {msgs.length === 0 && !ollamaDown && (
          <Empty icon={<MessageSquare size={32} />} title="เริ่มถามได้เลย"
            hint={useKb ? "ระบบจะค้นคลังความรู้แล้วแนบให้โมเดลก่อนตอบ ใต้คำตอบจะเห็นว่าใช้ความรู้ชิ้นไหน" : "ตอนนี้ปิดคลังความรู้อยู่ โมเดลจะตอบจากที่เรียนมาอย่างเดียว"} />
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : ""}`}>
            <div className={`max-w-[92%] md:max-w-[75%] space-y-2`}>
              <div className={`rounded-xl px-4 py-3 text-sm whitespace-pre-wrap break-words ${
                m.role === "user" ? "bg-accent-500/15 text-base-100" : m.error ? "bg-bad/10 border border-bad/30 text-bad" : "bg-base-900 border border-base-800"
              }`}>
                {m.content || (busy && i === msgs.length - 1 ? <span className="text-base-500 animate-pulse">กำลังคิด...</span> : "")}
              </div>
              {m.role === "assistant" && (m.hits || m.stats) && (
                <div className="space-y-1.5">
                  {m.guard && <div className="text-[11px] text-warn">ตอบตามขอบเขตที่ตั้งไว้ ({m.guard.startsWith("red_flag") ? "เคสอันตราย" : m.guard.startsWith("blocked") ? "หัวข้อต้องห้าม" : "ไม่พบเอกสารที่เกี่ยวข้อง"}) ไม่ได้ผ่านโมเดล</div>}
                  {m.stats && <div className="text-[11px] text-base-500">{m.stats}</div>}
                  {m.mode && m.mode !== "off" && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-base-400 hover:text-base-200">
                        ใช้ความรู้ {m.hits?.length ?? 0} ชิ้น
                        {m.mode === "keyword" && " (ค้นด้วยคำ ยังไม่มีเวกเตอร์)"}
                      </summary>
                      <div className="mt-1.5 space-y-1.5">
                        {m.note && <p className="text-base-500">{m.note}</p>}
                        {m.hits?.map((h, k) => (
                          <Card key={k} className="px-3 py-2">
                            <div className="flex justify-between gap-2"><span className="text-base-200 font-medium truncate">{h.title}</span><Pill>{h.score.toFixed(2)}</Pill></div>
                            <p className="text-base-400 mt-1 line-clamp-3 whitespace-pre-wrap">{h.text}</p>
                          </Card>
                        ))}
                        {m.hits?.length === 0 && <p className="text-base-500">ไม่พบความรู้ที่เกี่ยวข้อง โมเดลตอบจากที่เรียนมา อาจคลาดเคลื่อน</p>}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(); }} className="px-4 md:px-8 py-3 border-t border-base-800 flex gap-2 items-end">
        <TextArea rows={1} value={input} onChange={(e) => setInput(e.target.value)} placeholder="พิมพ์คำถาม (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          className="max-h-40" />
        {busy ? (
          <Button type="button" variant="danger" onClick={() => abortRef.current?.abort()}><Square size={14} /> หยุด</Button>
        ) : (
          <Button type="submit" disabled={!input.trim() || !model}><Send size={14} /> ส่ง</Button>
        )}
      </form>
    </div>
  );
}
