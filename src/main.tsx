import { isDesktop, isLocalDesktop, desktopPlatform } from './lib/desktop';
import { watchDesktopUpdates } from './lib/desktop-updates';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { KeyboardProvider } from './lib/keyboard';
import '@fontsource-variable/inter';
import '@fontsource-variable/inter/wght-italic.css';
import './styles.css';
import './lib/themes/themes.css';
import './desktop.css';
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
  '/excalidraw-assets/';
document.documentElement.dataset.theme =
  isDesktop && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
if (isLocalDesktop) watchDesktopUpdates();
if (desktopPlatform) document.documentElement.dataset.desktop = desktopPlatform;
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {desktopPlatform === 'macos' && (
      <div className="desktop-drag-strip" data-tauri-drag-region aria-hidden="true" />
    )}
    <KeyboardProvider>
      <App />
    </KeyboardProvider>
  </React.StrictMode>,
);
