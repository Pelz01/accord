import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/public-sans/latin-400.css';
import '@fontsource/public-sans/latin-500.css';
import '@fontsource/public-sans/latin-600.css';
import './styles.css';
const workspaceRoute =
  window.location.pathname.startsWith('/workspace') ||
  Boolean(new URLSearchParams(window.location.search).get('network'));
document.title = workspaceRoute ? 'Workspace · Accord' : 'Accord — Keep business moving.';
const Simulator = import.meta.env.DEV
  ? React.lazy(() => import('./App').then((m) => ({ default: m.App })))
  : null;
const TestnetWorkspace = React.lazy(() =>
  import('./testnet/TestnetWorkspace').then((m) => ({ default: m.TestnetWorkspace })),
);
const Landing = React.lazy(() => import('./landing/Landing').then((m) => ({ default: m.Landing })));
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <React.Suspense fallback={<div className="loading">Opening Accord…</div>}>
      {Simulator && window.location.pathname.startsWith('/dev/simulator') ? (
        <Simulator />
      ) : workspaceRoute ? (
        <TestnetWorkspace />
      ) : (
        <Landing />
      )}
    </React.Suspense>
  </React.StrictMode>,
);
