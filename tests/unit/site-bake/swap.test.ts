/**
 * site-bake: the swap of a staged region into a live tile set is purely additive and atomic for readers
 * (tools/bake/earth/swaptree.py, the code the earth bake's `bake.py swap` runs). A synthetic tile set is built in
 * a temporary directory; the real swap runs in a separate Python process (standard library only) while this test
 * reads the manifest over and over and checks that every tile the manifest it read promises exists at that
 * moment. Also: live files are never changed, and a staged file that would replace a different live file stops
 * the swap before anything moves.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SWAP = path.join(REPO, 'tools', 'bake', 'earth', 'swaptree.py');

function python(): string {
  if (process.env.PYTHON) return process.env.PYTHON;
  const venv = path.join(REPO, 'data', 'cache', 'earth', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

interface Rect { face: number; x0: number; y0: number; x1: number; y1: number }
interface Manifest { version: string; layers: Record<string, { ext: string; coverage: Record<string, Rect[]> }> }

/** Every tile path (relative to the tile set) a synthetic manifest promises. */
function promised(m: Manifest): string[] {
  const out: string[] = [];
  for (const [layer, L] of Object.entries(m.layers)) {
    for (const [lv, rects] of Object.entries(L.coverage)) {
      for (const r of rects) for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) out.push(`${layer}/${r.face}/${lv}/${x}/${y}.${L.ext}`);
    }
  }
  return out;
}

