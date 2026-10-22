// กันหน้าจอขาวเงียบ: ถ้าหน้าไหนพังตอนวาด จะแสดงข้อความ error ให้เห็นและส่งต่อให้ผู้พัฒนาได้ แทนที่จะเหลือจอว่าง
import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { reportError } from "../lib/clientLog";

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[LLM Studio] หน้าพังตอนวาด:", error);
    reportError("render", error); // ส่งไปเก็บที่ backend ดูได้ในหน้า "เครื่องและพื้นที่" → บันทึกการทำงาน
  }

  // เปลี่ยนหน้า (resetKey เปลี่ยน) แล้วล้างสถานะ error เพื่อให้หน้าอื่นยังใช้ได้
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="max-w-2xl bg-bad/10 border border-bad/30 rounded-xl2 p-5 space-y-3">
          <div className="flex items-center gap-2 text-bad font-medium text-sm">
            <AlertTriangle size={16} /> หน้านี้แสดงผลไม่ได้
          </div>
          <p className="text-xs text-base-300">ระบบบันทึก error นี้ไว้ให้แล้ว (หน้า "เครื่องและพื้นที่" → บันทึกการทำงาน) ลองรีเฟรชหน้า ถ้ายังเป็นอีก ให้คัดลอกข้อความด้านล่างส่งให้ผู้พัฒนา</p>
          <pre className="text-[11px] text-base-200 bg-base-950 border border-base-800 rounded-lg p-3 whitespace-pre-wrap break-words max-h-72 overflow-auto">
            {String(this.state.error.stack ?? this.state.error.message)}
          </pre>
          <button onClick={() => location.reload()} className="px-4 py-2 rounded-lg text-sm bg-base-800 hover:bg-base-700 border border-base-700">
            รีเฟรชหน้า
          </button>
        </div>
      </div>
    );
  }
}
