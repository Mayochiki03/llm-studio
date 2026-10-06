import { Routes, Route } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Dashboard from "./pages/Dashboard";
import NewTraining from "./pages/NewTraining";
import JobDetail from "./pages/JobDetail";
import Models from "./pages/Models";
import Settings from "./pages/Settings";
import ImportModel from "./pages/ImportModel";
import Eval from "./pages/Eval";

export default function App() {
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/train" element={<NewTraining />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/import" element={<ImportModel />} />
          <Route path="/eval" element={<Eval />} />
          <Route path="/models" element={<Models />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </div>
    </div>
  );
}
