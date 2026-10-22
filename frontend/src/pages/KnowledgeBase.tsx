// คลังความรู้: เพิ่ม/แก้/ปิดใช้ความรู้ที่ Playground และระบบอื่นใช้ตอบ (RAG) พร้อมประวัติและย้อนกลับ
import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Plus, Search, Upload, Download, History, Trash2, Pencil, RefreshCw, FileText, MessageCircleQuestion, Layers, ShieldAlert, FlaskConical, Play, X } from "lucide-react";
import Topbar from "../components/Topbar";
import { Card } from "../components/Card";
import Button from "../components/Button";
import { Empty, Field, Modal, Notice, Pill, Spinner, TextArea, TextInput, Toggle, fmtDate, timeAgo } from "../components/ui";
import { toast, errText } from "../components/toast";
import { api, downloadFile, ApiError } from "../api/client";
import type { KbDoc, KbHistory, KbHit, KbStats, KbTest, KbTestRun, PiiScanKb } from "../types";

const KIND_LABEL: Record<string, string> = { text: "ข้อความ", qa: "ถาม-ตอบ", file: "ไฟล์" };

export default function KnowledgeBase() {
  const [docs, setDocs] = useState<KbDoc[] | null>(null);
  const [stats, setStats] = useState<KbStats | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [kind, setKind] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const [scan, setScan] = useState<PiiScanKb | null>(null);
  const [testing, setTesting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.kbDocs(q, cat, kind).then(setDocs).catch((e) => toast(errText(e), "bad"));
    api.kbStats().then(setStats).catch(() => {});
    api.kbCategories().then(setCats).catch(() => {});
  }, [q, cat, kind]);

  useEffect(() => {
    const t = setTimeout(load, 200); // รอผู้ใช้พิมพ์ค้นหาเสร็จก่อนค่อยโหลด
    return () => clearTimeout(t);
  }, [load]);

  async function embedNow() {
    setEmbedding(true);
    try {
      const r = await api.kbEmbed();
      if (r.error) toast(r.error, "bad");
      else toast(`สร้างเวกเตอร์เพิ่ม ${r.embedded_now} ชิ้น`);
      load();
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setEmbedding(false);
    }
  }

  async function toggle(d: KbDoc) {
    try {
      await api.kbUpdate(d.id, { enabled: !d.enabled });
      load();
    } catch (e) {
      toast(errText(e), "bad");
    }
  }

  async function remove(d: KbDoc) {
    if (!confirm(`ลบ "${d.title}" ? (ยังย้อนกลับได้จากประวัติ)`)) return;
    try {
      await api.kbDelete(d.id);
      toast("ลบแล้ว");
      load();
    } catch (e) {
      toast(errText(e), "bad");
    }
  }

  async function importFile(f: File) {
    try {
      const r = await api.kbImport(await f.text());
      if (r.error) toast(r.error, "bad");
      else toast(`นำเข้า ${r.added ?? 0} รายการ (ข้าม ${r.skipped ?? 0})`);
      load();
    } catch (e) {
      toast(errText(e), "bad");
    }
  }

  async function runScan() {
    try { setScan(await api.kbPiiScan()); } catch (e) { toast(errText(e), "bad"); }
  }

  const pending = stats ? stats.chunks - stats.embedded : 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="คลังความรู้" subtitle="ความรู้ที่โมเดลดึงไปใช้ตอบ โดยไม่ต้องเทรนใหม่" />
      <div className="p-4 md:p-8 space-y-5 max-w-6xl">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="เอกสารทั้งหมด" value={stats?.docs ?? "-"} />
          <Stat label="เปิดใช้งาน" value={stats?.enabled ?? "-"} />
          <Stat label="ชิ้นส่วนความรู้" value={stats?.chunks ?? "-"} />
          <Stat label="สร้างเวกเตอร์แล้ว" value={stats ? `${stats.embedded}/${stats.chunks}` : "-"} />
        </div>

        {pending > 0 && (
          <Notice tone="warn">
            <div>มี {pending} ชิ้นที่ยังไม่มีเวกเตอร์ ตอนนี้ระบบค้นด้วยคำ (ไม่แม่นเท่า) กดสร้างเวกเตอร์เพื่อให้ค้นตามความหมายได้</div>
            <div className="text-base-400">ต้องมีโมเดล <code>{stats?.embed_model}</code> ใน Ollama (ถ้ายังไม่มี รัน <code>ollama pull {stats?.embed_model}</code>)</div>
            <Button variant="secondary" className="text-xs py-1.5 mt-1" onClick={embedNow} disabled={embedding}>
              <RefreshCw size={13} className={embedding ? "animate-spin" : ""} /> {embedding ? "กำลังสร้าง..." : "สร้างเวกเตอร์ที่ค้าง"}
            </Button>
          </Notice>
        )}

        <div className="flex flex-col md:flex-row gap-2 md:items-center">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-500" />
            <TextInput className="pl-9" placeholder="ค้นหาชื่อหรือเนื้อหา" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select value={cat} onChange={(e) => setCat(e.target.value)} className="bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm">
            <option value="">ทุกหมวด</option>
            {cats.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm">
            <option value="">ทุกชนิด</option>
            <option value="text">ข้อความ</option>
            <option value="qa">ถาม-ตอบ</option>
            <option value="file">ไฟล์</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setAdding(true)}><Plus size={15} /> เพิ่มความรู้</Button>
          <Button variant="secondary" onClick={() => setSearching(true)}><Search size={14} /> ทดสอบการค้นหา</Button>
          <Button variant="secondary" onClick={() => setTesting(true)}><FlaskConical size={14} /> ชุดทดสอบการค้น</Button>
          <Button variant="secondary" onClick={runScan}><ShieldAlert size={14} /> ตรวจข้อมูลระบุตัวตนทั้งคลัง</Button>
          <Button variant="secondary" onClick={() => downloadFile("/kb/export", "knowledge-base.jsonl").catch((e) => toast(errText(e), "bad"))}>
            <Download size={14} /> ส่งออก
          </Button>
          <Button variant="secondary" onClick={() => importRef.current?.click()}><Upload size={14} /> นำเข้า</Button>
          <input ref={importRef} type="file" accept=".jsonl,.json,.txt" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        </div>

        {scan && (
          <Notice tone={scan.flagged.length ? "warn" : "good"}>
            <div className="flex justify-between gap-2">
              <span>{scan.flagged.length ? `ตรวจ ${scan.scanned} เอกสาร พบข้อมูลระบุตัวตน ${scan.flagged.length} เอกสาร` : `ตรวจ ${scan.scanned} เอกสาร ไม่พบข้อมูลระบุตัวตน`}</span>
              <button onClick={() => setScan(null)} title="ปิด"><X size={14} /></button>
            </div>
            {scan.flagged.map((f) => (
              <div key={f.doc_id} className="text-xs">
                <button className="text-accent-400 hover:underline" onClick={() => setEditing(f.doc_id)}>{f.title}</button>
                <span className="text-base-400"> · {Object.entries(f.by_type).map(([k, n]) => `${PII_LABEL[k] ?? k} ${n}`).join(", ")}</span>
              </div>
            ))}
          </Notice>
        )}

        <Card>
          {docs === null ? (
            <Spinner />
          ) : docs.length === 0 ? (
            <Empty
              icon={<BookOpen size={32} />}
              title={q || cat || kind ? "ไม่พบรายการที่ตรงกับตัวกรอง" : "คลังความรู้ยังว่าง"}
              hint="เพิ่มข้อความ คู่ถาม-ตอบ หรืออัปโหลดไฟล์ (txt, md, csv, pdf, docx) แล้วโมเดลจะใช้ตอบได้ทันที ไม่ต้องรอเทรน"
              action={<Button onClick={() => setAdding(true)}><Plus size={15} /> เพิ่มความรู้แรก</Button>}
            />
          ) : (
            docs.map((d) => (
              <div key={d.id} className="px-4 md:px-5 py-3.5 border-b border-base-800 last:border-0 flex items-start gap-3">
                <div className="mt-0.5 text-base-500">
                  {d.kind === "qa" ? <MessageCircleQuestion size={18} /> : <FileText size={18} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm font-medium truncate ${d.enabled ? "" : "text-base-500 line-through"}`}>{d.title}</span>
                    <Pill>{KIND_LABEL[d.kind] ?? d.kind}</Pill>
                    {d.category && <Pill tone="info">{d.category}</Pill>}
                    {d.chunks > 0 && d.embedded < d.chunks && <Pill tone="warn">ยังไม่มีเวกเตอร์</Pill>}
                  </div>
                  <p className="text-xs text-base-400 mt-1 line-clamp-2">{d.preview}</p>
                  <div className="text-[11px] text-base-500 mt-1 flex flex-wrap gap-x-3">
                    <span>{d.chunks} ชิ้น</span>
                    <span>เวอร์ชัน {d.version}</span>
                    <span>แก้ล่าสุด {timeAgo(d.updated_at)}</span>
                    {d.tags.length > 0 && <span>แท็ก: {d.tags.join(", ")}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => toggle(d)} title={d.enabled ? "ปิดไม่ให้โมเดลใช้" : "เปิดให้โมเดลใช้"}
                    className={`text-[11px] px-2 py-1 rounded-md ${d.enabled ? "bg-good/15 text-good" : "bg-base-800 text-base-400"}`}>
                    {d.enabled ? "เปิดอยู่" : "ปิดอยู่"}
                  </button>
                  <button onClick={() => setEditing(d.id)} className="p-1.5 text-base-400 hover:text-base-100" title="แก้ไข / ดูประวัติ"><Pencil size={15} /></button>
                  <button onClick={() => remove(d)} className="p-1.5 text-base-500 hover:text-bad" title="ลบ"><Trash2 size={15} /></button>
                </div>
              </div>
            ))
          )}
        </Card>
      </div>

      {adding && <AddDialog cats={cats} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {editing && <EditDialog id={editing} cats={cats} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />}
      {searching && <SearchDialog onClose={() => setSearching(false)} />}
      {testing && <TestsDialog docs={docs ?? []} onClose={() => setTesting(false)} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-base-400">{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </Card>
  );
}

const splitTags = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

const PII_LABEL: Record<string, string> = { thai_id: "เลขบัตรประชาชน", hn: "HN", phone: "เบอร์โทร", email: "อีเมล" };

/** ทำงานโดยไม่ยืนยันก่อน ถ้า backend ตอบ 409 pii ให้ถามผู้ใช้ แล้วลองใหม่แบบยืนยัน (คืน undefined ถ้าผู้ใช้ไม่ยืนยัน) */
async function withPii<T>(fn: (ack: boolean) => Promise<T>): Promise<T | undefined> {
  try {
    return await fn(false);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.detail?.code === "pii") {
      const types = Object.entries((e.detail.by_type ?? {}) as Record<string, number>).map(([k, n]) => `${PII_LABEL[k] ?? k} ${n} จุด`).join(", ");
      if (confirm(`พบข้อมูลที่ระบุตัวตนได้: ${types}\n\nข้อมูลในคลังความรู้จะถูกส่งเข้า prompt ของโมเดล ควรเอาออกก่อน\nถ้าเป็นข้อมูลสมมติและต้องการเพิ่มต่อ กด OK`)) return await fn(true);
      return undefined;
    }
    throw e;
  }
}

function embedWarn(e?: { error?: string }) {
  if (e?.error) toast(`บันทึกแล้ว แต่สร้างเวกเตอร์ไม่ได้: ${e.error}`, "bad");
}

function AddDialog({ cats, onClose, onDone }: { cats: string[]; onClose: () => void; onDone: () => void }) {
  const [tab, setTab] = useState<"text" | "qa" | "file">("text");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [qn, setQn] = useState("");
  const [an, setAn] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ file: string; ok: boolean; docs?: number; error?: string; pii?: boolean }[] | null>(null);

  const can = tab === "text" ? title.trim() && text.trim() : tab === "qa" ? qn.trim() && an.trim() : files.length > 0;

  async function save() {
    setBusy(true);
    try {
      if (tab === "text") {
        const r = await withPii((ack) => api.kbAdd({ title: title.trim(), text, category, tags: splitTags(tags), pii_ack: ack }));
        if (!r) { setBusy(false); return; }
        embedWarn(r.embed);
      } else if (tab === "qa") {
        const r = await withPii((ack) => api.kbAddQa({ question: qn, answer: an, category, tags: splitTags(tags), pii_ack: ack }));
        if (!r) { setBusy(false); return; }
        embedWarn(r.embed);
      } else {
        let r = await api.kbUpload(files, category, tags);
        // มีไฟล์ที่พบข้อมูลระบุตัวตน: ถามผู้ใช้ แล้วส่งใหม่แบบยืนยัน (ไฟล์ที่เพิ่มสำเร็จไปแล้วจะถูกข้ามโดย backend ไม่ซ้ำ)
        const piiFiles = r.files.filter((f) => f.pii).map((f) => f.file);
        if (piiFiles.length && confirm(`พบข้อมูลที่ระบุตัวตนได้ในไฟล์: ${piiFiles.join(", ")}\n\nถ้าเป็นข้อมูลสมมติและต้องการเพิ่มต่อ กด OK`)) {
          const r2 = await api.kbUpload(files.filter((f) => piiFiles.includes(f.name)), category, tags, true);
          r = { ...r2, files: [...r.files.filter((f) => !f.pii), ...r2.files] }; // รวมผลไฟล์ที่ผ่านรอบแรกกับรอบยืนยัน
        }
        embedWarn(r.embed);
        if (r.files.some((f) => !f.ok)) {
          setReport(r.files);
          setBusy(false);
          return; // มีไฟล์ที่อ่านไม่ได้ ให้ผู้ใช้เห็นก่อนปิด
        }
      }
      toast("เพิ่มแล้ว");
      onDone();
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="เพิ่มความรู้"
      onClose={onClose}
      wide
      footer={report ? <Button onClick={onDone}>ปิด</Button> : (
        <>
          <Button variant="ghost" onClick={onClose}>ยกเลิก</Button>
          <Button onClick={save} disabled={busy || !can}>{busy ? "กำลังบันทึก..." : "บันทึก"}</Button>
        </>
      )}
    >
      {report ? (
        <div className="space-y-2">
          {report.map((f) => (
            <div key={f.file} className="flex items-center justify-between text-sm">
              <span className="truncate">{f.file}</span>
              {f.ok ? <Pill tone="good">เพิ่ม {f.docs} รายการ</Pill> : <Pill tone="bad">{f.error}</Pill>}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="flex gap-1 bg-base-850 rounded-lg p-1 w-fit">
            {([["text", "ข้อความ"], ["qa", "คำถาม-คำตอบ"], ["file", "อัปโหลดไฟล์"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-md text-xs ${tab === k ? "bg-base-700 text-base-100" : "text-base-400"}`}>{l}</button>
            ))}
          </div>
          {tab === "text" && (
            <>
              <Field label="ชื่อเรื่อง"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น ขั้นตอนส่งต่อผู้ป่วยสารเสพติด" /></Field>
              <Field label="เนื้อหา" hint="ระบบจะตัดเป็นชิ้นเล็กๆ ให้เอง ยิ่งเขียนเป็นย่อหน้าสั้นๆ ชัดเจน ยิ่งค้นเจอแม่น">
                <TextArea rows={9} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
            </>
          )}
          {tab === "qa" && (
            <>
              <Field label="คำถาม"><TextInput value={qn} onChange={(e) => setQn(e.target.value)} /></Field>
              <Field label="คำตอบ" hint="คู่ถาม-ตอบยังใช้สร้างชุดข้อมูลเทรนได้ในหน้า 'ชุดข้อมูลเทรน'">
                <TextArea rows={6} value={an} onChange={(e) => setAn(e.target.value)} />
              </Field>
            </>
          )}
          {tab === "file" && (
            <Field label="ไฟล์" hint="รองรับ txt, md, csv (คอลัมน์ question/answer จะเป็นคู่ถาม-ตอบ), pdf, docx ขนาดไม่เกิน 25 MB ต่อไฟล์">
              <input type="file" multiple accept=".txt,.md,.csv,.pdf,.docx" onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                className="block w-full text-sm text-base-300 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-base-800 file:text-base-100" />
            </Field>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="หมวด (ไม่บังคับ)">
              <TextInput list="kb-cats" value={category} onChange={(e) => setCategory(e.target.value)} />
              <datalist id="kb-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
            </Field>
            <Field label="แท็ก (คั่นด้วยจุลภาค)"><TextInput value={tags} onChange={(e) => setTags(e.target.value)} placeholder="สารเสพติด, ส่งต่อ" /></Field>
          </div>
        </>
      )}
    </Modal>
  );
}

