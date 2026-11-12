/**
 * Mechanical enforcement of the import and determinism rules of docs/ARCHITECTURE.md section 2
 * (lead-owned). Runs with the normal unit tests; every package lists it in its verify commands:
 *
 *   npx vitest run tools/dev/boundaries.test.ts
 *
 * It scans the source text of everything under src/, server/ and bots/, so it fails the moment a headless
 * package reaches for the DOM or a clock, a render package imports a sibling, browser code imports a Node
 * module, or server code finds its way into the client bundle - not weeks later as a non-reproducible
 * mission hash or a leaked server module.
 *
 * Every rule is a function over a list of source files, so the last block of this file can prove that each
 * rule fails on a planted violation (synthetic files, nothing is written to disk).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Directories whose TypeScript is scanned. */
const SCAN_ROOTS = ['src', 'server', 'bots'];

interface SourceFile {
  /** Path relative to the repo root, forward slashes. */
  rel: string;
  text: string;
  /** Text with comments and string/template literals blanked (for global-usage scans). */
  code: string;
  /** Module specifiers of static and dynamic imports. */
  imports: string[];
  /** Module specifiers of `new URL('<spec>', import.meta.url)` (worker entries): edges of the bundle, not imports. */
  urlRefs: string[];
}

function walk(dir: string, out: string[]): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p, out);
    } else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Remove comments and (unless `keepStrings`) the contents of string literals, keeping line structure, so
 * identifiers inside them are ignored.
 */
