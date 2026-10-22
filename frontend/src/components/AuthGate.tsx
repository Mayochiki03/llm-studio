// ด่านล็อกอิน: ถ้า backend เปิดรหัสผ่านและยังไม่มีโทเคน (หรือโทเคนหมดอายุ) จะแสดงหน้ากรอกรหัสก่อนเข้าใช้งาน
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Lock, Sparkles } from "lucide-react";
import { api, setToken, getToken } from "../api/client";
import Button from "./Button";
import { TextInput, Notice } from "./ui";

export default function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "open" | "login">("checking");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    try {
      const s = await api.authStatus();
      if (!s.enabled) return setState("open");
      // เปิดล็อกอินอยู่: ลองเรียกอะไรสักอย่างที่ต้องใช้โทเคนเพื่อดูว่าโทเคนเดิมยังใช้ได้ไหม
      if (!getToken()) return setState("login");
      await api.settings();
      setState("open");
    } catch (e: any) {
      if (e?.status === 401) setState("login");
      else setState("open"); // backend ปิดอยู่ ให้เข้าหน้าหลักแล้วแถบสถานะจะบอกเอง
    }
  }, []);

  useEffect(() => {
    check();
    const h = () => {
      setToken("");
      setState("login");
    };
    window.addEventListener("auth-required", h);
    return () => window.removeEventListener("auth-required", h);
  }, [check]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await api.login(pw);
      setToken(r.token);
      setPw("");
      setState("open");
    } catch (e: any) {
      setErr(e?.message ?? "เข้าสู่ระบบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  if (state === "open") return <>{children}</>;
  if (state === "checking") return <div className="h-full flex items-center justify-center text-sm text-base-500">กำลังตรวจสอบ...</div>;

  return (
    <div className="h-full flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-base-900 border border-base-800 rounded-xl2 shadow-card p-6 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-accent-400 to-accent-500 flex items-center justify-center">
            <Sparkles size={16} className="text-base-950" />
          </div>
          <div>
            <div className="text-sm font-semibold">LLM Studio</div>
            <div className="text-[11px] text-base-400">กรอกรหัสผ่านเพื่อเข้าใช้งาน</div>
          </div>
        </div>
        <TextInput type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="รหัสผ่าน" />
        {err && <Notice tone="bad">{err}</Notice>}
        <Button type="submit" className="w-full justify-center" disabled={busy || !pw}>
          <Lock size={14} /> {busy ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"}
        </Button>
      </form>
    </div>
  );
}
