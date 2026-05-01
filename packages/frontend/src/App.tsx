import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthGate } from './components/auth/AuthGate';
import { LoginForm } from './components/auth/LoginForm';
import { AppShell } from './components/layout/AppShell';

// Lazy-loaded page components
const Dashboard = lazy(() =>
  import('./components/pages/Dashboard').then((m) => ({ default: m.Dashboard }))
);
const CoachingWorkspace = lazy(() =>
  import('./components/pages/CoachingWorkspace').then((m) => ({ default: m.CoachingWorkspace }))
);
const CorpusBrowser = lazy(() =>
  import('./components/pages/CorpusBrowser').then((m) => ({ default: m.CorpusBrowser }))
);
const DraftVersions = lazy(() =>
  import('./components/pages/DraftVersions').then((m) => ({ default: m.DraftVersions }))
);
const QuickCapture = lazy(() =>
  import('./components/pages/QuickCapture').then((m) => ({ default: m.QuickCapture }))
);
const CaptureInbox = lazy(() =>
  import('./components/pages/CaptureInbox').then((m) => ({ default: m.CaptureInbox }))
);
const ActivityDashboard = lazy(() =>
  import('./components/pages/ActivityDashboard').then((m) => ({ default: m.ActivityDashboard }))
);
const IntelligenceFeed = lazy(() =>
  import('./components/pages/IntelligenceFeed').then((m) => ({ default: m.IntelligenceFeed }))
);
const PromptlyQueue = lazy(() =>
  import('./components/pages/PromptlyQueue').then((m) => ({ default: m.PromptlyQueue }))
);
const GoalTracker = lazy(() =>
  import('./components/pages/GoalTracker').then((m) => ({ default: m.GoalTracker }))
);
const ThemeMap = lazy(() =>
  import('./components/pages/ThemeMap').then((m) => ({ default: m.ThemeMap }))
);
const SettingsPanel = lazy(() =>
  import('./components/pages/SettingsPanel').then((m) => ({ default: m.SettingsPanel }))
);

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[200px]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginForm />} />

          {/* Protected routes inside AppShell */}
          <Route
            element={
              <AuthGate>
                <AppShell />
              </AuthGate>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/dashboard" element={<ActivityDashboard />} />
            <Route path="/projects/:id/coach" element={<CoachingWorkspace />} />
            <Route path="/projects/:id/corpus" element={<CorpusBrowser />} />
            <Route path="/projects/:id/drafts/:docId" element={<DraftVersions />} />
            <Route path="/projects/:id/promptly" element={<PromptlyQueue />} />
            <Route path="/capture" element={<QuickCapture />} />
            <Route path="/captures" element={<CaptureInbox />} />
            <Route path="/intelligence" element={<IntelligenceFeed />} />
            <Route path="/goals" element={<GoalTracker />} />
            <Route path="/themes" element={<ThemeMap />} />
            <Route path="/settings" element={<SettingsPanel />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
