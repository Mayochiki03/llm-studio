import { useEffect, useRef, useState } from "react";
import { X, Search, Download, Heart } from "lucide-react";
import { api } from "../api/client";
import type { HFSearchResult } from "../types";

export default function SearchHFDialog({
  kind,
  onClose,
  onPick,
}: {
  kind: "model" | "dataset";
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<HFSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(debounce.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(() => {
      setLoading(true);
      const search = kind === "model" ? api.searchHFModels : api.searchHFDatasets;
      search(q.trim())
        .then((r) => setResults(r.results ?? []))
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(debounce.current);
  }, [q, kind]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-base-900 border border-base-800 rounded-xl2 shadow-card w-full max-w-lg max-h-[32rem] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-14 border-b border-base-800 shrink-0">
          <div className="text-sm font-medium">ค้นหา{kind === "model" ? "โมเดล" : "ชุดข้อมูล"}จาก Hugging Face</div>
          <button onClick={onClose} className="text-base-400 hover:text-base-100">
            <X size={18} />
          </button>
        </div>
        <div className="p-4 border-b border-base-800 shrink-0">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-500" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={kind === "model" ? "เช่น typhoon, qwen, llama" : "เช่น thai instruction, alpaca"}
              className="w-full bg-base-850 border border-base-700 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-accent-500"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="px-5 py-8 text-center text-xs text-base-500">กำลังค้นหา...</div>}
          {!loading && q.trim() && results.length === 0 && (
            <div className="px-5 py-8 text-center text-xs text-base-500">ไม่พบผลลัพธ์</div>
          )}
          {!loading && !q.trim() && (
            <div className="px-5 py-8 text-center text-xs text-base-500">พิมพ์คำค้นหาด้านบน</div>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                onPick(r.id);
                onClose();
              }}
              className="w-full flex items-center justify-between px-5 py-3 border-b border-base-800 last:border-0 hover:bg-base-850 text-left"
            >
              <span className="text-sm font-mono-log truncate">{r.id}</span>
              <span className="flex items-center gap-3 text-[11px] text-base-500 shrink-0 ml-3">
                <span className="flex items-center gap-1">
                  <Download size={11} /> {r.downloads.toLocaleString()}
                </span>
                <span className="flex items-center gap-1">
                  <Heart size={11} /> {r.likes.toLocaleString()}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
