#!/usr/bin/env bash
# เริ่ม LLM Studio แบบพอร์ตเดียว (เหมาะกับเซิร์ฟเวอร์ Ubuntu): backend เสิร์ฟหน้าเว็บที่บิลด์แล้วให้เอง
# ใช้: ./start.sh            (ครั้งแรกจะบิลด์หน้าเว็บให้ ต้องมี Node.js 18+)
#      HOST=0.0.0.0 ./start.sh  (ให้เครื่องอื่นในวง LAN เข้าได้ แนะนำให้ตั้งรหัสผ่านในหน้า "ตั้งค่า" ก่อน)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d frontend/dist ]; then
  echo "[LLM Studio] ยังไม่มี frontend/dist กำลังบิลด์หน้าเว็บ..."
  (cd frontend && npm install && npm run build)
fi

# ถ้ามี venv อยู่ข้างโปรเจกต์ (.venv) ให้ใช้ก่อน ไม่งั้นใช้ python ในเครื่อง (ต้องมี unsloth ติดตั้งไว้แล้ว)
if [ -f .venv/bin/activate ]; then source .venv/bin/activate; fi

cd backend
exec python -m uvicorn main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8800}"