export function stripCommentsAndStrings(text: string, keepStrings = false): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += quote;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') {
          if (keepStrings) out += text.slice(i, i + 2);
          i++;
        } else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
          // An interpolation is code, not string: keep it (to its matching brace) so the scans see it.
          let depth = 1;
          let j = i + 2;
          while (j < n && depth > 0) {
            if (text[j] === '{') depth++;
            else if (text[j] === '}') depth--;
            j++;
          }
          out += `\${${stripCommentsAndStrings(text.slice(i + 2, j - 1), keepStrings)}}`;
          i = j - 1;
        } else if (keepStrings || text[i] === '\n') out += text[i];
        i++;
      }
      out += quote;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function parseImports(text: string): string[] {
  const specs: string[] = [];
  // The specifier may be quoted with ', " or a backtick (a template literal in a dynamic import: what is
  // captured then includes any ${...}, and the path in front of it still says where the import points).
  const re = /(?:\bimport\s+(?:type\s+)?(?:[^'"`()]*?\sfrom\s+)?|\bexport\s+(?:type\s+)?[^'"`()]*?\sfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g;
  for (const m of text.matchAll(re)) specs.push(m[2]!);
  return specs;
}

function parseUrlRefs(text: string): string[] {
  const specs: string[] = [];
  const re = /\bnew\s+URL\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g;
  for (const m of text.matchAll(re)) specs.push(m[2]!);
  return specs;
}

/** Build a SourceFile from text (the real tree and the planted-violation self-tests both go through this). */
function source(rel: string, text: string): SourceFile {
  const withStrings = stripCommentsAndStrings(text, true);
  return { rel, text, code: stripCommentsAndStrings(text), imports: parseImports(withStrings), urlRefs: parseUrlRefs(withStrings) };
}

/** Resolve a module specifier to a repo-relative path ("src/..."), or null for packages and node builtins. */
function resolveSpec(fromRel: string, spec: string): string | null {
  if (spec.startsWith('@/')) return `src/${spec.slice(2)}`;
  if (spec.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  return null;
}

const isTest = (rel: string): boolean => /\.test\.ts$/.test(rel) || rel.includes('/testing/') || rel.includes('/__tests__/');
const NODE_ONLY_FILE = /(^|\/)(fsSource|fsTileSource|node)(\.[a-z]+)?\.ts$|\.node\.ts$|\/node\//;
const under = (rel: string, dir: string): boolean => rel === dir || rel.startsWith(`${dir}/`);

const files: SourceFile[] = SCAN_ROOTS.flatMap((root) => walk(path.join(repoRoot, root), [])).map((file) =>
  source(path.relative(repoRoot, file).replace(/\\/g, '/'), fs.readFileSync(file, 'utf8')),
);

// ------------------------------------------------------------------------------------------- the rules

/**
 * Allowed import targets per source area (prefixes; a file may always import inside its own area). The most
 * specific area wins. `src/app` has no rule: only it knows every client subsystem.
 */
const RULES: { area: string; allow: string[]; note: string }[] = [
  { area: 'src/core', allow: [], note: 'src/core imports nothing outside src/core' },
  { area: 'src/gate', allow: [], note: 'src/gate imports nothing at all (it is inlined before the main bundle)' },
  { area: 'src/terrain', allow: ['src/core'], note: 'src/terrain imports src/core only' },
  { area: 'src/sim/orbit', allow: ['src/core', 'src/sim/orbit', 'src/sim/frames', 'src/sim/bodies', 'src/sim/nav'], note: 'orbital mechanics import src/core and each other only' },
  { area: 'src/sim/frames', allow: ['src/core', 'src/sim/orbit', 'src/sim/frames', 'src/sim/bodies', 'src/sim/nav'], note: 'orbital mechanics import src/core and each other only' },
  { area: 'src/sim/bodies', allow: ['src/core', 'src/sim/orbit', 'src/sim/frames', 'src/sim/bodies', 'src/sim/nav'], note: 'orbital mechanics import src/core and each other only' },
  { area: 'src/sim/nav', allow: ['src/core', 'src/sim/orbit', 'src/sim/frames', 'src/sim/bodies', 'src/sim/nav'], note: 'orbital mechanics import src/core and each other only' },
  { area: 'src/sim/vessel', allow: ['src/core', 'src/sim/vessel', 'src/sim/dynamics', 'src/sim/control'], note: 'vessel dynamics see the world only through VesselEnvironment' },
  { area: 'src/sim/dynamics', allow: ['src/core', 'src/sim/vessel', 'src/sim/dynamics', 'src/sim/control'], note: 'vessel dynamics see the world only through VesselEnvironment' },
  { area: 'src/sim/control', allow: ['src/core', 'src/sim/vessel', 'src/sim/dynamics', 'src/sim/control'], note: 'vessel dynamics see the world only through VesselEnvironment' },
  { area: 'src/sim', allow: ['src/core', 'src/sim'], note: 'src/sim reaches terrain only through the TerrainProvider contract in src/core, and never imports src/universe, src/session or src/client' },
  { area: 'src/universe', allow: ['src/core', 'src/sim'], note: 'src/universe imports src/core and the public APIs of src/sim; time and storage are injected' },
  { area: 'src/session', allow: ['src/core', 'src/sim', 'src/universe'], note: 'src/session imports src/core, src/sim and src/universe only' },
  { area: 'src/net', allow: ['src/core'], note: 'src/net imports src/core only' },
  { area: 'src/client', allow: ['src/core', 'src/sim', 'src/net'], note: 'src/client imports src/core, src/sim and src/net; never src/universe, src/session or server/' },
  { area: 'src/pilot', allow: ['src/core'], note: 'the pilot reaches a session only through the FlightSession contract in src/core' },
  { area: 'src/render/core', allow: ['src/core'], note: 'the render core imports src/core only' },
  { area: 'src/render/terrain', allow: ['src/core', 'src/render/core', 'src/terrain'], note: 'render packages never import each other' },
  { area: 'src/render/atmosphere', allow: ['src/core', 'src/render/core'], note: 'render packages never import each other' },
  { area: 'src/render/sky', allow: ['src/core', 'src/render/core'], note: 'render packages never import each other' },
  { area: 'src/render/ocean', allow: ['src/core', 'src/render/core'], note: 'render packages never import each other' },
  { area: 'src/render/vehicle', allow: ['src/core', 'src/render/core'], note: 'render packages never import each other (labs may use src/sim/vessel/public.ts)' },
  { area: 'src/render/cockpit', allow: ['src/core', 'src/render/core', 'src/ui'], note: 'the cockpit may use the navball/MFD factories of src/ui' },
  { area: 'src/render/vfx', allow: ['src/core', 'src/render/core'], note: 'render packages never import each other (labs may use src/sim/vessel/public.ts)' },
  { area: 'src/input', allow: ['src/core'], note: 'src/input imports src/core only' },
  { area: 'src/camera', allow: ['src/core'], note: 'src/camera imports src/core only' },
  { area: 'src/ui', allow: ['src/core', 'src/render/core'], note: 'src/ui imports src/core (+ render-core helpers)' },
  { area: 'src/map', allow: ['src/core', 'src/render/core'], note: 'src/map imports src/core (+ render-core helpers)' },
  { area: 'src/audio', allow: ['src/core'], note: 'src/audio imports src/core only' },
  { area: 'src/shell', allow: ['src/core', 'src/render/core', 'src/sim/vessel/public'], note: 'src/shell imports src/core (+ render-core helpers and the frozen vessel facade for the turntable); planning comes through PlanningService' },
  { area: 'src/bench', allow: ['src/core', 'src/render/core'], note: 'src/bench imports src/core (+ render-core helpers)' },
  { area: 'server', allow: ['src/core', 'src/sim', 'src/terrain', 'src/universe', 'src/net'], note: 'server/ imports src/core, src/sim, src/terrain, src/universe and src/net; never the client, the presentation or deploy/' },
];

/** Areas that may import anything EXCEPT these (a ban-list where the architecture gives one). */
const BANS: { area: string; never: string[]; note: string }[] = [
  { area: 'bots', never: ['src/render', 'src/ui', 'src/map', 'src/shell', 'src/audio', 'server', 'deploy'], note: 'bots/ are headless players: never the presentation, never server/' },
  { area: 'server', never: ['src/render', 'src/ui', 'src/map', 'src/shell', 'src/audio', 'src/client', 'bots', 'deploy'], note: 'server/ never imports the client, the presentation, bots/ or deploy/' },
  { area: 'src/sim', never: ['src/universe', 'src/session', 'src/client'], note: 'src/sim never imports its own host (src/universe, src/session) or src/client' },
  { area: 'src/client', never: ['src/universe', 'src/session', 'server'], note: 'src/client never imports src/universe, src/session or server/' },
];

/** Entry modules of the client bundle (index.html loads src/app/main.ts; the gate is inlined beside it). */
const CLIENT_ENTRIES = ['src/app/main.ts'];

function ruleFor(rel: string): (typeof RULES)[number] | null {
  let best: (typeof RULES)[number] | null = null;
  for (const r of RULES) if (under(rel, r.area) && (!best || r.area.length > best.area.length)) best = r;
  return best;
}

/** Layer rule: every file imports only what its area allows. */
function layerViolations(list: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const f of list) {
    const rule = ruleFor(f.rel);
    if (!rule) continue; // src/app knows everything; bots/ has a ban-list
    for (const spec of f.imports) {
      const target = resolveSpec(f.rel, spec);
      if (rule.area === 'src/gate') {
        // Nothing at all: no package, no builtin, nothing outside the gate's own files.
        if (target === null || !under(target, rule.area)) violations.push(`${f.rel} imports ${spec} (${rule.note})`);
        continue;
      }
      if (target === null) continue;
      if (under(target, rule.area) || rule.allow.some((a) => under(target, a))) continue;
      // A path outside the scanned roots (tools/, tests/, data/) is not a layer question, except from server/.
      if (!SCAN_ROOTS.some((r) => under(target, r)) && rule.area !== 'server') continue;
      violations.push(`${f.rel} imports ${spec} (${rule.note})`);
    }
  }
  return violations;
}

/** Ban rule: areas that must never import certain others. */
function banViolations(list: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const f of list) {
    for (const ban of BANS) {
      if (!under(f.rel, ban.area)) continue;
      for (const spec of f.imports) {
        const target = resolveSpec(f.rel, spec);
        if (target !== null && ban.never.some((n) => under(target, n))) violations.push(`${f.rel} imports ${spec} (${ban.note})`);
      }
    }
  }
  return violations;
}

/** Identifiers that make results depend on wall-clock time, randomness or a browser. */
const BANNED_HEADLESS: [RegExp, string][] = [
  [/\bMath\s*\.\s*random\b/, 'Math.random'],
  [/\bDate\s*\.\s*now\b/, 'Date.now'],
  [/\bnew\s+Date\b/, 'new Date'],
  [/\bperformance\s*\.\s*(now|mark|measure|timeOrigin)\b/, 'performance.*'],
  [/\b(window|document|navigator|localStorage|requestAnimationFrame)\b\s*[.([]/, 'DOM global'],
  [/\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/, 'timer'],
  [/\bGPU[A-Z]\w+\b/, 'WebGPU type'],
  // A bare Date() is the wall clock as a string; `new Date` is caught above.
  [/(?<!\bnew\s)(?<![.\w$])Date\s*\(/, 'Date()'],
  // crypto.randomUUID / getRandomValues are randomness; process.hrtime, process.env, process.memoryUsage are
  // the host; a Worker is a thread: none of them is a function of the tick and the inputs.
  [/\bcrypto\s*\.\s*\w+/, 'crypto.*'],
  [/\bprocess\s*\.\s*\w+/, 'process.*'],
  [/\bnew\s+(Shared)?Worker\b/, 'Worker'],
];
/** Sockets and storage: banned in headless code except the tile I/O modules of src/terrain. */
const BANNED_IO: [RegExp, string][] = [
  [/\b(WebSocket|EventSource|XMLHttpRequest|BroadcastChannel)\b/, 'socket'],
  [/\bfetch\s*\(/, 'fetch'],
  [/\b(sessionStorage|indexedDB|caches)\b\s*[.([]/, 'storage'],
  [/\bnavigator\s*\.\s*storage\b/, 'storage'],
];
const HEADLESS = ['src/sim', 'src/terrain', 'src/pilot', 'src/universe', 'src/session'];
/**
 * The modules of src/terrain whose whole purpose is tile I/O (fetch, packs, the OPFS cache, the file system).
 * They may fetch and may open the origin-private file system (`navigator.storage`); everything else of the
 * headless rule holds for them too (no clock, no timer, no other DOM global).
 */
const TERRAIN_IO = /^src\/terrain\/(tileSource|packSource|packIndex|opfsCache|fs[A-Z]\w*)\.ts$/;
const BANNED_TERRAIN_IO: [RegExp, string][] = BANNED_HEADLESS.map(([re, name]) =>
  name === 'DOM global' ? [/\b(window|document|localStorage|requestAnimationFrame)\b\s*[.([]|\bnavigator\s*\.\s*(?!storage\b)/, name] : [re, name],
);

/** Determinism rule: headless packages use no clock, no randomness, no DOM, no WebGPU, no socket, no storage. */
function headlessViolations(list: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const f of list) {
    if (!HEADLESS.some((d) => under(f.rel, d)) || isTest(f.rel)) continue;
    const banned = TERRAIN_IO.test(f.rel) ? BANNED_TERRAIN_IO : [...BANNED_HEADLESS, ...BANNED_IO];
    f.code.split('\n').forEach((line, i) => {
      for (const [re, name] of banned) if (re.test(line)) violations.push(`${f.rel}:${i + 1} uses ${name}`);
    });
  }
  return violations;
}

const NODE_BUILTIN = /^(node:|(fs|path|os|child_process|crypto|url|zlib|worker_threads|stream|util|net|http|https|http2|dgram|tls|cluster|events|buffer|readline|perf_hooks|timers|vm|async_hooks|process)(\/|$))/;
/** Node networking and threads: only server/ and bots/, whatever the file is called. */
const NODE_NETWORK = /^(node:)?(net|http|https|http2|tls|dgram|worker_threads|cluster)(\/|$)/;
/** Packages that only server/ and bots/ may import: Node networking and the database driver. */
const SERVER_ONLY_PACKAGE = /^(pg|pg-[\w-]+|ws|embedded-postgres|@aws-sdk\/.+)$/;
const isServerSide = (rel: string): boolean => under(rel, 'server') || under(rel, 'bots');
/** The file-system tile and definition sources that exist today: the only Node modules of the headless directories. */
const HEADLESS_FS_MODULE = /^src\/terrain\/fs[A-Z]\w*\.ts$/;
/** Directories in which the name of a file (`*.node.ts`, `node/`) does not make a Node import acceptable. */
const NO_NODE_DIRS = [...HEADLESS, 'src/net'];

/**
 * Node rule. server/ and bots/ may import anything of Node. Elsewhere:
 *  - Node networking and threads (net, http, https, http2, tls, dgram, worker_threads, cluster) are never
 *    imported, whatever the file is called;
 *  - in the headless directories and in src/net no Node builtin is imported at all, except by the
 *    file-system modules of src/terrain (`fs*.ts`); a `*.node.ts` name or a `node/` directory is no excuse
 *    there (a headless module receives time, storage and I/O as arguments; src/net runs in the browser);
 *  - in the rest of src/, Node builtins stay in fs*.ts, *.node.ts or node/;
 *  - the server-only packages are imported nowhere.
 * Test files may import Node (they run in Node), except the server-only packages.
 */
function nodeViolations(list: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const f of list) {
    if (isServerSide(f.rel)) continue;
    for (const spec of f.imports) {
      if (SERVER_ONLY_PACKAGE.test(spec)) {
        violations.push(`${f.rel} imports ${spec}: only server/ and bots/ import Node networking and the database driver`);
        continue;
      }
      if (isTest(f.rel) || !NODE_BUILTIN.test(spec)) continue;
      if (NODE_NETWORK.test(spec)) violations.push(`${f.rel} imports ${spec}: Node networking and threads belong to server/ and bots/ only`);
      else if (NO_NODE_DIRS.some((d) => under(f.rel, d))) {
        if (!HEADLESS_FS_MODULE.test(f.rel)) violations.push(`${f.rel} imports ${spec}: no Node builtin in a headless directory or in src/net (time, storage and I/O are injected)`);
      } else if (!NODE_ONLY_FILE.test(f.rel)) violations.push(`${f.rel} imports ${spec}: move it into a *.node.ts / fs*.ts module that browser code never imports`);
    }
  }
  return violations;
}

/** Browser-facing code never imports a node-only module. */
function nodeOnlyImportViolations(list: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const f of list) {
    if (isServerSide(f.rel) || isTest(f.rel) || NODE_ONLY_FILE.test(f.rel)) continue;
    for (const spec of f.imports) {
      const target = resolveSpec(f.rel, spec);
      if (target && NODE_ONLY_FILE.test(`${target}.ts`)) violations.push(`${f.rel} imports node-only module ${spec}`);
    }
  }
  return violations;
}

/** Find the file a resolved specifier names (`x`, `x.ts`, `x/index.ts`). */
function lookup(byRel: Map<string, SourceFile>, target: string): SourceFile | null {
  return byRel.get(target) ?? byRel.get(`${target}.ts`) ?? byRel.get(`${target}.tsx`) ?? byRel.get(`${target}/index.ts`) ?? null;
}

/**
 * Bundle rule: starting at the client entries and following imports and worker entries, the client bundle
 * never contains server/ or bots/, and contains src/universe only behind src/session (a path to src/universe
 * that does not pass through src/session is a violation).
 */
function clientBundleViolations(list: SourceFile[], entries: string[] = CLIENT_ENTRIES): string[] {
  const byRel = new Map(list.map((f) => [f.rel, f]));
  const violations: string[] = [];
  const seen = new Set<string>();
  const queue: { file: SourceFile; via: string }[] = [];
  for (const e of entries) {
    const f = byRel.get(e);
    if (f) queue.push({ file: f, via: e });
  }
  while (queue.length > 0) {
    const { file, via } = queue.pop()!;
    if (seen.has(file.rel)) continue;
    seen.add(file.rel);
    if (under(file.rel, 'server') || under(file.rel, 'bots')) {
      violations.push(`the client bundle contains ${file.rel} (reached through ${via})`);
      continue;
    }
    if (under(file.rel, 'src/universe')) {
      violations.push(`the client bundle reaches ${file.rel} outside src/session (through ${via})`);
      continue;
    }
    // What src/session imports is its own business (layer rule); the walk does not look behind it.
    if (under(file.rel, 'src/session')) continue;
    for (const spec of [...file.imports, ...file.urlRefs]) {
      const target = resolveSpec(file.rel, spec);
      if (target === null) continue;
      const next = lookup(byRel, target.replace(/\.(ts|tsx|js)$/, ''));
      if (next && !isTest(next.rel)) queue.push({ file: next, via: `${via} -> ${next.rel}` });
    }
  }
  return violations;
}

// --------------------------------------------------------------------------------------------- the tree

describe('architecture boundaries (docs/ARCHITECTURE.md section 2)', () => {
  it('finds the source tree', () => {
    expect(files.some((f) => f.rel === 'src/core/contracts/sim.ts')).toBe(true);
    expect(files.some((f) => f.rel === CLIENT_ENTRIES[0])).toBe(true);
  });

  it('parses imports and strips comments/strings correctly (self-test)', () => {
    const sample = "import a from 'x';\nimport type { B } from \"@/core/b\";\nexport * from './c';\nconst d = await import('./d');\n// import z from 'not-me'\n";
    expect(parseImports(sample)).toEqual(['x', '@/core/b', './c', './d', 'not-me']);
    expect(parseImports(stripCommentsAndStrings(sample, true))).toEqual(['x', '@/core/b', './c', './d']);
    const stripped = stripCommentsAndStrings("const s = 'Math.random()'; // Date.now()\n/* performance.now() */ let t = `document`;\nMath.random();");
    expect(stripped).not.toMatch(/Date\.now|performance\.now|document/);
    expect(stripped.match(/Math\.random/g)).toHaveLength(1);
    expect(resolveSpec('src/sim/world/a.ts', '../../terrain/x')).toBe('src/terrain/x');
    expect(resolveSpec('src/sim/world/a.ts', '@/core/math')).toBe('src/core/math');
    expect(resolveSpec('server/roles/a.ts', '../../src/sim/island/api')).toBe('src/sim/island/api');
    expect(resolveSpec('src/sim/world/a.ts', 'node:fs')).toBeNull();
    expect(parseUrlRefs("const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });")).toEqual(['./tileWorker.ts']);
  });

  it('every package imports only what its layer allows', () => {
    expect(layerViolations(files)).toEqual([]);
  });

  it('nothing imports what its area must never import (server, bots, sim, client)', () => {
    expect(banViolations(files)).toEqual([]);
  });

  it('headless packages are deterministic and free of DOM, WebGPU, sockets and storage', () => {
    expect(headlessViolations(files)).toEqual([]);
  });

  it('only node-only modules import Node builtins; only server/ and bots/ import the server packages', () => {
    expect(nodeViolations(files)).toEqual([]);
  });

  it('browser-facing code never imports a node-only module', () => {
    expect(nodeOnlyImportViolations(files)).toEqual([]);
  });

  it('the client bundle contains no server/, no bots/, and src/universe only behind src/session', () => {
    expect(clientBundleViolations(files)).toEqual([]);
  });

  it('nothing under src/, server/ or bots/ mentions an API key variable', () => {
    const keyNames = /\b(OPENAI_API_KEY|HF_TOKEN|ELEVENLABS_API_KEY)\b/;
    const hits = files.filter((f) => keyNames.test(f.text)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });
});

// ------------------------------------------------------------------------------ planted violations

/** A synthetic file that imports the given specifiers. */
const importing = (rel: string, ...specs: string[]): SourceFile => source(rel, specs.map((s, i) => `import x${i} from '${s}';`).join('\n'));
const code = (rel: string, text: string): SourceFile => source(rel, text);

describe('each rule fails on a planted violation', () => {
  const layerCases: [string, SourceFile][] = [
    ['src/universe imports src/terrain', importing('src/universe/directory.ts', '@/terrain/provider')],
    ['src/universe imports src/session', importing('src/universe/directory.ts', '../session/index')],
    ['src/universe imports src/net', importing('src/universe/clock.ts', '@/net/codec')],
    ['src/session imports src/client', importing('src/session/index.ts', '@/client/net/netSession')],
    ['src/session imports src/render', importing('src/session/local.ts', '@/render/core/renderer')],
    ['src/net imports src/sim', importing('src/net/codec.ts', '@/sim/island/api')],
    ['src/net imports src/universe', importing('src/net/session.ts', '../universe/rules')],
    ['src/client imports src/universe', importing('src/client/net/netSession.ts', '@/universe/directory')],
    ['src/client imports src/session', importing('src/client/stores.ts', '@/session/index')],
    ['src/client imports server/', importing('src/client/net/netSession.ts', '../../../server/gateway')],
    ['src/client imports src/render', importing('src/client/stores.ts', '@/render/core/renderer')],
    ['src/shell imports src/sim', importing('src/shell/hangar.ts', '@/sim/vessel/analyze')],
    ['src/shell imports src/client', importing('src/shell/state.ts', '@/client/stores')],
    ['src/bench imports src/sim', importing('src/bench/solver.ts', '@/sim/orbit/kepler')],
    ['src/bench imports src/ui', importing('src/bench/shots.ts', '@/ui/hud/hud')],
    ['src/gate imports src/core', importing('src/gate/gate.ts', '@/core/gpu/device')],
    ['src/gate imports a package', importing('src/gate/gate.ts', 'some-package')],
    ['src/sim imports src/universe', importing('src/sim/island/api.ts', '@/universe/rules')],
    ['src/sim imports src/session', importing('src/sim/view/readouts.ts', '@/session/index')],
    ['src/sim imports src/client', importing('src/sim/orbit/kepler.ts', '@/client/planning')],
    ['server imports src/render', importing('server/roles/shard.ts', '../../src/render/core/renderer')],
    ['server imports src/client', importing('server/gateway/index.ts', '../../src/client/net/netSession')],
    ['server imports deploy/', importing('server/roles/api.ts', '../../deploy/roles/shell')],
    ['server imports src/session', importing('server/roles/dir.ts', '../../src/session/index')],
  ];
  it.each(layerCases)('layer rule: %s', (_name, planted) => {
    expect(layerViolations([planted]).length + banViolations([planted]).length).toBeGreaterThan(0);
  });

  const banCases: [string, SourceFile][] = [
    ['bots imports src/render', importing('bots/fleet/bot.ts', '../../src/render/core/renderer')],
    ['bots imports src/ui', importing('bots/fleet/bot.ts', '../../src/ui/hud/hud')],
    ['bots imports src/map', importing('bots/bot.ts', '../src/map/scene')],
    ['bots imports src/shell', importing('bots/bot.ts', '../src/shell/state')],
    ['bots imports src/audio', importing('bots/bot.ts', '../src/audio/engine')],
    ['server imports src/ui', importing('server/roles/api.ts', '../../src/ui/format')],
    ['server imports src/map', importing('server/roles/api.ts', '../../src/map/scene')],
    ['server imports src/shell', importing('server/roles/api.ts', '../../src/shell/state')],
    ['server imports src/audio', importing('server/roles/api.ts', '../../src/audio/engine')],
  ];
  it.each(banCases)('ban rule: %s', (_name, planted) => {
    expect(banViolations([planted]).length).toBeGreaterThan(0);
  });

  it('the allowed edges of the new areas pass', () => {
    const allowed = [
      importing('src/universe/directory.ts', '@/core/contracts/net', '@/sim/orbit', './clock'),
      importing('src/session/index.ts', '@/core/contracts/session', '@/sim', '@/universe/host'),
      importing('src/net/codec.ts', '@/core/contracts/net', './framing'),
      importing('src/client/net/netSession.ts', '@/core/contracts/session', '@/sim/island/api', '@/net/session'),
      importing('src/shell/hangar.ts', '@/core/contracts/vehicle', '@/render/core/public', '@/sim/vessel/public'),
      importing('src/bench/solver.ts', '@/core/contracts/render', '@/render/core/public'),
      importing('src/gate/gate.ts', './blockPage'),
      importing('server/roles/shard.ts', '../../src/sim/island/api', '../../src/universe/host', '../../src/terrain', '../../src/net/session', 'pg', 'node:worker_threads'),
      importing('bots/fleet/bot.ts', '../../src/client/net/netSession', '../../src/pilot', 'ws'),
    ];
    expect(layerViolations(allowed)).toEqual([]);
    expect(banViolations(allowed)).toEqual([]);
    expect(nodeViolations(allowed)).toEqual([]);
  });

  const headlessCases: [string, SourceFile][] = [
    ['src/universe reads the wall clock', code('src/universe/expiry.ts', 'export const now = () => Date.now();')],
    ['src/universe uses a timer', code('src/universe/clock.ts', 'setTimeout(() => tick(), 8);')],
    ['src/universe uses Math.random', code('src/universe/ids.ts', 'const id = Math.random();')],
    ['src/session touches the DOM', code('src/session/local.ts', "const el = document.getElementById('x');")],
    ['src/session uses performance.now', code('src/session/local.ts', 'const t = performance.now();')],
    ['src/session opens a socket', code('src/session/local.ts', 'const s = new WebSocket(url);')],
    ['src/universe uses storage', code('src/universe/store.ts', "localStorage.setItem('k', v);")],
    ['src/universe uses IndexedDB', code('src/universe/store.ts', "const r = indexedDB.open('u');")],
    ['src/sim fetches', code('src/sim/orbit/ephemeris.ts', 'const r = await fetch(url);')],
    ['src/pilot opens a socket', code('src/pilot/generic/common.ts', 'new WebSocket(u);')],
    ['src/terrain provider uses a socket', code('src/terrain/provider.ts', 'new WebSocket(u);')],
    ['src/universe draws a random id', code('src/universe/ids.ts', 'const id = crypto.randomUUID();')],
    ['src/universe draws random bytes', code('src/universe/ids.ts', 'crypto.getRandomValues(buf);')],
    ['src/session reads the high-resolution clock', code('src/session/local.ts', 'const t = process.hrtime.bigint();')],
    ['src/session reads the environment', code('src/session/local.ts', "const debug = process.env.DEBUG === '1';")],
    ['src/universe defers with setImmediate', code('src/universe/scheduler.ts', 'setImmediate(() => step());')],
    ['src/universe defers with queueMicrotask', code('src/universe/scheduler.ts', 'queueMicrotask(flush);')],
    ['src/session starts a worker', code('src/session/local.ts', 'const w = new Worker(url);')],
    ['src/universe calls Date()', code('src/universe/expiry.ts', 'const stamp = Date();')],
    ['src/sim calls Date() in an expression', code('src/sim/world/log.ts', 'log(`at ${Date()}`, x);')],
    ['src/sim reads process.memoryUsage', code('src/sim/island/stats.ts', 'const m = process.memoryUsage();')],
    ['src/pilot uses crypto', code('src/pilot/generic/common.ts', 'const k = crypto.subtle;')],
  ];
  it.each(headlessCases)('determinism rule: %s', (_name, planted) => {
    expect(headlessViolations([planted]).length).toBeGreaterThan(0);
  });

  it('the tile I/O modules of src/terrain may fetch and use the OPFS cache, and stay otherwise headless', () => {
    expect(headlessViolations([code('src/terrain/tileSource.ts', 'const r = await fetch(url);'), code('src/terrain/opfsCache.ts', 'const root = await navigator.storage.getDirectory();')])).toEqual([]);
    expect(headlessViolations([code('src/terrain/opfsCache.ts', 'const a = await navigator.gpu.requestAdapter();')])).toEqual(['src/terrain/opfsCache.ts:1 uses DOM global']);
    expect(headlessViolations([code('src/terrain/packSource.ts', 'setTimeout(retry, 500);')])).toEqual(['src/terrain/packSource.ts:1 uses timer']);
    expect(headlessViolations([code('src/terrain/packSource.ts', 'const r = await fetch(url, { headers });')])).toEqual([]);
    expect(headlessViolations([code('src/terrain/packSource.ts', 'const t = Date.now();')]).length).toBe(1);
  });

  const nodeCases: [string, SourceFile][] = [
    ['src/client imports the database driver', importing('src/client/stores.ts', 'pg')],
    ['src/net imports ws', importing('src/net/transport.ts', 'ws')],
    ['src/universe imports node:fs', importing('src/universe/storage.ts', 'node:fs')],
    ['src/session imports worker_threads', importing('src/session/local.ts', 'node:worker_threads')],
    ['src/net imports node:net', importing('src/net/transport.ts', 'node:net')],
    ['src/core imports the S3 client', importing('src/core/defs/loader.ts', '@aws-sdk/client-s3')],
    // A file name is no excuse in the headless directories and in src/net.
    ['src/universe/*.node.ts imports node:fs', importing('src/universe/storage.node.ts', 'node:fs')],
    ['src/universe/node/ imports node:fs', importing('src/universe/node/storage.ts', 'node:fs')],
    ['src/universe/fsStore.ts imports node:fs', importing('src/universe/fsStore.ts', 'node:fs')],
    ['src/session/*.node.ts imports node:worker_threads', importing('src/session/pool.node.ts', 'node:worker_threads')],
    ['src/session/*.node.ts imports node:fs', importing('src/session/save.node.ts', 'node:fs')],
    ['src/net/*.node.ts imports node:net', importing('src/net/tcp.node.ts', 'node:net')],
    ['src/net/*.node.ts imports node:http', importing('src/net/upgrade.node.ts', 'node:http')],
    ['src/net/*.node.ts imports node:fs', importing('src/net/fixtures.node.ts', 'node:fs')],
    ['src/sim imports node:crypto', importing('src/sim/vessel/ids.node.ts', 'node:crypto')],
    ['src/pilot imports node:path', importing('src/pilot/node/log.ts', 'node:path')],
    // Networking and threads: nowhere outside server/ and bots/, whatever the file is called.
    ['src/terrain fs module imports node:worker_threads', importing('src/terrain/fsTileSource.ts', 'node:worker_threads')],
    ['src/core *.node.ts imports node:http', importing('src/core/defs/remote.node.ts', 'node:http')],
    ['src/app node/ imports node:net', importing('src/app/node/probe.ts', 'node:net')],
    ['src/client imports node:https', importing('src/client/net/fetch.node.ts', 'node:https')],
    ['src/render imports node:tls', importing('src/render/core/x.node.ts', 'node:tls')],
    ['src/core imports dgram', importing('src/core/gpu/udp.node.ts', 'dgram')],
    ['src/core imports cluster', importing('src/core/defs/fork.node.ts', 'node:cluster')],
    ['src/ui imports node:fs outside a node-only module', importing('src/ui/format.ts', 'node:fs')],
  ];
  it.each(nodeCases)('node rule: %s', (_name, planted) => {
    expect(nodeViolations([planted]).length).toBeGreaterThan(0);
  });

  it('node rule: what is allowed stays allowed', () => {
    expect(
      nodeViolations([
        importing('src/terrain/fsTileSource.ts', 'node:fs', 'node:path'),
        importing('src/terrain/fsPackSource.ts', 'node:fs'),
        importing('src/core/defs/fsSource.ts', 'node:fs', 'node:path'),
        importing('src/core/geo/dump.node.ts', 'node:fs', 'node:zlib'),
        importing('src/universe/expiry.test.ts', 'node:fs'),
        importing('server/roles/shard.ts', 'node:worker_threads', 'node:net', 'pg'),
        importing('bots/fleet/bot.ts', 'node:http', 'ws'),
      ]),
    ).toEqual([]);
  });

  it('a dynamic import written as a template literal is an import', () => {
    expect(parseImports(stripCommentsAndStrings('const m = await import(`../universe/rules`);', true))).toEqual(['../universe/rules']);
    const planted = code('src/sim/island/api.ts', 'export const load = async (name: string) => import(`../../universe/${name}`);');
    expect(planted.imports).toEqual(['../../universe/${name}']);
    expect(layerViolations([planted]).length + banViolations([planted]).length).toBeGreaterThan(0);
    expect(layerViolations([code('src/client/replica.ts', 'const s = await import(`@/session/index`);')]).length).toBeGreaterThan(0);
    expect(nodeViolations([code('src/universe/storage.ts', 'const fs = await import(`node:fs`);')]).length).toBeGreaterThan(0);
  });

  it('bundle rule: the client entry reaching server/, bots/ or src/universe outside src/session is caught', () => {
    const entry = importing('src/app/main.ts', './game');
    const viaServer = [entry, importing('src/app/game.ts', '@/client/net/netSession'), importing('src/client/net/netSession.ts', '../../../server/gateway/index'), importing('server/gateway/index.ts', 'node:http')];
    expect(clientBundleViolations(viaServer)).toEqual(['the client bundle contains server/gateway/index.ts (reached through src/app/main.ts -> src/app/game.ts -> src/client/net/netSession.ts -> server/gateway/index.ts)']);
    const viaBots = [entry, importing('src/app/game.ts', '../../bots/fleet/bot'), importing('bots/fleet/bot.ts', '@/pilot')];
    expect(clientBundleViolations(viaBots).length).toBe(1);
    const universeDirect = [entry, importing('src/app/game.ts', '@/universe/directory'), importing('src/universe/directory.ts', '@/core/contracts/net')];
    expect(clientBundleViolations(universeDirect)).toEqual(['the client bundle reaches src/universe/directory.ts outside src/session (through src/app/main.ts -> src/app/game.ts -> src/universe/directory.ts)']);
    // Through a worker entry.
    const viaWorker = [entry, code('src/app/game.ts', "const w = new Worker(new URL('./planningWorker.ts', import.meta.url));"), importing('src/app/planningWorker.ts', '@/universe/screening')];
    expect(clientBundleViolations([...viaWorker, importing('src/universe/screening.ts', '@/sim/orbit')]).length).toBe(1);
    // Behind src/session it is allowed.
    const throughSession = [entry, importing('src/app/game.ts', '@/session'), importing('src/session/index.ts', '@/universe/host'), importing('src/universe/host.ts', '@/sim')];
    expect(clientBundleViolations(throughSession)).toEqual([]);
  });
});
