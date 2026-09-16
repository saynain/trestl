import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../../src/App';
import { KeyboardProvider } from '../../src/lib/keyboard';
import '../../src/styles.css';
import { followWebsiteTheme } from './preferences';

// Demo transport and appearance inheritance are supplied at build time. The UI is production code.
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  '/demo/excalidraw-assets/';
followWebsiteTheme();
if (!window.location.hash) window.location.hash = '/project/studio?tab=board';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <KeyboardProvider>
      <App />
    </KeyboardProvider>
  </React.StrictMode>,
);
