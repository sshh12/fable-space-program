/**
 * Vite plugin (lead-owned root configuration): serves `/endpoints.json`, the endpoint document a client
 * reads to find the server roles (ARCHITECTURE 13.1, 16.4).
 *
 *  - With the environment variable STACK_ENDPOINTS naming a file (the local stack's launcher sets it when
 *    it starts the dev server), `/endpoints.json` answers with that file, read again on every request (a
 *    client re-reads the document before every reconnect attempt, and the launcher may rewrite it when the
 *    stack changes shape).
 *  - Without it, or when the file does not exist, the answer is 404 with no body: there is no universe to
 *    connect to and the app offers Practice only, as it does today. (Without this plugin Vite's single-page
 *    fallback would answer the path with index.html and status 200.)
 *
 * Applies to `vite` (dev) and `vite preview`. The production deployment serves the document from the
 * `shell` role; the build does not contain one.
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export const ENDPOINTS_PATH = '/endpoints.json';

export function stackEndpointsPlugin(headers: Record<string, string> = {}): Plugin {
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== ENDPOINTS_PATH) {
      next();
      return;
    }
    const file = process.env.STACK_ENDPOINTS;
    let body: Buffer | null = null;
    if (file) {
      try {
        body = fs.readFileSync(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    if (body === null) {
      res.writeHead(404, { ...headers, 'Cache-Control': 'no-store', 'Content-Length': '0' });
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  return {
    name: 'fable-stack-endpoints',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
