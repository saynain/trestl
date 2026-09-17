// The native updater receives only a readiness acknowledgement from the workspace.
// Installation controls belong to a separate, bundled window with its own capability.
const guards = new Set<() => Promise<boolean>>();
let pendingWrites = 0;
export function trackDesktopWrite() {
  pendingWrites++;
  return () => {
    pendingWrites--;
  };
}
export function registerUpdateGuard(guard: () => Promise<boolean>) {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}
export function watchDesktopUpdates() {
  type Bridge = { core: { invoke: (command: string, args: unknown) => Promise<unknown> } };
  const bridge = (window as Window & { __TAURI__?: Bridge }).__TAURI__;
  if (!bridge) return;
  let preparing = false;
  let activeRequest: number | undefined;
  const thaw = () => {
    preparing = false;
    activeRequest = undefined;
    document.body.inert = false;
    document.documentElement.removeAttribute('data-updating');
  };
  window.addEventListener('trestl:update-cancelled', thaw);
  window.addEventListener('trestl:prepare-update', async (event) => {
    if (preparing) return;
    const request = (event as CustomEvent<number>).detail;
    activeRequest = request;
    let error: string | null = null;
    try {
      // Open forms may hold drafts that have never been submitted to the server.
      if (document.querySelector('[role="dialog"], form'))
        throw new Error(
          'Save and close open forms or editors, then try Install and Restart again.',
        );
      preparing = true;
      document.body.inert = true;
      document.documentElement.dataset.updating = 'true';
      const saved = await Promise.all([...guards].map((guard) => guard()));
      if (activeRequest !== request) return;
      if (saved.some((result) => !result))
        throw new Error(
          'Some changes could not be saved. Resolve them before installing the update.',
        );
      const deadline = Date.now() + 10000;
      while (pendingWrites > 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (activeRequest !== request) return;
      if (pendingWrites) throw new Error('Changes are still saving. Please try again shortly.');
      const unload = new Event('beforeunload', { cancelable: true });
      if (!window.dispatchEvent(unload))
        throw new Error('Save your pending changes before updating.');
    } catch (cause) {
      if (activeRequest !== request) return;
      error = cause instanceof Error ? cause.message : 'Save your work before updating.';
      thaw();
    }
    try {
      await bridge.core.invoke('update_prepared', { request, error });
    } catch {
      if (activeRequest === request) thaw();
    }
  });
}
