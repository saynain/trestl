type DesktopContext = {
  bridgeVersion: number;
  remote: boolean;
  name: string;
  origin: string;
  platform: string;
  nativeChrome: boolean;
};
const injected = (window as Window & { __TRESTL_DESKTOP__?: DesktopContext }).__TRESTL_DESKTOP__;
export const remoteDesktop = injected?.bridgeVersion === 1 ? injected : undefined;
export const isLocalDesktop = import.meta.env.VITE_TRESTL_DESKTOP === 'true';
export const isDesktop = isLocalDesktop || !!remoteDesktop;
export const desktopPlatform = isLocalDesktop
  ? import.meta.env.VITE_TRESTL_DESKTOP_PLATFORM === 'darwin'
    ? 'macos'
    : import.meta.env.VITE_TRESTL_DESKTOP_PLATFORM
  : remoteDesktop?.nativeChrome
    ? remoteDesktop.platform
    : undefined;
export async function openConnections() {
  const bridge = (
    window as Window & { __TAURI__?: { core: { invoke: (name: string) => Promise<unknown> } } }
  ).__TAURI__;
  if (!bridge) throw new Error('Use the Connections menu to switch installations.');
  await bridge.core.invoke('connection_open');
}
