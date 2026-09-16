import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  output: 'static',
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    define: {
      __TRESTL_REPO_ROOT__: JSON.stringify(fileURLToPath(new URL('../', import.meta.url))),
    },
  },
  devToolbar: { enabled: false },
});
