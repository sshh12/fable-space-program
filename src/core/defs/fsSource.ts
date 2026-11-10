/** Node-only DefSource (vitest, tools). Never import this from browser code. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DefSource } from './loader';

export async function listJsonFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), relPath);
      else if (e.name.endsWith('.json')) out.push(relPath);
    }
  }
  await walk(root, '');
  return out.sort();
}

/** `root` defaults to <repo>/data/defs resolved from the current working directory. */
export function fsDefSource(root = path.resolve(process.cwd(), 'data/defs')): DefSource {
  return {
    list: () => listJsonFiles(root),
    async read(rel) {
      try {
        return JSON.parse(await fs.readFile(path.join(root, rel), 'utf8')) as unknown;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new Error(`${rel}: ${(e as Error).message}`);
      }
    },
  };
}
