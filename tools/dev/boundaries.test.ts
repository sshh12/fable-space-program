/**
 * Mechanical enforcement of the import and determinism rules of docs/ARCHITECTURE.md section 2
 * (lead-owned). Runs with the normal unit tests; every package lists it in its verify commands:
 *
 *   npx vitest run tools/dev/boundaries.test.ts
 *
 * It scans the source text of everything under src/ (and the import statements of labs/ and tests/), so it
 * fails the moment a headless package reaches for the DOM or a clock, a render package imports a sibling,
 * or browser code imports a Node module - not weeks later as a non-reproducible mission hash.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcRoot = path.join(repoRoot, 'src');

interface SourceFile {
  /** Path relative to the repo root, forward slashes. */
  rel: string;
  text: string;
  /** Text with comments and string/template literals blanked (for global-usage scans). */
  code: string;
  /** Module specifiers of static and dynamic imports. */
  imports: string[];
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
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
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
  const re = /(?:\bimport\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s+)?|\bexport\s+(?:type\s+)?[^'"()]*?\sfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
  for (const m of text.matchAll(re)) specs.push(m[2]!);
  return specs;
}

function load(file: string): SourceFile {
  const text = fs.readFileSync(file, 'utf8');
  return { rel: path.relative(repoRoot, file).replace(/\\/g, '/'), text, code: stripCommentsAndStrings(text), imports: parseImports(stripCommentsAndStrings(text, true)) };
}

