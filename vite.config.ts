import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { fableDataPlugin, ISOLATION_HEADERS } from './tools/server/dataPlugin';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dev server notes:
 *  - Any `labs/<name>/index.html` is reachable at /labs/<name>/ (Vite serves every HTML file under the root).
 *  - Never hard-code the port in tests: tests/browser/globalSetup.ts starts its own server on a free port.
 */
export default defineConfig({
  root: repoRoot,
  resolve: { alias: { '@': path.join(repoRoot, 'src') } },
  plugins: [fableDataPlugin(repoRoot)],
  server: { host: '127.0.0.1', headers: ISOLATION_HEADERS, strictPort: false },
  preview: { host: '127.0.0.1', headers: ISOLATION_HEADERS, strictPort: false },
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
    rollupOptions: { input: { main: path.join(repoRoot, 'index.html') } },
  },
  // WGSL is imported as text: `import code from './foo.wgsl?raw'`.
  assetsInclude: ['**/*.ktx2', '**/*.ogg', '**/*.opus'],
});
