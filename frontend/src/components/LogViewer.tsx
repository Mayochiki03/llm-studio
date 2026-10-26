import { useEffect, useRef } from "react";

// ตัดรหัสควบคุมเทอร์มินัล (ESC[A ฯลฯ) ที่เหลือมาใน log เก่า ไม่งั้นแสดงเป็นกล่องแปลกๆ
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b/g;
export const cleanLogLine = (l: string) => l.replace(ANSI, "");

export default function LogViewer({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);

  return (
    <div
      ref={ref}
      className="font-mono-log text-[12.5px] leading-relaxed bg-base-950 border border-base-800 rounded-lg p-4 h-80 overflow-y-auto whitespace-pre-wrap break-all"
    >
      {lines.length === 0 ? (
        <span className="text-base-500">ยังไม่มี log — รอเริ่มงาน...</span>
      ) : (
        lines.map((l, i) => (
          <div key={i} className="text-base-300">
            {cleanLogLine(l)}
          </div>
        ))
      )}
    </div>
  );
}
