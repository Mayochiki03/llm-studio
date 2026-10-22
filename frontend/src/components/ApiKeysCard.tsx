// จัดการคีย์ API สำหรับระบบอื่นในโรงพยาบาลที่จะเรียกใช้โมเดล/คลังความรู้ผ่าน /api/v1/*
// คีย์เต็มแสดงครั้งเดียวตอนสร้าง (ระบบเก็บเฉพาะค่าแฮช)
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Trash2, Copy } from "lucide-react";
import { Card, CardHeader } from "./Card";
import Button from "./Button";
import { Notice, TextInput, fmtDate } from "./ui";
import { toast, errText } from "./toast";
import { api } from "../api/client";
import type { ApiKey } from "../types";

export default function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.apiKeys().then((r) => setKeys(Array.isArray(r) ? r : [])).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!name.trim()) return toast("ตั้งชื่อคีย์ก่อน เช่น ระบบ-ติดตามผู้ป่วย", "bad");
    setBusy(true);
    try {
      const r = await api.apiKeyCreate(name.trim());
      setFresh({ name: r.name, key: r.key });
      setName("");
      load();
    } catch (e) { toast(errText(e), "bad"); } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader title="คีย์ API สำหรับระบบอื่น" subtitle="ให้ระบบอื่นในเครือข่ายเรียกโมเดลที่ใช้งานอยู่ได้ (จำกัด 60 ครั้ง/นาทีต่อคีย์) ข้อมูลไม่ออกนอกเครื่อง" />
      <div className="px-5 pb-5 space-y-4">
        <div className="flex gap-2">
          <TextInput placeholder="ชื่อคีย์ เช่น ระบบ-ติดตามผู้ป่วย" value={name} onChange={(e) => setName(e.target.value)} />
          <Button onClick={create} disabled={busy}><Plus size={14} /> สร้าง</Button>
        </div>

        {fresh && (
          <Notice tone="warn">
            <div className="space-y-2">
              <div>คีย์ของ “{fresh.name}” (แสดงครั้งเดียว เก็บไว้เดี๋ยวนี้):</div>
              <code className="block bg-base-950 border border-base-800 rounded px-2 py-1.5 text-xs break-all">{fresh.key}</code>
              <button className="text-xs text-accent-400 inline-flex items-center gap-1" onClick={() => navigator.clipboard?.writeText(fresh.key).then(() => toast("คัดลอกแล้ว"))}><Copy size={12} /> คัดลอก</button>
              <button className="text-xs text-base-400 ml-3" onClick={() => setFresh(null)}>ปิด</button>
            </div>
          </Notice>
        )}

        <div className="border border-base-800 rounded-lg">
          {keys.length === 0 ? <div className="px-4 py-6 text-sm text-base-500 text-center">ยังไม่มีคีย์</div> :
            keys.map((k) => (
              <div key={k.id} className="px-4 py-3 border-b border-base-800 last:border-0 flex items-center gap-3">
                <KeyRound size={15} className="text-base-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{k.name} <code className="text-[11px] text-base-500">{k.prefix}…</code></div>
                  <div className="text-[11px] text-base-500">ใช้ {k.use_count} ครั้ง · ล่าสุด {k.last_used_at ? fmtDate(k.last_used_at) : "ยังไม่เคยใช้"}</div>
                </div>
                <label className="text-xs text-base-400 flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={!!k.enabled} onChange={(e) => api.apiKeyEnable(k.id, e.target.checked).then(setKeys).catch((er) => toast(errText(er), "bad"))} /> เปิด
                </label>
                <button className="p-1.5 text-base-500 hover:text-bad" title="ลบ" onClick={() => confirm(`ลบคีย์ “${k.name}”? ระบบที่ใช้คีย์นี้จะเรียกไม่ได้ทันที`) && api.apiKeyDelete(k.id).then(load).catch((er) => toast(errText(er), "bad"))}><Trash2 size={14} /></button>
              </div>
            ))}
        </div>

        <details className="text-xs text-base-400">
          <summary className="cursor-pointer">ตัวอย่างการเรียกใช้</summary>
          <pre className="mt-2 bg-base-950 border border-base-800 rounded-lg p-3 overflow-x-auto text-[11px] text-base-300">{`curl -X POST http://<IP-เซิร์ฟเวอร์>:8000/api/v1/ask \\
  -H "Authorization: Bearer sk-llmstudio-..." \\
  -H "Content-Type: application/json" \\
  -d '{"question":"คำถาม","use_kb":true}'`}</pre>
          <p className="mt-1">อื่นๆ: GET /api/v1/health · GET /api/v1/model · POST /api/v1/search</p>
        </details>
      </div>
    </Card>
  );
}
