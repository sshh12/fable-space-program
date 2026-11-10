import type { DefSource } from './loader';

/**
 * Browser DefSource. The dev/preview server (tools/server/dataPlugin.ts) serves data/defs at /defs and a
 * generated listing at /defs/index.json; the production build copies both into dist/defs.
 */
export function fetchDefSource(baseUrl = '/defs'): DefSource {
  let listing: Promise<string[]> | null = null;
  return {
    list() {
      listing ??= fetch(`${baseUrl}/index.json`).then(async (r) => {
        if (!r.ok) throw new Error(`defs index: HTTP ${r.status}`);
        const body = (await r.json()) as { files: string[] };
        return body.files;
      });
      return listing;
    },
    async read(path) {
      const files = await this.list();
      if (!files.includes(path)) return undefined;
      const r = await fetch(`${baseUrl}/${path}`);
      if (!r.ok) throw new Error(`defs ${path}: HTTP ${r.status}`);
      return r.json() as Promise<unknown>;
    },
  };
}
