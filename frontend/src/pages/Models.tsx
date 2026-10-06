import { useEffect, useState } from "react";
import Topbar from "../components/Topbar";
import { Card } from "../components/Card";
import Button from "../components/Button";
import ChatTestModal from "../components/ChatTestModal";
import { api } from "../api/client";
import type { OllamaModel } from "../types";
import { MessageSquare, Trash2, RefreshCw, HardDrive } from "lucide-react";

function formatBytes(n: number) {
  if (!n) return "-";
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`;
}

export default function Models() {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [chatModel, setChatModel] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  function refresh() {
    setLoading(true);
    api
      .ollamaModels()
      .then((m) => setModels(m.models ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(refresh, []);

  async function doDelete(name: string) {
    if (!confirm(`ลบโมเดล "${name}" ออกจาก Ollama?`)) return;
    setDeleting(name);
    try {
      await api.deleteOllamaModel(name);
      refresh();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="โมเดลของฉัน" subtitle="โมเดลทั้งหมดที่โหลดอยู่ใน Ollama บนเครื่องนี้" />

      <div className="p-4 md:p-8 max-w-4xl space-y-4">
        <div className="flex justify-end">
          <Button variant="secondary" onClick={refresh} className="text-xs py-1.5">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
        </div>

        <Card>
          {models.length === 0 && !loading && (
            <div className="px-5 py-12 text-center text-sm text-base-500 flex flex-col items-center gap-2">
              <HardDrive size={24} className="text-base-600" />
              ไม่พบโมเดลใน Ollama — เช็คว่า Ollama รันอยู่ไหม หรือยังไม่เคย pull/create โมเดลเลย
            </div>
          )}
          {models.map((m, i) => (
            <div
              key={m.name}
              className={`flex items-center justify-between px-5 py-4 ${
                i !== models.length - 1 ? "border-b border-base-800" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{m.name}</div>
                <div className="text-xs text-base-500 mt-0.5">{formatBytes(m.size)}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="secondary" className="text-xs py-1.5" onClick={() => setChatModel(m.name)}>
                  <MessageSquare size={14} /> ทดสอบแชท
                </Button>
                <Button
                  variant="danger"
                  className="text-xs py-1.5"
                  disabled={deleting === m.name}
                  onClick={() => doDelete(m.name)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
          ))}
        </Card>
      </div>

      {chatModel && <ChatTestModal model={chatModel} onClose={() => setChatModel(null)} />}
    </div>
  );
}
