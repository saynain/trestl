const invoke = window.__TAURI__.core.invoke;
const byId = (id) => document.getElementById(id);
let busy = false;
let last = '';
let expanded = null;
let snapshot;
function error(message) {
  byId('error').textContent = message;
  byId('error').hidden = !message;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function action(command, args) {
  if (busy) return false;
  busy = true;
  error('');
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
  try {
    await invoke(command, args);
    await refresh(true);
    return true;
  } catch (cause) {
    error(typeof cause === 'string' ? cause : 'Could not complete this action. Please try again.');
    return false;
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => {
      button.disabled = false;
    });
  }
}
const symbols = {
  local:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  remote:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>',
};
function render(state) {
  const root = byId('connections');
  root.replaceChildren();
  for (const connection of [{ id: 'local', name: 'Local', url: null }, ...state.connections]) {
    const local = connection.id === 'local';
    const active = state.active === connection.id;
    const card = element('div', `connection${active ? ' active' : ''}`);
    const row = element('div', 'row');
    const choose = element('button', 'choose');
    choose.setAttribute(
      'aria-label',
      `Open ${connection.name}${local ? '' : ` (${connection.url})`}`,
    );
    if (active) choose.setAttribute('aria-current', 'true');
    choose.onclick = () => action('connection_switch', { id: connection.id });
    const icon = element('span', 'symbol');
    icon.innerHTML = symbols[local ? 'local' : 'remote']; // Fixed app icons; installation strings use textContent only.
    icon.setAttribute('aria-hidden', 'true');
    const identity = element('span', 'identity');
    identity.append(
      element('span', 'name', connection.name),
      element('span', 'address', local ? 'On this computer · available offline' : connection.url),
    );
    choose.append(icon, identity);
    if (active) choose.append(element('span', 'selected', '✓'));
    row.append(choose);
    if (!local) {
      const more = element('button', 'more', '•••');
      more.setAttribute('aria-label', `Manage ${connection.name}`);
      more.setAttribute('aria-expanded', String(expanded === connection.id));
      more.onclick = () => {
        expanded = expanded === connection.id ? null : connection.id;
        render(snapshot);
      };
      row.append(more);
    }
    card.append(row);
    if (expanded === connection.id) {
      const details = element('div', 'details');
      const opened = state.open.includes(connection.id);
      details.append(
        element(
          'p',
          '',
          `${connection.serverVersion ? `Server ${connection.serverVersion}` : 'Server version not reported'} · ${opened ? 'Session open — switching preserves drafts.' : 'Session closed.'}`,
        ),
      );
      const actions = element('div', 'detail-actions');
      for (const [label, command, args, className] of [
        ['Open in browser', 'connection_browser', { id: connection.id }, ''],
        ...(opened
          ? [
              [
                'Close session',
                'connection_close_session',
                { id: connection.id, remove: false },
                '',
              ],
            ]
          : []),
        [
          'Remove connection',
          'connection_close_session',
          { id: connection.id, remove: true },
          'remove',
        ],
      ]) {
        const button = element('button', className, label);
        button.onclick = () => action(command, args);
        actions.append(button);
      }
      details.append(actions);
      card.append(details);
    }
    root.append(card);
  }
  byId('version').textContent = `Desktop ${state.desktopVersion}`;
  byId('session-note').hidden = state.persistentSessions;
}
async function refresh(force = false) {
  const state = await invoke('connection_list');
  snapshot = state;
  const next = JSON.stringify(state);
  if (force || next !== last) {
    last = next;
    render(state);
  }
  if (state.error) error(state.error);
}
function showForm(show) {
  error('');
  byId('add-form').hidden = !show;
  byId('add-toggle').hidden = show;
  byId('add-toggle').setAttribute('aria-expanded', String(show));
  byId(show ? 'url' : 'add-toggle').focus();
}
byId('add-toggle').onclick = () => showForm(true);
byId('cancel-add').onclick = () => showForm(false);
byId('add-form').onsubmit = async (event) => {
  event.preventDefault();
  const added = await action('connection_add', { url: byId('url').value });
  if (added) {
    byId('url').value = '';
    showForm(false);
  }
};
refresh().catch(() => error('Could not load connections. Close this window and try again.'));
setInterval(() => {
  if (!busy) void refresh().catch(() => {});
}, 1500);
