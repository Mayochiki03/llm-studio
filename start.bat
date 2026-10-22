@echo off
rem เริ่ม LLM Studio บน Windows แบบพอร์ตเดียว (ต้อง activate venv ที่มี unsloth ก่อนดับเบิลคลิก หรือรันจาก terminal ที่ activate แล้ว)
cd /d "%~dp0"
if not exist frontend\dist (
  echo [LLM Studio] ยังไม่มี frontend\dist กำลังบิลด์หน้าเว็บ...
  pushd frontend
  call npm install
  call npm run build
  popd
)
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8800
