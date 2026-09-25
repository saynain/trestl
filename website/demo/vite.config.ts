import { mkdirSync, renameSync } from 'node:fs';
import { defineConfig } from '../../node_modules/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import productConfig from '../../vite.config';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
export default defineConfig({
  ...productConfig,
  root: here,
  base: '/demo/',
  publicDir: false,
  resolve: {
    alias: {
      react: resolve(repo, 'node_modules/react'),
      'react-dom': resolve(repo, 'node_modules/react-dom'),
    },
  },
  plugins: [
    {
      name: 'isolated-demo-api',
      enforce: 'pre',
      generateBundle() {
        for (const moduleId of this.getModuleIds()) {
          if (
            ['src/lib/api.ts', 'src/lib/canvas-collaboration.ts'].some(
              (file) => moduleId.split('?')[0] === resolve(repo, file),
            )
          ) {
            this.error('The website demo must never include the production API transport.');
          }
        }
      },
      resolveId(id, importer) {
        if (
          importer &&
          id.startsWith('.') &&
          resolve(dirname(importer), id).replace(/\.tsx?$/, '') ===
            resolve(repo, 'src/lib/canvas-collaboration')
        )
          return resolve(here, 'canvas-collaboration.ts');
        if (
          importer &&
          id.startsWith('.') &&
          importer !== resolve(here, 'themes.ts') &&
          [resolve(repo, 'src/lib/themes'), resolve(repo, 'src/lib/themes/index')].includes(
            resolve(dirname(importer), id).replace(/\.tsx?$/, ''),
          )
        )
          return resolve(here, 'themes.ts');
        if (
          importer &&
          id.startsWith('.') &&
          importer !== resolve(here, 'preferences.ts') &&
          resolve(dirname(importer), id).replace(/\.tsx?$/, '') ===
            resolve(repo, 'src/lib/preferences')
        )
          return resolve(here, 'preferences.ts');
        if (
          importer &&
          id.startsWith('.') &&
          resolve(dirname(importer), id).replace(/\.tsx?$/, '') === resolve(repo, 'src/lib/api')
        )
          return resolve(here, 'api.ts');
      },
    },
    ...productConfig.plugins!,
    {
      name: 'demo-editor-worker-path',
      closeBundle() {
        mkdirSync(resolve(here, '../.generated'), { recursive: true });
        renameSync(
          resolve(here, '../public/demo/index.html'),
          resolve(here, '../.generated/demo.html'),
        );
      },
      enforce: 'post',
      transform(source, id) {
        if (id.includes('@excalidraw'))
          return source.replaceAll('/excalidraw-assets/', '/demo/excalidraw-assets/');
      },
    },
  ],
  build: {
    ...productConfig.build,
    outDir: resolve(here, '../public/demo'),
    emptyOutDir: true,
    rollupOptions: {
      external: [
        '/excalidraw-assets/subset-worker.chunk.js',
        '/demo/excalidraw-assets/subset-worker.chunk.js',
      ],
    },
  },
});
