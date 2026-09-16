const key = 'trestl.website.theme';
const system = matchMedia('(prefers-color-scheme: dark)');
let choice = 'system';
try {
  choice = localStorage.getItem(key) || 'system';
} catch {
  /* Session-only preference. */
}
const toggle = document.querySelector<HTMLButtonElement>('#site-theme');
function apply() {
  const theme = choice === 'dark' || (choice !== 'light' && system.matches) ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#191c19' : '#f6f4ef');
  toggle?.setAttribute('aria-checked', String(theme === 'dark'));
  toggle?.setAttribute('title', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
}
toggle?.addEventListener('click', () => {
  choice = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(key, choice);
  } catch {
    /* Still works without storage. */
  }
  apply();
});
system.addEventListener('change', apply);
window.addEventListener('storage', (event) => {
  if (event.key === key || event.key === null) {
    choice = event.newValue || 'system';
    apply();
  }
});
apply();
