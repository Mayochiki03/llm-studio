// ทดสอบเดโม: node --test demo/test.mjs   (ใช้ตัว mock แทน LLM Studio และ LINE ไม่ยิงเครือข่ายจริง)
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyLineSignature, clientIdFor, askModel, handleLineEvents } from "./server.mjs";

process.env.LLM_API_KEY = "sk-test";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "tok";

test("ลายเซ็น LINE ถูกต้อง/ผิด/ว่าง", () => {
  const body = Buffer.from('{"events":[]}');
  const sig = crypto.createHmac("sha256", "secret").update(body).digest("base64");
  assert.equal(verifyLineSignature(body, sig, "secret"), true);
  assert.equal(verifyLineSignature(body, sig, "other"), false);
  assert.equal(verifyLineSignature(body, "", "secret"), false);
  assert.equal(verifyLineSignature(body, sig, ""), false);
});

test("รหัสผู้ใช้เป็นแฮช ไม่เก็บ userId จริง", () => {
  const id = clientIdFor("line", "U1234567890");
  assert.match(id, /^line:[0-9a-f]{16}$/);
  assert.ok(!id.includes("U1234567890"));
  assert.equal(id, clientIdFor("line", "U1234567890"));
});

const okFetch = (answer, status = 200, extra = {}) => async () => ({ ok: status < 400, status, json: async () => ({ answer, mode: "hybrid", sources: [{ title: "เวลาทำการ" }], ...extra }) });

test("askModel: ปกติ / 429 / ผิดพลาด", async () => {
  const a = await askModel("q", "web:x", okFetch("เปิด 08.00"));
  assert.equal(a.text, "เปิด 08.00"); assert.deepEqual(a.sources, ["เวลาทำการ"]);
  const b = await askModel("q", "web:x", async () => ({ ok: false, status: 429, json: async () => ({ detail: { message: "พัก", retry_after: 60 } }) }));
  assert.equal(b.status, 429); assert.equal(b.retryAfter, 60);
  const c = await askModel("q", "web:x", async () => { throw new Error("down"); });
  assert.equal(c.mode, "error"); assert.match(c.text, /ขออภัย/);
});

test("LINE: ตอบเฉพาะข้อความตัวอักษรที่มี replyToken และตัดความยาว", async () => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return url.includes("/api/v1/ask") ? okFetch("ก".repeat(6000))() : { ok: true, status: 200, json: async () => ({}) };
  };
  const n = await handleLineEvents([
    { type: "message", message: { type: "text", text: "เปิดกี่โมง" }, replyToken: "r1", source: { userId: "U1" } },
    { type: "message", message: { type: "image" }, replyToken: "r2" },
    { type: "follow", replyToken: "r3" },
    { type: "message", message: { type: "text", text: "x" } },
  ], f);
  assert.equal(n, 1);
  const reply = calls.find((c) => c.url.includes("line.me"));
  const body = JSON.parse(reply.init.body);
  assert.equal(body.replyToken, "r1"); assert.ok(body.messages[0].text.length <= 4900);
  const ask = JSON.parse(calls.find((c) => c.url.includes("/api/v1/ask")).init.body);
  assert.match(ask.client_id, /^line:/);
});
