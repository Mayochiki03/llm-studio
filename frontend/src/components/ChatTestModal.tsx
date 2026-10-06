import { useState } from "react";
import { X, Send, Loader2 } from "lucide-react";
import Button from "./Button";
import { api } from "../api/client";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export default function ChatTestModal({ model, onClose }: { model: string; onClose: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    try {
      const r = await api.ollamaChat(model, text);
      setMessages((m) => [...m, { role: "assistant", content: r.reply || r.error || "(ไม่มีคำตอบ)" }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", content: `เกิดข้อผิดพลาด: ${e.message}` }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-base-900 border border-base-800 rounded-xl2 shadow-card w-full max-w-lg h-[32rem] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-14 border-b border-base-800 shrink-0">
          <div className="text-sm font-medium truncate">ทดสอบแชท · {model}</div>
          <button onClick={onClose} className="text-base-400 hover:text-base-100">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-xs text-base-500 text-center mt-8">ลองพิมพ์คำถามเพื่อทดสอบโมเดลนี้ดูครับ</div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm whitespace-pre-wrap ${
                  m.role === "user" ? "bg-accent-500 text-base-950" : "bg-base-850 text-base-100 border border-base-700"
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-base-400">
              <Loader2 size={14} className="animate-spin" /> กำลังคิดคำตอบ...
            </div>
          )}
        </div>

        <div className="p-3 border-t border-base-800 flex gap-2 shrink-0">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="พิมพ์ข้อความ..."
            className="flex-1 bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
          />
          <Button onClick={send} disabled={loading}>
            <Send size={15} />
          </Button>
        </div>
      </div>
    </div>
  );
}