function writeTiles(root: string, rels: string[], tag: string): void {
  for (const rel of rels) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${tag}:${rel}`);
  }
}

function treeHashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(root, p).split(path.sep).join('/'), createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

function filesUnder(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  walk(root);
  return n;
}

function runSwap(stage: string, live: string, manifestFile: string, delayMs: number): { done: Promise<{ code: number; out: string }> } {
  const child = spawn(python(), ['-I', SWAP, '--stage', stage, '--live', live, '--manifest', manifestFile, '--delay-ms', String(delayMs)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b.toString()));
  child.stderr.on('data', (b: Buffer) => (out += b.toString()));
  return { done: new Promise((resolve) => child.on('close', (code) => resolve({ code: code ?? -1, out }))) };
}

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** A live tile set (face 1, levels 8-9, plus global files) and a staged region (face 2, levels 8-11, two layers). */
function scenario() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-bake-swap-'));
  tmpRoots.push(tmp);
  const live = path.join(tmp, 'tiles', 'earth');
  const stage = path.join(tmp, 'stage', 'tiles');
  const oldM: Manifest = {
    version: 'old',
    layers: {
      height: { ext: 'hgt', coverage: { '8': [{ face: 1, x0: 10, y0: 10, x1: 13, y1: 13 }], '9': [{ face: 1, x0: 20, y0: 20, x1: 27, y1: 27 }] } },
      albedo: { ext: 'webp', coverage: { '8': [{ face: 1, x0: 10, y0: 10, x1: 13, y1: 13 }] } },
    },
  };
  const newRects: Record<string, Rect[]> = {
    '8': [{ face: 2, x0: 40, y0: 40, x1: 43, y1: 43 }],
    '9': [{ face: 2, x0: 80, y0: 80, x1: 87, y1: 87 }],
    '10': [{ face: 2, x0: 160, y0: 160, x1: 175, y1: 175 }],
    '11': [{ face: 2, x0: 320, y0: 320, x1: 343, y1: 343 }],
  };
  const newM: Manifest = JSON.parse(JSON.stringify(oldM)) as Manifest;
  newM.version = 'new';
  for (const layer of ['height', 'albedo'] as const) {
    for (const [lv, rects] of Object.entries(newRects)) (newM.layers[layer]!.coverage[lv] ??= []).push(...rects);
  }
  writeTiles(live, promised(oldM), 'live');
  writeTiles(live, ['height/2/7/5/5.hgt', 'globals/cloudCoverage.png'], 'live');
  const added = promised(newM).filter((p) => !promised(oldM).includes(p));
  writeTiles(stage, added, 'staged');
  fs.writeFileSync(path.join(live, 'manifest.json'), JSON.stringify(oldM));
  const manifestFile = path.join(tmp, 'new-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(newM));
  return { tmp, live, stage, oldM, newM, added, manifestFile };
}

describe('site-bake: staged tiles are swapped into the live tile set additively and atomically', () => {
  it('a reader that loads the manifest at any moment of the swap finds every tile it promises; no live file changes', async () => {
    const s = scenario();
    const before = treeHashes(s.live);
    const run = runSwap(s.stage, s.live, s.manifestFile, 25);
    let finished = false;
    let result: { code: number; out: string } | null = null;
    void run.done.then((r) => {
      finished = true;
      result = r;
    });
    const seen = new Set<string>();
    let reads = 0;
    let transient = 0;
    const violations: string[] = [];
    while (!finished || reads === 0) {
      let m: Manifest;
      try {
        m = JSON.parse(fs.readFileSync(path.join(s.live, 'manifest.json'), 'utf8')) as Manifest;
      } catch {
        transient++; // the instant of the rename on Windows: the reader retries, it never sees a partial file
        await new Promise((r) => setImmediate(r));
        continue;
      }
      reads++;
      seen.add(m.version);
      for (const rel of promised(m)) if (!fs.existsSync(path.join(s.live, rel))) violations.push(`${m.version}: ${rel}`);
      await new Promise((r) => setImmediate(r));
    }
    const r = result as unknown as { code: number; out: string };
    expect(r.code, r.out).toBe(0);
    expect(violations.slice(0, 5)).toEqual([]);
    expect(seen.has('old'), 'the reader read the manifest while the tiles were being moved').toBe(true);
    expect(reads).toBeGreaterThan(5);
    expect(transient).toBeLessThan(reads);
    const final = JSON.parse(fs.readFileSync(path.join(s.live, 'manifest.json'), 'utf8')) as Manifest;
    expect(final.version).toBe('new');
    for (const rel of promised(final)) expect(fs.existsSync(path.join(s.live, rel)), rel).toBe(true);
    const after = treeHashes(s.live);
    for (const [rel, h] of before) if (rel !== 'manifest.json') expect(after.get(rel), rel).toBe(h);
    expect(after.size).toBe(before.size + s.added.length);
    expect(filesUnder(s.stage)).toBe(0);
  }, 120_000);

  it('a staged file in an existing live directory is added; one that would replace a different live file stops the swap before anything moves', async () => {
    const s = scenario();
    // a new tile in an existing live directory, and an identical copy of a live tile: both fine
    writeTiles(s.stage, ['height/1/8/10/14.hgt'], 'staged');
    fs.mkdirSync(path.join(s.stage, 'height/1/8/11'), { recursive: true });
    fs.copyFileSync(path.join(s.live, 'height/1/8/11/11.hgt'), path.join(s.stage, 'height/1/8/11/11.hgt'));
    const ok = await runSwap(s.stage, s.live, s.manifestFile, 0).done;
    expect(ok.code, ok.out).toBe(0);
    expect(fs.readFileSync(path.join(s.live, 'height/1/8/10/14.hgt'), 'utf8')).toBe('staged:height/1/8/10/14.hgt');
    expect(fs.readFileSync(path.join(s.live, 'height/1/8/11/11.hgt'), 'utf8')).toBe('live:height/1/8/11/11.hgt');

    const t = scenario();
    writeTiles(t.stage, ['height/1/8/12/12.hgt'], 'different');
    const before = treeHashes(t.live);
    const staged = filesUnder(t.stage);
    const refused = await runSwap(t.stage, t.live, t.manifestFile, 0).done;
    expect(refused.code, refused.out).toBe(2);
    expect(refused.out).toMatch(/swap refused/);
    expect(treeHashes(t.live)).toEqual(before);
    expect(filesUnder(t.stage)).toBe(staged);
  }, 120_000);
});
