// หน้าระบบ: สถานะเครื่อง (GPU/RAM/ดิสก์), ล้างพื้นที่, สำรอง/กู้คืน, คำแนะนำตั้งค่า Ollama, บันทึกการใช้งาน (audit)
import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, HardDrive, MemoryStick, Trash2, Download, Upload, DatabaseBackup, Eraser, Copy, ScrollText, Gauge, RefreshCw, Stethoscope } from "lucide-react";
import Topbar from "../components/Topbar";
import { Card, CardHeader } from "../components/Card";
import Button from "../components/Button";
import { Meter, Notice, Pill, Spinner, fmtDate } from "../components/ui";
import { toast, errText } from "../components/toast";
import { api, downloadFile } from "../api/client";
import { recentErrors } from "../lib/clientLog";
import type { AuditRow, BackupInfo, DiskInfo, Hardware, TuningRec } from "../types";

export default function System() {
  const [hw, setHw] = useState<Hardware | null>(null);
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [tuning, setTuning] = useState<TuningRec[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [busy, setBusy] = useState("");
  const upRef = useRef<HTMLInputElement>(null);
  // บันทึกการทำงาน (log) ของระบบ: backend = ฝั่งเซิร์ฟเวอร์, client = error จากหน้าเว็บ (เช่น หน้าจอว่าง)
  const [logTab, setLogTab] = useState<"backend" | "client">("backend");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logBusy, setLogBusy] = useState(false);

  const loadLog = useCallback((name: "backend" | "client") => {
    setLogBusy(true);
    api.logs(name, 300).then((r) => setLogLines(Array.isArray(r.lines) ? r.lines : [])).catch((e) => toast(errText(e), "bad")).finally(() => setLogBusy(false));
  }, []);
  useEffect(() => { loadLog(logTab); }, [logTab, loadLog]);

  // รวมข้อมูลวินิจฉัย (ไม่มีรหัสผ่าน/คีย์) ใส่คลิปบอร์ด เพื่อส่งให้ผู้พัฒนาตอนมีปัญหา
  async function copyDiag() {
    try {
      const d = await api.diagnostics();
      const text = JSON.stringify({ ...d, browser_recent_errors: recentErrors(), ua: navigator.userAgent, viewport: `${window.innerWidth}x${window.innerHeight}` }, null, 2);
      await navigator.clipboard.writeText(text);
      toast("คัดลอกข้อมูลวินิจฉัยแล้ว วางส่งได้เลย");
    } catch (e) { toast(errText(e), "bad"); }
  }

  const loadHw = useCallback(() => api.hardware().then(setHw).catch(() => {}), []);
  const loadDisk = useCallback(() => api.disk().then(setDisk).catch((e) => toast(errText(e), "bad")), []);
  const loadBackups = useCallback(() => api.backups().then(setBackups).catch(() => {}), []);

  useEffect(() => {
    loadHw(); loadDisk(); loadBackups();
    api.ollamaTuning().then(setTuning).catch(() => {});
    api.audit(100).then(setAudit).catch(() => {});
    const t = setInterval(loadHw, 5000); // GPU เปลี่ยนเร็ว อัปเดตทุก 5 วินาที
    return () => clearInterval(t);
  }, [loadHw, loadDisk, loadBackups]);

  async function act(key: string, fn: () => Promise<unknown>, ok: string, after?: () => void) {
    setBusy(key);
    try { await fn(); toast(ok); after?.(); } catch (e) { toast(errText(e), "bad"); } finally { setBusy(""); }
  }

  const gpu = hw?.gpu;

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="เครื่องและพื้นที่" subtitle="ดูสถานะเครื่อง ล้างพื้นที่ สำรองข้อมูล" />
      <div className="p-4 md:p-8 max-w-5xl space-y-6">
        {/* ---------- สถานะเครื่อง ---------- */}
        {!hw ? <Spinner /> : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="p-5 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium"><Cpu size={16} className="text-accent-400" /> การ์ดจอ</div>
              {gpu ? (
                <>
                  <div className="text-xs text-base-300 break-words">{gpu.name}</div>
                  <Meter pct={(gpu.vram_used_gb / gpu.vram_total_gb) * 100} />
                  <div className="text-xs text-base-400">VRAM ใช้ {gpu.vram_used_gb} / {gpu.vram_total_gb} GB (ว่าง {gpu.vram_free_gb})</div>
                  <div className="text-[11px] text-base-500">{gpu.temp_c != null && `${gpu.temp_c}°C`} {gpu.util_pct != null && `· โหลด ${gpu.util_pct}%`}</div>
                </>
              ) : <Notice tone="warn">ไม่พบการ์ด NVIDIA (หรือ nvidia-smi ใช้ไม่ได้) เทรนไม่ได้จนกว่าจะพบ</Notice>}
            </Card>
            <Card className="p-5 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium"><MemoryStick size={16} className="text-accent-400" /> หน่วยความจำ (RAM)</div>
              {hw.ram.total_gb ? (
                <>
                  <Meter pct={((hw.ram.total_gb - hw.ram.available_gb) / hw.ram.total_gb) * 100} />
                  <div className="text-xs text-base-400">ว่าง {hw.ram.available_gb} / {hw.ram.total_gb} GB</div>
                </>
              ) : <div className="text-xs text-base-500">อ่านค่าไม่ได้ (ติดตั้ง psutil เพื่อดู)</div>}
              <div className="text-[11px] text-base-500">CPU {hw.cpu.threads} เธรด · {hw.os}</div>
            </Card>
            <Card className="p-5 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium"><HardDrive size={16} className="text-accent-400" /> ดิสก์โปรเจกต์</div>
              <Meter pct={hw.disk.total_gb ? ((hw.disk.total_gb - hw.disk.free_gb) / hw.disk.total_gb) * 100 : 0} />
              <div className="text-xs text-base-400">ว่าง {hw.disk.free_gb} / {hw.disk.total_gb} GB</div>
              <div className="flex items-center gap-2 text-[11px]">
                Ollama: {hw.ollama_up ? <Pill tone="good">ทำงานอยู่</Pill> : <Pill tone="bad">ติดต่อไม่ได้</Pill>}
              </div>
              {hw.ollama_running && hw.ollama_running.length > 0 && (
                <div className="text-[11px] text-base-500">ถือ VRAM: {hw.ollama_running.map((m) => `${m.name} (${m.size_gb} GB)`).join(", ")}</div>
              )}
            </Card>
          </div>
        )}

        {/* ---------- ดิสก์ ---------- */}
        <Card>
          <CardHeader title="พื้นที่ที่ถูกใช้" subtitle="ลบเฉพาะสิ่งที่ไม่จำเป็นแล้ว ระบบไม่ให้ลบข้อมูลระบบหรือของงานที่กำลังรัน"
            action={<Button variant="secondary" className="text-xs py-1.5" disabled={busy === "cs"}
              onClick={() => act("cs", async () => { const r = await api.cleanupScripts(); toast(`ลบสคริปต์ชั่วคราว ${r.removed} ไฟล์`); }, "เรียบร้อย")}><Eraser size={13} /> ล้างสคริปต์ชั่วคราว</Button>} />
          <div className="border-t border-base-800">
            {!disk ? <Spinner /> : disk.breakdown.items.length === 0 ? <div className="px-5 py-8 text-sm text-base-500 text-center">ยังไม่มีไฟล์ของโปรเจกต์</div> :
              disk.breakdown.items.map((i) => (
                <div key={i.name} className="flex items-center gap-3 px-5 py-3 border-b border-base-800 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{i.label}</div>
                    <div className="text-[11px] text-base-500 font-mono-log truncate">{i.name}</div>
                  </div>
                  <div className="text-sm text-base-300 shrink-0 w-20 text-right">{i.size_gb} GB</div>
                  {i.deletable ? (
                    <button className="p-1.5 text-base-500 hover:text-bad" title="ลบ" disabled={!!busy}
                      onClick={() => confirm(`ลบ "${i.label}" (${i.size_gb} GB) ถาวร?`) && act("del" + i.name, () => api.diskDelete(i.name), "ลบแล้ว", loadDisk)}><Trash2 size={15} /></button>
                  ) : <span className="w-8" />}
                </div>
              ))}
          </div>
        </Card>

        {/* ---------- สำรอง ---------- */}
        <Card>
          <CardHeader title="สำรองและกู้คืน" subtitle="สำรองคลังความรู้ ทะเบียนโมเดล ชุดข้อมูล และตั้งค่า (ไม่รวมไฟล์โมเดลขนาดใหญ่)"
            action={
              <div className="flex gap-2">
                <Button variant="secondary" className="text-xs py-1.5" onClick={() => upRef.current?.click()}><Upload size={13} /> กู้จากไฟล์</Button>
                <Button className="text-xs py-1.5" disabled={busy === "bk"} onClick={() => act("bk", api.backupCreate, "สำรองแล้ว", loadBackups)}><DatabaseBackup size={13} /> สำรองตอนนี้</Button>
              </div>} />
          <input ref={upRef} type="file" accept=".zip" hidden onChange={(e) => {
            const f = e.target.files?.[0]; e.target.value = "";
            if (f && confirm("กู้คืนจากไฟล์นี้? ระบบจะสำรองสถานะปัจจุบันไว้ให้ก่อนอัตโนมัติ")) act("up", () => api.backupRestoreUpload(f), "กู้คืนแล้ว โหลดหน้าใหม่เพื่อดูข้อมูล", loadBackups);
          }} />
          <div className="border-t border-base-800">
            {backups.length === 0 ? <div className="px-5 py-8 text-sm text-base-500 text-center">ยังไม่มีไฟล์สำรอง แนะนำให้สำรองก่อนอัปเดตหรือก่อนเปิดใช้โมเดลใหม่</div> :
              backups.map((b) => (
                <div key={b.name} className="flex items-center gap-3 px-5 py-3 border-b border-base-800 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{b.name}</div>
                    <div className="text-[11px] text-base-500">{b.size_mb} MB · {fmtDate(b.created_at)}</div>
                  </div>
                  <button className="p-1.5 text-base-400 hover:text-base-100" title="ดาวน์โหลด" onClick={() => downloadFile(`/system/backups/${encodeURIComponent(b.name)}`, b.name).catch((e) => toast(errText(e), "bad"))}><Download size={15} /></button>
                  <Button variant="ghost" className="text-xs py-1.5" disabled={!!busy}
                    onClick={() => confirm("กู้คืนจากไฟล์นี้? ระบบจะสำรองสถานะปัจจุบันไว้ให้ก่อน") && act("rs" + b.name, () => api.backupRestore(b.name), "กู้คืนแล้ว", () => { loadBackups(); loadDisk(); })}>กู้คืน</Button>
                </div>
              ))}
          </div>
        </Card>

        {/* ---------- Ollama ---------- */}
        <Card>
          <CardHeader title="คำแนะนำตั้งค่า Ollama" subtitle="ตัวแปรที่ช่วยให้เร็วขึ้น/ประหยัด VRAM ตามการ์ดจอของเครื่องนี้" />
          <div className="border-t border-base-800">
            {tuning.map((t) => (
              <div key={t.key} className="px-5 py-3 border-b border-base-800 last:border-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-xs bg-base-950 border border-base-800 rounded px-2 py-1">{t.key}={t.value}</code>
                  <button className="text-base-500 hover:text-base-100" title="คัดลอก" onClick={() => navigator.clipboard?.writeText(`${t.key}=${t.value}`).then(() => toast("คัดลอกแล้ว"))}><Copy size={13} /></button>
                </div>
                <p className="text-xs text-base-400 mt-1">{t.why}</p>
              </div>
            ))}
            {tuning[0] && <div className="px-5 py-3 text-[11px] text-base-500 flex gap-2"><Gauge size={13} className="shrink-0 mt-0.5" /> {tuning[0].how}</div>}
          </div>
        </Card>

        {/* ---------- log ---------- */}
        <Card>
          <CardHeader title="บันทึกการทำงาน (log)" subtitle="ไว้ไล่หาสาเหตุเมื่อหน้าจอว่างหรือระบบทำงานผิดปกติ ไม่มีรหัสผ่านและเนื้อหาข้อมูลผู้ป่วย"
            action={<Button variant="ghost" className="text-xs py-1.5" onClick={copyDiag}><Stethoscope size={13} /> คัดลอกข้อมูลวินิจฉัย</Button>} />
          <div className="border-t border-base-800 px-5 py-3 flex items-center gap-2 flex-wrap">
            {(["backend", "client"] as const).map((n) => (
              <button key={n} onClick={() => setLogTab(n)}
                className={`text-xs px-3 py-1.5 rounded-lg border ${logTab === n ? "border-accent-400 text-accent-400" : "border-base-800 text-base-400 hover:text-base-100"}`}>
                {n === "backend" ? "ฝั่งเซิร์ฟเวอร์" : "ฝั่งหน้าเว็บ"}
              </button>
            ))}
            <div className="flex-1" />
            <button className="p-1.5 text-base-400 hover:text-base-100" title="โหลดใหม่" onClick={() => loadLog(logTab)}><RefreshCw size={14} className={logBusy ? "animate-spin" : ""} /></button>
            <button className="p-1.5 text-base-400 hover:text-base-100" title="คัดลอก" onClick={() => navigator.clipboard?.writeText(logLines.join("\n")).then(() => toast("คัดลอกแล้ว"))}><Copy size={14} /></button>
            <button className="p-1.5 text-base-400 hover:text-base-100" title="ดาวน์โหลด" onClick={() => downloadFile(`/system/logs/${logTab}/download`, `${logTab}.log`).catch((e) => toast(errText(e), "bad"))}><Download size={14} /></button>
          </div>
          <pre className="border-t border-base-800 max-h-80 overflow-auto px-5 py-3 text-[11px] leading-relaxed text-base-300 whitespace-pre-wrap break-words">
            {logLines.length ? logLines.join("\n") : "ยังไม่มีบันทึก"}
          </pre>
        </Card>

        {/* ---------- audit ---------- */}
        <Card>
          <CardHeader title="บันทึกการใช้งาน" subtitle="ใครทำอะไรเมื่อไหร่ (100 รายการล่าสุด) ใช้ตรวจย้อนหลังได้" />
          <div className="border-t border-base-800 max-h-80 overflow-y-auto">
            {audit.length === 0 ? <div className="px-5 py-8 text-sm text-base-500 text-center flex items-center justify-center gap-2"><ScrollText size={16} /> ยังไม่มีบันทึก</div> :
              audit.map((a) => (
                <div key={a.id} className="px-5 py-2 border-b border-base-800 last:border-0 text-xs flex justify-between gap-3">
                  <span className="text-base-300 min-w-0 break-words"><b className="text-base-100">{a.action}</b> {a.target} <span className="text-base-500">{a.detail}</span></span>
                  <span className="text-base-500 shrink-0">{fmtDate(a.ts)}</span>
                </div>
              ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
