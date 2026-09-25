const invoke = window.__TAURI__.core.invoke;
const byId = (id) => document.getElementById(id);
let phase = 'idle';
let busy = false;
let installable = true;
async function refresh() {
  const state = await invoke('update_status');
  phase = state.phase;
  installable = state.installable;
  byId('version').textContent = `Version ${state.currentVersion}`;
  const titles = {
    idle: 'Software updates',
    checking: 'Checking for updates…',
    current: 'You’re up to date',
    available: 'A new version is ready',
    downloading: 'Downloading update…',
    ready: 'Ready when you are',
    preparing: 'Saving your workspace…',
    installing: 'Installing update…',
    error: 'Update unavailable',
  };
  byId('title').textContent = titles[phase] || 'Software updates';
  const descriptions = {
    idle: 'Get the latest improvements to Trestl.',
    checking: 'Looking for the latest release of Trestl.',
    current: 'You have the latest version of Trestl.',
    available: installable
      ? `Trestl ${state.version} is available. Download it now and restart when you’re ready.`
      : `Trestl ${state.version} is available. Update using your package manager, or download the new package.`,
    downloading: 'You can keep working while the signed update downloads.',
    ready:
      'Save and close any open forms. Trestl will save pending changes and restart. Your local data stays in place.',
    preparing: 'Waiting for pending changes and the local database to finish.',
    installing: 'Trestl will reopen automatically when the update is installed.',
    error: 'Your installed application and local data have been kept.',
  };
  byId('description').textContent = descriptions[phase] || '';
  byId('notes-section').hidden = !state.notes || !['available', 'ready'].includes(phase);
  byId('notes').textContent = state.notes; // Release notes are untrusted text, never HTML.
  byId('progress-section').hidden = phase !== 'downloading';
  if (state.total) {
    byId('progress').max = state.total;
    byId('progress').value = state.downloaded;
  } else byId('progress').removeAttribute('value');
  byId('progress-label').textContent =
    `${(state.downloaded / 1048576).toFixed(1)} MB${state.total ? ` of ${(state.total / 1048576).toFixed(1)} MB` : ''}`;
  byId('message').hidden = !state.message;
  byId('message').textContent = state.message;
  byId('action').textContent =
    phase === 'available'
      ? installable
        ? 'Download Update'
        : 'Open Downloads'
      : phase === 'ready'
        ? 'Install and Restart'
        : phase === 'error'
          ? 'Try Again'
          : 'Check for Updates';
  byId('action').disabled =
    busy || ['checking', 'downloading', 'preparing', 'installing'].includes(phase);
  byId('later').disabled = ['preparing', 'installing'].includes(phase);
}
byId('later').addEventListener('click', () => invoke('update_close'));
byId('action').addEventListener('click', async () => {
  busy = true;
  const command =
    phase === 'available'
      ? installable
        ? 'update_download'
        : 'update_releases'
      : phase === 'ready'
        ? 'update_install'
        : 'update_check';
  try {
    await invoke(command);
  } catch (error) {
    byId('message').hidden = false;
    byId('message').textContent = String(error);
  } finally {
    busy = false;
    await refresh();
  }
});
refresh();
setInterval(() => refresh().catch(() => {}), 250);
