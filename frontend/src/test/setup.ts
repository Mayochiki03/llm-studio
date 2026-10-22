// เตรียมสภาพแวดล้อมจำลองให้เทสต์: jsdom ไม่มีบางฟังก์ชันที่เบราว์เซอร์จริงมี
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// คืนค่า (ไม่ใช่ undefined) เพื่อจับบั๊ก useEffect ที่เผลอ return ค่า → React error "destroy is not a function"
(Element.prototype as any).scrollIntoView = () => 1;
window.matchMedia = window.matchMedia || ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as unknown as MediaQueryList);
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || RO;
window.confirm = () => true;

afterEach(() => {
  cleanup();
  localStorage.clear();
});
