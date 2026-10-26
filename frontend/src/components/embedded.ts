// บอกหน้าลูกว่า "ตอนนี้อยู่ใน Hub" (ให้ซ่อนหัวเรื่องของตัวเอง) แยกไฟล์เพื่อไม่ให้ Hub กับ Topbar import วนกัน
import { createContext, useContext } from "react";

export const EmbeddedCtx = createContext(false);
export const useEmbedded = () => useContext(EmbeddedCtx);
