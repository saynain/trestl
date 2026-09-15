import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { KeyboardProvider } from './lib/keyboard';
import '@fontsource-variable/inter';
import '@fontsource-variable/inter/wght-italic.css';
import './styles.css';
import './lib/themes/themes.css';
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  '/excalidraw-assets/';
document.documentElement.dataset.theme = 'light';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <KeyboardProvider>
      <App />
    </KeyboardProvider>
  </React.StrictMode>,
);
