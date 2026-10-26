import { Routes, Route, useLocation } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import Sidebar from "./components/Sidebar";
import AuthGate from "./components/AuthGate";
import { Toaster } from "./components/toast";
import Dashboard from "./pages/Dashboard";
import NewTraining from "./pages/NewTraining";
import JobDetail from "./pages/JobDetail";
import Models from "./pages/Models";
import Settings from "./pages/Settings";
import ImportModel from "./pages/ImportModel";
import Eval from "./pages/Eval";
import KnowledgeBase from "./pages/KnowledgeBase";
import Playground from "./pages/Playground";
import Registry from "./pages/Registry";
import Datasets from "./pages/Datasets";
import System from "./pages/System";
import Scope from "./pages/Scope";
import Api from "./pages/Api";
import Glossary from "./pages/Glossary";
import Hub from "./components/Hub";

// หน้ารวมหลายแท็บ: เส้นทางเดิมของแต่ละหน้ายังใช้ได้ (ลิงก์/บุ๊กมาร์กเก่าไม่เสีย) แต่ใช้หัวเรื่องและแท็บชุดเดียวกัน
const MODEL_TABS = [
  { to: "/registry", label: "ใช้งานจริง", hint: "เลือกว่าโมเดลตัวไหนให้ระบบอื่นเรียกใช้ อนุมัติ และย้อนกลับ" },
  { to: "/models", label: "ในเครื่อง (Ollama)", hint: "โมเดลทั้งหมดที่ติดตั้งอยู่ในเครื่องนี้" },
  { to: "/import", label: "นำเข้าจากที่อื่น", hint: "เอาโมเดลที่เทรนจากที่อื่น เช่น Colab เข้ามา" },
];
const CONTROL_TABS = [
  { to: "/scope", label: "ขอบเขตการตอบ", hint: "ตอบอะไรได้ ตอบอะไรไม่ได้ เคสอันตราย" },
  { to: "/connect", label: "เชื่อมต่อระบบอื่น (API)", hint: "คีย์ API ให้เว็บ/LINE เรียกใช้" },
];
const SYSTEM_TABS = [
  { to: "/system", label: "เครื่องและพื้นที่" },
  { to: "/settings", label: "ตั้งค่า" },
  { to: "/glossary", label: "คำศัพท์" },
];
const modelsHub = (el: JSX.Element) => <Hub title="โมเดล" subtitle="โมเดลที่ใช้งานจริง ที่ติดตั้งในเครื่อง และการนำเข้า" tabs={MODEL_TABS}>{el}</Hub>;
const controlHub = (el: JSX.Element) => <Hub title="ขอบเขตและการเชื่อมต่อ" subtitle="กำหนดว่าระบบตอบอะไรได้ และให้ระบบอื่นเรียกใช้อย่างไร" tabs={CONTROL_TABS}>{el}</Hub>;
const systemHub = (el: JSX.Element) => <Hub title="เครื่องและตั้งค่า" subtitle="สถานะเครื่อง การตั้งค่า และคำศัพท์" tabs={SYSTEM_TABS}>{el}</Hub>;

export default function App() {
  const loc = useLocation();
  return (
    <AuthGate>
      <div className="flex h-screen w-full overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <ErrorBoundary resetKey={loc.pathname}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/train" element={<NewTraining />} />
            <Route path="/jobs/:id" element={<JobDetail />} />
            <Route path="/import" element={modelsHub(<ImportModel />)} />
            <Route path="/eval" element={<Eval />} />
            <Route path="/models" element={modelsHub(<Models />)} />
            <Route path="/kb" element={<KnowledgeBase />} />
            <Route path="/playground" element={<Playground />} />
            <Route path="/registry" element={modelsHub(<Registry />)} />
            <Route path="/scope" element={controlHub(<Scope />)} />
            <Route path="/connect" element={controlHub(<Api />)} />
            <Route path="/datasets" element={<Datasets />} />
            <Route path="/system" element={systemHub(<System />)} />
            <Route path="/settings" element={systemHub(<Settings />)} />
            <Route path="/glossary" element={systemHub(<Glossary />)} />
          </Routes>
          </ErrorBoundary>
        </div>
      </div>
      <Toaster />
    </AuthGate>
  );
}
