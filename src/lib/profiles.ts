export const maxLabelLength = 60;
export const labelKey = (id: string) => `trestl.profile-label.v1.${id}`;
export function readLabel(id: string): string {
  try {
    return localStorage.getItem(labelKey(id))?.trim().slice(0, maxLabelLength) || 'Work';
  } catch {
    return 'Work';
  }
}
export function saveLabel(id: string, label: string) {
  try {
    localStorage.setItem(labelKey(id), label.trim());
  } catch {
    /* Storage may be unavailable. */
  }
}
export function openAccount() {
  try {
    localStorage.setItem('trestl.account-change', `${Date.now()}-${Math.random()}`);
  } catch {
    /* Optional cross-tab notification. */
  }
  window.history.replaceState(null, '', `${location.pathname}#/home`);
  window.location.reload();
}
