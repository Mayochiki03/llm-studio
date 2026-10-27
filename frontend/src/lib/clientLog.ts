// รายงาน error ของหน้าเว็บไปเก็บที่ backend (studio_data/logs/client.log) เพื่อไล่หาสาเหตุอาการ "หน้าจอว่าง"
// ไม่ส่งข้อมูลที่ผู้ใช้พิมพ์หรือเนื้อหาคำตอบ ส่งเฉพาะข้อความ error, stack, หน้าที่เปิดอยู่ และขนาดจอ

export const APP_UI_VERSION = "0.8.5";

interface Entry {
  kind: string;
  message: string;
  stack: string;
  page: string;
  at: string;
}

// เก็บ error ล่าสุดไว้ในหน่วยความจำ ให้ปุ่ม "คัดลอกข้อมูลวินิจฉัย" แนบไปด้วยได้
const recent: Entry[] = [];
const lastSent = new Map<string, number>();

export function recentErrors(): Entry[] {
  return recent.slice();
}

function describe(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack ?? "" };
  try {
    return { message: typeof err === "string" ? err : JSON.stringify(err), stack: "" };
  } catch {
    return { message: String(err), stack: "" };
  }
}

/** ส่งรายงาน (ไม่เคย throw ไม่ว่ากรณีใด; error เดียวกันไม่ส่งซ้ำภายใน 5 วินาที) */
export function reportError(kind: string, err: unknown, extra = ""): void {
  try {
    const { message, stack } = describe(err);
    const entry: Entry = { kind, message: (message + (extra ? ` | ${extra}` : "")).slice(0, 1500), stack: stack.slice(0, 1500), page: location.pathname, at: new Date().toISOString() };
    recent.push(entry);
    if (recent.length > 30) recent.shift();

    const key = `${kind}:${entry.message}`;
    const now = Date.now();
    if (now - (lastSent.get(key) ?? 0) < 5000) return;
    lastSent.set(key, now);

    void fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        kind,
        message: entry.message,
        stack: entry.stack,
        page: entry.page,
        ua: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        version: APP_UI_VERSION,
      }),
    }).catch(() => {
      /* backend ติดต่อไม่ได้ก็ไม่เป็นไร error ยังอยู่ใน recent */
    });
  } catch {
    /* ห้ามให้ตัวรายงานเองทำให้เกิด error ซ้อน */
  }
}

/** ติดตั้งตัวดักจับ error ทั้งหน้า (เรียกครั้งเดียวตอนเริ่มแอป) */
export function installGlobalHandlers(): void {
  window.addEventListener("error", (e) => reportError("window.error", e.error ?? e.message, `${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => reportError("unhandledrejection", e.reason));
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    orig.apply(console, args);
    // React/ไลบรารีเขียน error ผ่าน console.error: เก็บเฉพาะที่เป็น Error หรือข้อความที่ขึ้นต้นเตือนสำคัญ ไม่เอา warning ทั่วไป
    const first = args.find((a) => a instanceof Error);
    if (first) reportError("console.error", first);
    else if (typeof args[0] === "string" && /^(Uncaught|The above error|Minified React error)/.test(args[0])) reportError("console.error", args[0]);
  };
}
