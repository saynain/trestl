import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const editorAssets = dirname(fileURLToPath(import.meta.resolve('@excalidraw/excalidraw')));
// Preserve the package's worker module graph. Bundling it into the React graph
// introduces DOM-only imports inside the font export worker.
const workerFiles = new Set<string>();
function collectWorkerFiles(name: string) {
  if (workerFiles.has(name)) return;
  workerFiles.add(name);
  const source = readFileSync(resolve(editorAssets, name), 'utf8');
  for (const match of source.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g))
    collectWorkerFiles(match[1]);
}
collectWorkerFiles('subset-worker.chunk.js');
export default defineConfig({
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        {
          name: 'excalidraw-export-worker',
          setup(build) {
            build.onResolve({ filter: /subset-worker\.chunk\.js$/ }, (args) => {
              if (args.importer.includes('@excalidraw'))
                return { path: '/excalidraw-assets/subset-worker.chunk.js', external: true };
            });
          },
        },
      ],
    },
  },
  plugins: [
    react(),
    {
      name: 'self-host-excalidraw-assets',
      enforce: 'pre',
      transform(source, id) {
        if (!id.includes('@excalidraw') && !id.includes('/deps/')) return;
        const next = source.replace(
          /import\(["'](?:\.\/|\/excalidraw-assets\/)subset-worker\.chunk\.js["']\)/g,
          'import(/* @vite-ignore */ String("/excalidraw-assets/subset-worker.chunk.js"))',
        );
        if (next !== source) return { code: next, map: null };
      },
      configureServer(server) {
        server.middlewares.use('/excalidraw-assets/', (request, response, next) => {
          const name = (request.url || '').split('?')[0].replace(/^\/+/, '');
          const path = resolve(editorAssets, name);
          const font =
            path.startsWith(resolve(editorAssets, 'fonts') + sep) && path.endsWith('.woff2');
          if ((!font && !workerFiles.has(name)) || !existsSync(path)) return next();
          response.setHeader('Content-Type', font ? 'font/woff2' : 'text/javascript');
          createReadStream(path).pipe(response);
        });
      },
      writeBundle(options) {
        cpSync(
          resolve(editorAssets, 'fonts'),
          resolve(options.dir || 'dist', 'excalidraw-assets/fonts'),
          { recursive: true },
        );
        for (const name of workerFiles)
          cpSync(
            resolve(editorAssets, name),
            resolve(options.dir || 'dist', 'excalidraw-assets', name),
          );
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.PORT || 4317}`,
      '/cli-auth': `http://127.0.0.1:${process.env.PORT || 4317}`,
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: { external: ['/excalidraw-assets/subset-worker.chunk.js'] },
  },
});
