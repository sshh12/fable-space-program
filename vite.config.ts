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
  // The project has no runtime npm dependencies, so there is nothing to pre-bundle. Without this, a cold
  // server globbed every *.html under the root to find entries, which walked data/ (hundreds of thousands
  // of tile files) and held the first page load for minutes. A package that adds a browser dependency
  // lists it in `include`.
  optimizeDeps: { noDiscovery: true, include: [], entries: ['index.html', 'labs/*/index.html'] },
  server: {
    host: '127.0.0.1',
    headers: ISOLATION_HEADERS,
    strictPort: false,
    watch: {
      ignored: ['**/data/**', '**/out/**', '**/dist/**', '**/test-results/**', '**/spikes/**', '**/tools/bake/**'],
    },
  },
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
