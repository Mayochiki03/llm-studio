import { useEffect, useState } from "react";
import Topbar from "../components/Topbar";
import { Card, CardHeader } from "../components/Card";
import Button from "../components/Button";
import { api } from "../api/client";
import type { EvalPrompt, EvalRun, LeaderboardRow, OllamaModel } from "../types";
import { Star, Trash2, Plus, Play, Trophy } from "lucide-react";

export default function Eval() {
  const [prompts, setPrompts] = useState<EvalPrompt[]>([]);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedPromptIds, setSelectedPromptIds] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [activeRun, setActiveRun] = useState<EvalRun | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [running, setRunning] = useState(false);
  const [newPromptText, setNewPromptText] = useState("");
  const [newPromptCat, setNewPromptCat] = useState("ทั่วไป");

  function loadPrompts() {
    api.evalPrompts().then((p) => {
      setPrompts(p);
      setSelectedPromptIds(new Set(p.map((x) => x.id)));
    });
  }

  function loadRuns() {
    api.evalRuns().then(setRuns);
    api.leaderboard().then(setLeaderboard);
  }

  useEffect(() => {
    loadPrompts();
    loadRuns();
    api.ollamaModels().then((m) => {
      setModels(m.models ?? []);
      setSelectedModel((prev) => prev || m.models?.[0]?.name || "");
    });
  }, []);

  function togglePrompt(id: string) {
    setSelectedPromptIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function addPrompt() {
    if (!newPromptText.trim()) return;
    await api.addEvalPrompt(newPromptText.trim(), newPromptCat.trim() || "ทั่วไป");
    setNewPromptText("");
    loadPrompts();
  }

  async function deletePrompt(id: string) {
    await api.deleteEvalPrompt(id);
    loadPrompts();
  }

  async function runTests() {
    if (!selectedModel || selectedPromptIds.size === 0) return;
    setRunning(true);
    setActiveRun(null);
    try {
      const run = await api.runEval(selectedModel, Array.from(selectedPromptIds));
      setActiveRun(run);
      loadRuns();
    } finally {
      setRunning(false);
    }
  }

  async function rate(resultId: string, rating: number) {
    if (!activeRun) return;
    const updated = await api.rateResult(activeRun.id, resultId, rating);
    setActiveRun(updated);
    loadRuns();
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="ทดสอบโมเดล" subtitle="รันชุดคำถามทดสอบกับโมเดล แล้วให้คะแนนเทียบกันได้" />

      <div className="p-4 md:p-8 max-w-4xl space-y-6">
        <Card>
          <CardHeader title="ตั้งค่าการทดสอบ" />
          <div className="px-5 pb-5 space-y-4">
            <div>
              <label className="text-xs text-base-400 block mb-1.5">เลือกโมเดลที่จะทดสอบ</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
              >
                {models.length === 0 && <option value="">ไม่พบโมเดลใน Ollama</option>}
                {models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-base-400">ชุดคำถามทดสอบ ({selectedPromptIds.size}/{prompts.length} ที่เลือก)</label>
              </div>
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {prompts.map((p) => (
                  <label
                    key={p.id}
                    className="flex items-start gap-2.5 p-2.5 rounded-lg border border-base-800 hover:border-base-700 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-accent-500"
                      checked={selectedPromptIds.has(p.id)}
                      onChange={() => togglePrompt(p.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm">{p.text}</div>
                      <span className="text-[11px] text-base-500">{p.category}</span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        deletePrompt(p.id);
                      }}
                      className="text-base-500 hover:text-bad shrink-0"
                    >
                      <Trash2 size={13} />
                    </button>
                  </label>
                ))}
              </div>

              <div className="flex gap-2 mt-2.5">
                <input
                  value={newPromptText}
                  onChange={(e) => setNewPromptText(e.target.value)}
                  placeholder="เพิ่มคำถามทดสอบใหม่..."
                  className="flex-1 bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
                />
                <input
                  value={newPromptCat}
                  onChange={(e) => setNewPromptCat(e.target.value)}
                  placeholder="หมวด"
                  className="w-28 bg-base-850 border border-base-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-500"
                />
                <Button variant="secondary" onClick={addPrompt}>
                  <Plus size={15} />
                </Button>
              </div>
            </div>

            <div className="flex justify-end">
              <Button onClick={runTests} disabled={running || !selectedModel || selectedPromptIds.size === 0}>
                <Play size={15} /> {running ? "กำลังทดสอบ..." : `รันทดสอบ (${selectedPromptIds.size} คำถาม)`}
              </Button>
            </div>
          </div>
        </Card>

        {activeRun && (
          <Card>
            <CardHeader title={`ผลทดสอบ · ${activeRun.model}`} subtitle="ให้คะแนนแต่ละคำตอบ 1-5 ดาว" />
            <div className="px-5 pb-5 space-y-3">
              {activeRun.results.map((r) => (
                <div key={r.id} className="border border-base-800 rounded-lg p-3.5">
                  <div className="text-xs text-base-500 mb-1.5">คำถาม: {r.prompt_text}</div>
                  <div className="text-sm whitespace-pre-wrap mb-2.5">{r.response}</div>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} onClick={() => rate(r.id, n)}>
                        <Star
                          size={16}
                          className={
                            (r.rating ?? 0) >= n ? "text-warn fill-warn" : "text-base-600 hover:text-base-400"
                          }
                        />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Leaderboard"
            subtitle="คะแนนเฉลี่ยของแต่ละโมเดลจากทุกการทดสอบที่ให้คะแนนแล้ว"
            action={<Trophy size={16} className="text-warn mt-1" />}
          />
          <div className="border-t border-base-800">
            {leaderboard.length === 0 && (
              <div className="px-5 py-8 text-center text-sm text-base-500">ยังไม่มีผลให้คะแนน — ลองรันทดสอบแล้วให้ดาวดูครับ</div>
            )}
            {leaderboard.map((row, i) => (
              <div
                key={row.model}
                className={`flex items-center justify-between px-5 py-3 ${
                  i !== leaderboard.length - 1 ? "border-b border-base-800" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-base-500 w-5">#{i + 1}</span>
                  <span className="text-sm font-medium">{row.model}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-base-500">{row.rated_count} คำตอบ</span>
                  <span className="flex items-center gap-1 text-sm font-semibold text-warn">
                    <Star size={13} className="fill-warn" /> {row.avg_rating}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {runs.length > 0 && (
          <Card>
            <CardHeader title="ประวัติการทดสอบ" />
            <div className="border-t border-base-800">
              {runs.slice(0, 10).map((r, i) => (
                <button
                  key={r.id}
                  onClick={() => setActiveRun(r)}
                  className={`w-full flex items-center justify-between px-5 py-3 text-left hover:bg-base-850 ${
                    i !== Math.min(runs.length, 10) - 1 ? "border-b border-base-800" : ""
                  }`}
                >
                  <span className="text-sm">{r.model}</span>
                  <span className="text-xs text-base-500">{new Date(r.created_at * 1000).toLocaleString("th-TH")}</span>
                </button>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