function EditDialog({ id, cats, onClose, onDone }: { id: string; cats: string[]; onClose: () => void; onDone: () => void }) {
  const [doc, setDoc] = useState<KbDoc | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [hist, setHist] = useState<KbHistory[]>([]);
  const [chunks, setChunks] = useState<{ count: number; chunks: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const fill = (d: KbDoc) => {
    setDoc(d);
    setTitle(d.title);
    setText(d.raw_text ?? "");
    setCategory(d.category);
    setTags(d.tags.join(", "));
    setEnabled(!!d.enabled);
  };

  useEffect(() => {
    api.kbDoc(id).then(fill).catch((e) => toast(errText(e), "bad"));
    api.kbHistory(id).then(setHist).catch(() => {});
  }, [id]);

  async function save() {
    setBusy(true);
    try {
      const r = await withPii((ack) => api.kbUpdate(id, { title, text, category, tags: splitTags(tags), enabled, pii_ack: ack }));
      if (!r) { setBusy(false); return; }
      embedWarn(r.embed);
      toast("บันทึกแล้ว");
      onDone();
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function restore(h: KbHistory) {
    if (!confirm(`ย้อนกลับไปเวอร์ชัน ${h.version} (${fmtDate(h.ts)}) ?`)) return;
    try {
      const r = await api.kbRestore(id, h.id);
      fill(r.doc);
      api.kbHistory(id).then(setHist);
      toast("ย้อนกลับแล้ว");
    } catch (e) {
      toast(errText(e), "bad");
    }
  }

  return (
    <Modal
      title="แก้ไขความรู้"
      onClose={onClose}
      wide
      footer={<><Button variant="ghost" onClick={onClose}>ยกเลิก</Button><Button onClick={save} disabled={busy || !doc}>{busy ? "กำลังบันทึก..." : "บันทึก"}</Button></>}
    >
      {!doc ? <Spinner /> : (
        <>
          <Field label="ชื่อเรื่อง"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="เนื้อหา"><TextArea rows={10} value={text} onChange={(e) => { setText(e.target.value); setChunks(null); }} /></Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="หมวด">
              <TextInput list="kb-cats2" value={category} onChange={(e) => setCategory(e.target.value)} />
              <datalist id="kb-cats2">{cats.map((c) => <option key={c} value={c} />)}</datalist>
            </Field>
            <Field label="แท็ก"><TextInput value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} label="เปิดให้โมเดลใช้ความรู้นี้" />
          <div>
            <Button variant="secondary" className="text-xs py-1.5" onClick={() => api.kbPreviewChunks(text).then(setChunks).catch((e) => toast(errText(e), "bad"))}>
              <Layers size={13} /> ดูว่าจะถูกตัดเป็นกี่ชิ้น
            </Button>
            {chunks && (
              <div className="mt-2 space-y-1.5">
                <p className="text-xs text-base-400">ตัดได้ {chunks.count} ชิ้น (แสดงไม่เกิน 50)</p>
                {chunks.chunks.slice(0, 6).map((c, i) => (
                  <div key={i} className="text-xs bg-base-950 border border-base-800 rounded-lg px-3 py-2 text-base-300 whitespace-pre-wrap">{c}</div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2 text-xs text-base-400 mb-2"><History size={13} /> ประวัติการแก้ไข</div>
            {hist.length === 0 ? <p className="text-xs text-base-500">ยังไม่มีประวัติ</p> : (
              <div className="divide-y divide-base-800 border border-base-800 rounded-lg">
                {hist.slice(0, 10).map((h) => (
                  <div key={h.id} className="flex items-center justify-between px-3 py-2 text-xs">
                    <span className="text-base-300">เวอร์ชัน {h.version} · {h.action} · {fmtDate(h.ts)}</span>
                    <button className="text-accent-400 hover:underline" onClick={() => restore(h)}>ย้อนกลับมาที่นี่</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [res, setRes] = useState<{ mode: string; note?: string; hits: KbHit[] } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!query.trim()) return;
    setBusy(true);
    try {
      setRes(await api.kbSearch(query));
    } catch (e) {
      toast(errText(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="ทดสอบการค้นหา" onClose={onClose} wide>
      <p className="text-xs text-base-400">พิมพ์คำถามอย่างที่ผู้ใช้จะถาม เพื่อดูว่าระบบดึงความรู้ชิ้นไหนมาให้โมเดล</p>
      <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex gap-2">
        <TextInput autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="เช่น ผู้ป่วยหยุดยาเองต้องทำอย่างไร" />
        <Button type="submit" disabled={busy}><Search size={14} /> ค้นหา</Button>
      </form>
      {res && (
        <div className="space-y-2">
          <div className="flex gap-2 items-center">
            <Pill tone={res.mode === "vector" || res.mode === "hybrid" ? "good" : "warn"}>
              {res.mode === "keyword" ? "ค้นด้วยคำ" : res.mode === "none" ? "ไม่มีข้อมูล" : "ค้นตามความหมาย"}
            </Pill>
            {res.note && <span className="text-xs text-base-400">{res.note}</span>}
          </div>
          {res.hits.length === 0 && <p className="text-sm text-base-500">ไม่พบความรู้ที่เกี่ยวข้อง (คะแนนต่ำกว่าเกณฑ์ที่ตั้งไว้)</p>}
          {res.hits.map((h, i) => (
            <div key={i} className="border border-base-800 rounded-lg px-3 py-2.5">
              <div className="flex justify-between text-xs mb-1"><span className="font-medium text-base-100">{h.title}</span><span className="text-base-400">คะแนน {h.score.toFixed(2)}</span></div>
              <p className="text-xs text-base-300 whitespace-pre-wrap">{h.text}</p>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}


/** ชุดทดสอบการค้น: ตั้งคำถาม + เอกสารที่ควรถูกดึงมา แล้วกดรันเพื่อวัดความแม่น (hit rate / MRR) ใช้เทียบก่อน-หลังปรับตั้งค่าหรือเพิ่มความรู้ */
function TestsDialog({ docs, onClose }: { docs: KbDoc[]; onClose: () => void }) {
  const [tests, setTests] = useState<KbTest[]>([]);
  const [question, setQuestion] = useState("");
  const [docId, setDocId] = useState("");
  const [run, setRun] = useState<KbTestRun | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.kbTests().then((r) => setTests(Array.isArray(r) ? r : [])).catch((e) => toast(errText(e), "bad")), []);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!question.trim() || !docId) return toast("พิมพ์คำถามและเลือกเอกสารที่ควรถูกดึงมา", "bad");
    try { await api.kbTestAdd(question, [docId]); setQuestion(""); load(); } catch (e) { toast(errText(e), "bad"); }
  }

  async function runAll() {
    setBusy(true);
    try { setRun(await api.kbTestRun()); } catch (e) { toast(errText(e), "bad"); } finally { setBusy(false); }
  }

  return (
    <Modal title="ชุดทดสอบการค้น" onClose={onClose} wide>
      <p className="text-xs text-base-400">ใส่คำถามที่ผู้ใช้จะถาม พร้อมเอกสารที่ “ควรถูกดึงมา” แล้วกดรัน ระบบบอกว่าเจอกี่ข้อ และเจออยู่อันดับที่เท่าไหร่ ใช้เทียบก่อน/หลังเพิ่มความรู้หรือปรับค่า</p>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2">
        <TextInput placeholder="คำถาม" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <select value={docId} onChange={(e) => setDocId(e.target.value)} className="bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm min-w-0">
          <option value="">เอกสารที่ควรเจอ...</option>
          {docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
        </select>
        <Button onClick={add}><Plus size={14} /> เพิ่ม</Button>
      </div>

      <div className="border border-base-800 rounded-lg divide-y divide-base-800">
        {tests.length === 0 ? <div className="px-4 py-6 text-sm text-base-500 text-center">ยังไม่มีข้อสอบ</div> : tests.map((t) => {
          const r = run?.results.find((x) => x.id === t.id);
          return (
            <div key={t.id} className="px-4 py-2.5 flex items-start gap-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="break-words">{t.question}</div>
                <div className="text-[11px] text-base-500">ควรเจอ: {t.expect_titles.join(", ")}</div>
              </div>
              {r && (r.hit ? <Pill tone="good">เจอ อันดับ {r.rank}</Pill> : <Pill tone="bad">ไม่เจอ</Pill>)}
              <button className="p-1 text-base-500 hover:text-bad" title="ลบ" onClick={() => api.kbTestDelete(t.id).then(load).catch((e) => toast(errText(e), "bad"))}><Trash2 size={14} /></button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Button onClick={runAll} disabled={busy || tests.length === 0}><Play size={14} /> {busy ? "กำลังรัน..." : "รันทั้งหมด"}</Button>
        {run && run.total > 0 && (
          <span className="text-sm text-base-300">
            เจอ {run.hits}/{run.total} ({Math.round((run.hit_rate ?? 0) * 100)}%) · MRR {run.mrr} · โหมด {run.mode === "keyword" ? "ค้นด้วยคำ" : "ค้นตามความหมาย"}
          </span>
        )}
      </div>
    </Modal>
  );
}