/** Resolve a module specifier to a repo-relative path ("src/..."), or null for packages and node builtins. */
function resolveSpec(fromRel: string, spec: string): string | null {
  if (spec.startsWith('@/')) return `src/${spec.slice(2)}`;
  if (spec.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  return null;
}

const isTest = (rel: string): boolean => /\.test\.ts$/.test(rel) || rel.includes('/testing/') || rel.includes('/__tests__/');
const NODE_ONLY_FILE = /(^|\/)(fsSource|fsTileSource|node)(\.[a-z]+)?\.ts$|\.node\.ts$|\/node\//;

const files = walk(srcRoot, []).map(load);
const under = (rel: string, dir: string): boolean => rel === dir || rel.startsWith(`${dir}/`);

/** Allowed import targets per source area (prefixes under src/). `self` is always allowed. */
const RULES: { area: string; allow: string[]; note: string }[] = [
  { area: 'src/core', allow: [], note: 'src/core imports nothing outside src/core' },
  { area: 'src/terrain', allow: ['src/core'], note: 'src/terrain imports src/core only' },
  { area: 'src/sim/orbit', allow: ['src/core', 'src/sim/orbit', 'src/sim/frames', 'src/sim/bodies', 'src/sim/nav'], note: 'orbital mechanics import src/core and each other only' },
  { area: 'src/sim/frames', allow: ['src/core', 'src/sim/orbit', 'src/sim/frames', 'src/sim/bodies', 'src/sim/nav'], note: 'orbital mechanics import src/core and each other only' },
  { area: 'src/sim/bodies', allow: ['src/core', 'src/sim/orbit', 'src/sim/frames', 'src/sim/bodies', 'src/sim/nav'], note: 'orbital mechanics import src/core and each other only' },
  { area: 'src/sim/nav', allow: ['src/core', 'src/sim/orbit', 'src/sim/frames', 'src/sim/bodies', 'src/sim/nav'], note: 'orbital mechanics import src/core and each other only' },
  { area: 'src/sim/vessel', allow: ['src/core', 'src/sim/vessel', 'src/sim/dynamics', 'src/sim/control'], note: 'vessel dynamics see the world only through VesselEnvironment' },
  { area: 'src/sim/dynamics', allow: ['src/core', 'src/sim/vessel', 'src/sim/dynamics', 'src/sim/control'], note: 'vessel dynamics see the world only through VesselEnvironment' },
  { area: 'src/sim/control', allow: ['src/core', 'src/sim/vessel', 'src/sim/dynamics', 'src/sim/control'], note: 'vessel dynamics see the world only through VesselEnvironment' },
  { area: 'src/sim', allow: ['src/core', 'src/sim'], note: 'src/sim reaches terrain only through the TerrainProvider contract in src/core' },
  { area: 'src/pilot', allow: ['src/core'], note: 'the pilot reaches the sim only through the Sim contract in src/core' },
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
];

function ruleFor(rel: string): (typeof RULES)[number] | null {
  let best: (typeof RULES)[number] | null = null;
  for (const r of RULES) if (under(rel, r.area) && (!best || r.area.length > best.area.length)) best = r;
  return best;
}

describe('architecture boundaries (docs/ARCHITECTURE.md section 2)', () => {
  it('finds the source tree', () => {
    expect(files.some((f) => f.rel === 'src/core/contracts/sim.ts')).toBe(true);
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
    expect(resolveSpec('src/sim/world/a.ts', 'node:fs')).toBeNull();
  });

  it('every package imports only what its layer allows', () => {
    const violations: string[] = [];
    for (const f of files) {
      const rule = ruleFor(f.rel);
      if (!rule) continue; // src/app knows everything
      for (const spec of f.imports) {
        const target = resolveSpec(f.rel, spec);
        if (target === null || !target.startsWith('src/')) continue;
        if (under(target, rule.area) || rule.allow.some((a) => under(target, a))) continue;
        violations.push(`${f.rel} imports ${spec} (${rule.note})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('headless packages are deterministic and DOM-free', () => {
    // Identifiers that make results depend on wall-clock time, randomness or a browser.
    const banned: [RegExp, string][] = [
      [/\bMath\s*\.\s*random\b/, 'Math.random'],
      [/\bDate\s*\.\s*now\b/, 'Date.now'],
      [/\bnew\s+Date\b/, 'new Date'],
      [/\bperformance\s*\.\s*(now|mark|measure|timeOrigin)\b/, 'performance.*'],
      [/\b(window|document|navigator|localStorage|requestAnimationFrame)\b\s*[.([]/, 'DOM global'],
      [/\b(setTimeout|setInterval)\s*\(/, 'timer'],
      [/\bGPU[A-Z]\w+\b/, 'WebGPU type'],
    ];
    const headless = ['src/sim', 'src/terrain', 'src/pilot'];
    const violations: string[] = [];
    for (const f of files) {
      if (!headless.some((d) => under(f.rel, d)) || isTest(f.rel)) continue;
      const lines = f.code.split('\n');
      lines.forEach((line, i) => {
        for (const [re, name] of banned) if (re.test(line)) violations.push(`${f.rel}:${i + 1} uses ${name}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('only node-only modules import Node builtins', () => {
    const builtin = /^(node:|fs$|fs\/|path$|os$|child_process$|crypto$|url$|zlib$|worker_threads$|stream$|util$)/;
    const violations: string[] = [];
    for (const f of files) {
      if (isTest(f.rel) || NODE_ONLY_FILE.test(f.rel)) continue;
      for (const spec of f.imports) if (builtin.test(spec)) violations.push(`${f.rel} imports ${spec}: move it into a *.node.ts / fs*.ts module that browser code never imports`);
    }
    expect(violations).toEqual([]);
  });

  it('browser-facing code never imports a node-only module', () => {
    const violations: string[] = [];
    for (const f of files) {
      if (isTest(f.rel) || NODE_ONLY_FILE.test(f.rel)) continue;
      for (const spec of f.imports) {
        const target = resolveSpec(f.rel, spec);
        if (target && NODE_ONLY_FILE.test(`${target}.ts`)) violations.push(`${f.rel} imports node-only module ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('nothing under src/ or public/ mentions an API key variable', () => {
    const keyNames = /\b(OPENAI_API_KEY|HF_TOKEN|ELEVENLABS_API_KEY)\b/;
    const hits = files.filter((f) => keyNames.test(f.text)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });
});
