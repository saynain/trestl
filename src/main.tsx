import { watchDesktopUpdates } from './lib/desktop-updates';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { KeyboardProvider } from './lib/keyboard';
import '@fontsource-variable/inter';
import '@fontsource-variable/inter/wght-italic.css';
import './styles.css';
import './components/navigation.css';
import './lib/themes/themes.css';
import './desktop.css';
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  '/excalidraw-assets/';
document.documentElement.dataset.theme =
  import.meta.env.VITE_TRESTL_DESKTOP === 'true' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
if (import.meta.env.VITE_TRESTL_DESKTOP === 'true') {
  watchDesktopUpdates();
  document.documentElement.dataset.desktop =
    import.meta.env.VITE_TRESTL_DESKTOP_PLATFORM === 'darwin'
      ? 'macos'
      : import.meta.env.VITE_TRESTL_DESKTOP_PLATFORM;
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {import.meta.env.VITE_TRESTL_DESKTOP === 'true' && (
      <div className="desktop-drag-strip" data-tauri-drag-region aria-hidden="true" />
    )}
    <KeyboardProvider>
      <App />
    </KeyboardProvider>
  </React.StrictMode>,
);
