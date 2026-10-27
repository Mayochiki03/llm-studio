// เซิร์ฟเวอร์เดโม (ไม่ต้องติดตั้งแพ็กเกจเพิ่ม ใช้ Node 18 ขึ้นไป): หน้าแชทจำลอง + ตัวกลาง LINE
// หน้าที่: ถือคีย์ API ไว้ฝั่งเซิร์ฟเวอร์ (ไม่ส่งให้เบราว์เซอร์) แล้วส่งต่อคำถามไป LLM Studio (/api/v1/ask)
// ใช้กับข้อมูลสมมติเท่านั้น ห้ามใส่ข้อมูลผู้ป่วยจริงตอนเดโมผ่านอินเทอร์เน็ต
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** อ่านไฟล์ .env แบบง่าย (KEY=VALUE) ไม่ทับค่าที่ตั้งไว้ในระบบแล้ว */
export function loadEnv(file = path.join(HERE, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const cfg = () => ({
  api: (process.env.LLM_API_URL || "http://localhost:8800").replace(/\/$/, ""),
  key: process.env.LLM_API_KEY || "",
  lineSecret: process.env.LINE_CHANNEL_SECRET || "",
  lineToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  port: Number(process.env.PORT || 3000),
});

/** ตรวจลายเซ็นจาก LINE: HMAC-SHA256 ของเนื้อหาดิบด้วย channel secret แล้ว base64 (เทียบแบบเวลาคงที่) */
export function verifyLineSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expect = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(expect);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** รหัสผู้ใช้สำหรับกันถามซ้ำ: LINE userId ถูกแฮชก่อนส่งต่อ ไม่ส่ง id จริงให้ LLM Studio */
export function clientIdFor(kind, raw) {
  return `${kind}:` + crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 16);
}

/** ถาม LLM Studio คืน {text, mode, sources, guard, retryAfter, status} ไม่โยน error (ล้มเหลว = ข้อความขออภัย) */
export async function askModel(question, clientId, fetchFn = fetch) {
  const c = cfg();
  const sorry = "ขออภัยค่ะ ระบบตอบไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้งหรือติดต่อเจ้าหน้าที่";
  try {
    const r = await fetchFn(`${c.api}/api/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ question, client_id: clientId }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 429) {
      const det = d.detail || {};
      return { text: det.message || "ถามถี่เกินไป กรุณารอสักครู่", mode: "429", sources: [], guard: null, retryAfter: det.retry_after || 0, status: 429 };
    }
    if (!r.ok) return { text: sorry, mode: "error", sources: [], guard: null, status: r.status };
    return { text: d.answer || sorry, mode: d.mode, sources: (d.sources || []).map((s) => s.title), guard: d.guard || null, status: 200 };
  } catch {
    return { text: sorry, mode: "error", sources: [], guard: null, status: 0 };
  }
}

/** จัดการเหตุการณ์จาก LINE (เฉพาะข้อความตัวอักษร) แล้วตอบกลับด้วย reply API; คืนจำนวนที่ตอบ */
export async function handleLineEvents(events, fetchFn = fetch) {
  const c = cfg();
  let n = 0;
  for (const ev of events || []) {
    if (ev.type !== "message" || ev.message?.type !== "text" || !ev.replyToken) continue;
    const res = await askModel(String(ev.message.text).slice(0, 1500), clientIdFor("line", ev.source?.userId || "anon"), fetchFn);
    await fetchFn("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.lineToken}` },
      body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: "text", text: res.text.slice(0, 4900) }] }),
    }).catch(() => {});
    n++;
  }
  return n;
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (ch) => { size += ch.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else parts.push(ch); });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

const send = (res, code, body, type = "application/json; charset=utf-8") => { res.writeHead(code, { "Content-Type": type }); res.end(body); };

export function createServer() {
  return http.createServer(async (req, res) => {
    const c = cfg();
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        return send(res, 200, fs.readFileSync(path.join(HERE, "public", "index.html")), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && req.url === "/health") return send(res, 200, JSON.stringify({ ok: true, key: !!c.key, line: !!(c.lineSecret && c.lineToken) }));
      if (req.method === "POST" && req.url === "/chat") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const q = String(body.question || "").trim().slice(0, 1500);
        if (!q) return send(res, 400, JSON.stringify({ error: "ไม่มีคำถาม" }));
        return send(res, 200, JSON.stringify(await askModel(q, clientIdFor("web", String(body.session || "anon")))));
      }
      if (req.method === "POST" && req.url === "/line/webhook") {
        const raw = await readBody(req);
        if (!verifyLineSignature(raw, req.headers["x-line-signature"], c.lineSecret)) return send(res, 401, JSON.stringify({ error: "ลายเซ็นไม่ถูกต้อง" }));
        send(res, 200, "{}");                                     // ตอบ LINE ทันที แล้วค่อยประมวลผล (LINE ไม่รอคำตอบโมเดล)
        handleLineEvents(JSON.parse(raw.toString("utf8")).events).catch(() => {});
        return;
      }
      send(res, 404, JSON.stringify({ error: "ไม่พบ" }));
    } catch (e) {
      send(res, 400, JSON.stringify({ error: String(e.message || e) }));
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const c = cfg();
  if (!c.key) console.warn("คำเตือน: ยังไม่ได้ตั้ง LLM_API_KEY ใน demo/.env");
  createServer().listen(c.port, () => console.log(`เดโมรันที่ http://localhost:${c.port}  (LINE webhook: /line/webhook)`));
}
