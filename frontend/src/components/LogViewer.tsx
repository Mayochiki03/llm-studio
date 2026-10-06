import { useEffect, useRef } from "react";

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
            {l}
          </div>
        ))
      )}
    </div>
  );
}
