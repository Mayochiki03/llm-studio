// ตั้งค่าเทสต์ฝั่งหน้าเว็บ (รันด้วย npm test) ใช้ jsdom จำลองเบราว์เซอร์
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 15000,
  },
});
