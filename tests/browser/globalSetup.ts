import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts a private Vite dev server on an OS-assigned port for this test run and publishes its URL in
 * E2E_BASE_URL. Several agents can run browser tests at the same time without colliding.
 * Set E2E_BASE_URL yourself to test an already running server (e.g. `vite preview` of a build).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.E2E_BASE_URL) return async () => undefined;
  let server: ViteDevServer | null = null;
  const port = await freePort();
  server = await createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, 'vite.config.ts'),
    logLevel: 'error',
    server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
  });
  await server.listen();
  process.env.E2E_BASE_URL = `http://127.0.0.1:${port}`;
  return async () => {
    await server?.close();
  };
}
