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
            <Route path="/import" element={<ImportModel />} />
            <Route path="/eval" element={<Eval />} />
            <Route path="/models" element={<Models />} />
            <Route path="/kb" element={<KnowledgeBase />} />
            <Route path="/playground" element={<Playground />} />
            <Route path="/registry" element={<Registry />} />
            <Route path="/datasets" element={<Datasets />} />
            <Route path="/system" element={<System />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
          </ErrorBoundary>
        </div>
      </div>
      <Toaster />
    </AuthGate>
  );
}
