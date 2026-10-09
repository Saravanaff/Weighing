import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from '../../shared/AppErrorBoundary.tsx';
import App from './App.tsx';
import './index.css';
import './staff.css';
import { initFontScale } from '../../shared/fontScale.ts';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element in index.html');
}

// Before the first paint, so a saved size is never briefly wrong on screen.
initFontScale();

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary appName="NAVEEN POULTRY FARMS — Staff terminal">
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
