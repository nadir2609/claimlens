import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import type { AnalysisMode } from '@claimlens/shared';
import { api } from './api';
import { Badge } from './components/Badge';
import { ClaimsPage } from './pages/ClaimsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ReportPage } from './pages/ReportPage';
import { SubmitPage } from './pages/SubmitPage';
import { useTheme } from './theme';

const ModeContext = createContext<AnalysisMode | null>(null);
export const useAnalysisMode = () => useContext(ModeContext);

export function App() {
  const { theme, toggle } = useTheme();
  const [mode, setMode] = useState<AnalysisMode | null>(null);

  useEffect(() => {
    api.getConfig().then((c) => setMode(c.analysisMode), () => setMode(null));
  }, []);

  return (
    <ModeContext.Provider value={mode}>
      <header className="app-header">
        <div className="app-header-inner">
          <NavLink to="/" className="wordmark">
            <span className="wordmark-mark" aria-hidden="true" />
            ClaimLens
          </NavLink>
          <nav className="app-nav" aria-label="Main">
            <NavLink to="/" end>New claim</NavLink>
            <NavLink to="/claims">Claims</NavLink>
          </nav>
          <div className="app-header-end">
            {mode === 'demo' && (
              <Badge tone="warn" title="No API key set: analysis results are simulated">Demo mode</Badge>
            )}
            <button
              type="button"
              className="btn btn-ghost theme-toggle"
              onClick={toggle}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
        </div>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<SubmitPage />} />
          <Route path="/claims" element={<ClaimsPage />} />
          <Route path="/claims/:id" element={<ReportPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </ModeContext.Provider>
  );
}
