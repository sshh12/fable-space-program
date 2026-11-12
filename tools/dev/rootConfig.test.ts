/**
 * The lead's root configuration and tools, checked without starting a browser, a build or a stack:
 * the stub scan's logic (a planted TODO is caught), the endpoint-document plugin, globalSetup under
 * STACK_URL, the vitest include per suite switch, the Playwright projects, the scripts and ignore entries
 * the work packages are told to rely on (docs/handoff/lead-baseline-v2.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error a plain .mjs tool without type declarations
import { judge, scan } from './check-stubs.mjs';
import { ENDPOINTS_PATH, stackEndpointsPlugin } from './stackEndpointsPlugin';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Finding {
  file: string;
  line: number;
  word: string;
  text: string;
}
const scanText = (filesByName: Record<string, string>): Finding[] => scan(Object.keys(filesByName), (f: string) => filesByName[f]!, (f: string) => filesByName[f]!.length) as Finding[];

describe('check-stubs', () => {
  it('fails on a planted TODO, FIXME, stub and placeholder', () => {
    const findings = scanText({
      'src/sim/island/step.ts': 'export function step() {\n  // TODO: contact pass\n  return 0;\n}\n',
      'server/roles/api.ts': 'const x = 1; // FIXME before release\n',
      'src/universe/expiry.ts': '/** Stubbed until the directory exists. */\nexport const sweep = () => {};\n',
      'data/defs/parts/dock-port-c.json': '{ "visual": "placeholder" }\n',
      'src/ok.ts': 'export const methodology = "autodidact"; // todo-list apps are fine, so is a stubborn bug\n',
    });
    expect(findings.map((f) => `${f.file}:${f.line}:${f.word}`)).toEqual([
      'src/sim/island/step.ts:2:TODO',
      'server/roles/api.ts:1:FIXME',
      'src/universe/expiry.ts:1:stub',
      'data/defs/parts/dock-port-c.json:1:placeholder',
    ]);
    const { open, stale } = judge(findings, []);
    expect(open).toHaveLength(4);
    expect(stale).toEqual([]);
  });

  it('allows exactly what the allow-list names, and reports an entry nothing uses', () => {
    const findings = scanText({
      'data/defs/bodies/mimas.json': '{ "note": "placeholder visuals" }\n',
      'data/defs/bodies/earth.json': '{ "note": "placeholder visuals" }\n',
      'src/ui/menu/input.ts': 'el.placeholder = "CALLSIGN";\n',
    });
    const allow = [
      { path: 'data/defs/bodies/', except: ['data/defs/bodies/earth', 'data/defs/bodies/moon'], word: 'placeholder', standing: true, reason: 'simple bodies' },
      { path: 'src/ui/menu/input.ts', word: 'placeholder', contains: 'el.placeholder =', reason: 'the DOM attribute' },
      { path: 'src/gone.ts', reason: 'was removed' },
      { path: 'tools/bodies/', word: 'placeholder', standing: true, reason: 'simple bodies' },
    ];
    const { open, allowed, stale } = judge(findings, allow);
    expect(open.map((f: Finding) => f.file)).toEqual(['data/defs/bodies/earth.json']);
    expect(allowed.map((f: Finding) => f.file)).toEqual(['data/defs/bodies/mimas.json', 'src/ui/menu/input.ts']);
    expect(stale.map((a: { path: string }) => a.path)).toEqual(['src/gone.ts']);
  });

  it('the allow-list file is well formed and every entry has a reason', () => {
    const allow = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tools/dev/check-stubs.allow.json'), 'utf8')) as { path: string; reason: string }[];
    expect(allow.length).toBeGreaterThan(0);
    for (const a of allow) {
      expect(typeof a.path).toBe('string');
      expect(a.reason.trim().length).toBeGreaterThan(10);
    }
  });
});

describe('endpoint document plugin (/endpoints.json)', () => {
  const saved = process.env.STACK_ENDPOINTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.STACK_ENDPOINTS;
    else process.env.STACK_ENDPOINTS = saved;
  });

  type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  function handlerOf(): Handler {
    let handler: Handler | null = null;
    const plugin = stackEndpointsPlugin({ 'Cross-Origin-Resource-Policy': 'same-origin' });
    const hook = plugin.configureServer as unknown as (server: { middlewares: { use(h: Handler): void } }) => void;
    hook({ middlewares: { use: (h) => void (handler = h) } });
    if (!handler) throw new Error('the plugin registered no middleware');
    return handler;
  }
  function call(handler: Handler, url: string, method = 'GET'): { status: number | null; headers: Record<string, string>; body: string; passed: boolean } {
    const out = { status: null as number | null, headers: {} as Record<string, string>, body: '', passed: false };
    const res = {
      writeHead: (status: number, headers: Record<string, string>) => {
        out.status = status;
        out.headers = headers;
      },
      end: (body?: Buffer) => {
        out.body = body ? body.toString('utf8') : '';
      },
    } as unknown as ServerResponse;
    handler({ url, method } as IncomingMessage, res, () => {
      out.passed = true;
    });
    return out;
  }

  it('answers 404 without STACK_ENDPOINTS, and for a file that does not exist', () => {
    delete process.env.STACK_ENDPOINTS;
    const handler = handlerOf();
    const r = call(handler, ENDPOINTS_PATH);
    expect(r.status).toBe(404);
    expect(r.body).toBe('');
    expect(r.passed).toBe(false);
    process.env.STACK_ENDPOINTS = path.join(os.tmpdir(), `no-such-endpoints-${process.pid}.json`);
    expect(call(handler, ENDPOINTS_PATH).status).toBe(404);
  });

  it('serves the named file, re-read on every request, and passes every other path on', () => {
    const file = path.join(os.tmpdir(), `endpoints-${process.pid}.json`);
    try {
      fs.writeFileSync(file, '{"gateway":["ws://127.0.0.1:7001"]}');
      process.env.STACK_ENDPOINTS = file;
      const handler = handlerOf();
      const a = call(handler, `${ENDPOINTS_PATH}?t=1`);
      expect(a.status).toBe(200);
      expect(a.headers['Content-Type']).toMatch(/^application\/json/);
      expect(a.headers['Cache-Control']).toBe('no-store');
      expect(a.headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
      expect(JSON.parse(a.body)).toEqual({ gateway: ['ws://127.0.0.1:7001'] });
      fs.writeFileSync(file, '{"gateway":["ws://127.0.0.1:7002"]}');
      expect(JSON.parse(call(handler, ENDPOINTS_PATH).body)).toEqual({ gateway: ['ws://127.0.0.1:7002'] });
      expect(call(handler, ENDPOINTS_PATH, 'HEAD').body).toBe('');
      const other = call(handler, '/defs/index.json');
      expect(other.passed).toBe(true);
      expect(other.status).toBeNull();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('browser globalSetup', () => {
  const saved = { stack: process.env.STACK_URL, base: process.env.E2E_BASE_URL };
  afterEach(() => {
    for (const [key, value] of [['STACK_URL', saved.stack], ['E2E_BASE_URL', saved.base]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('with STACK_URL set it starts no server and points the specs at the stack page', async () => {
    process.env.STACK_URL = 'http://127.0.0.1:59999/';
    delete process.env.E2E_BASE_URL;
    const { default: globalSetup } = await import('../../tests/browser/globalSetup');
    const t0 = Date.now();
    const teardown = await globalSetup();
    // No Vite server was created: the call returns at once and the address is the stack's, not a fresh port.
    expect(Date.now() - t0).toBeLessThan(200);
    expect(process.env.E2E_BASE_URL).toBe('http://127.0.0.1:59999');
    await teardown();
  });

  it('STACK_URL wins over E2E_BASE_URL; E2E_BASE_URL alone is left as it is', async () => {
    const { default: globalSetup } = await import('../../tests/browser/globalSetup');
    process.env.STACK_URL = 'http://127.0.0.1:59998';
    process.env.E2E_BASE_URL = 'http://127.0.0.1:1';
    await (await globalSetup())();
    expect(process.env.E2E_BASE_URL).toBe('http://127.0.0.1:59998');
    delete process.env.STACK_URL;
    process.env.E2E_BASE_URL = 'http://127.0.0.1:2';
    await (await globalSetup())();
    expect(process.env.E2E_BASE_URL).toBe('http://127.0.0.1:2');
  });
});

describe('vitest and Playwright configuration', () => {
  const saved = { mission: process.env.MISSION, net: process.env.NET };
  afterEach(() => {
    for (const [key, value] of [['MISSION', saved.mission], ['NET', saved.net]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  async function vitestInclude(env: { MISSION?: string; NET?: string }): Promise<{ include: string[]; testTimeout: number }> {
    delete process.env.MISSION;
    delete process.env.NET;
    Object.assign(process.env, env);
    vi.resetModules();
    const mod = (await import('../../vitest.config')) as { default: { test: { include: string[]; testTimeout: number } } };
    return mod.default.test;
  }

  it('the unit suite collects the new directories; the mission and net suites are behind their switches', async () => {
    const unit = await vitestInclude({});
    for (const dir of ['src', 'tests/unit', 'tests/universe', 'tests/load', 'tools', 'server', 'bots']) expect(unit.include).toContain(`${dir}/**/*.test.ts`);
    expect(unit.include.some((p) => p.startsWith('tests/net') || p.startsWith('tests/mission'))).toBe(false);
    const net = await vitestInclude({ NET: '1' });
    expect(net.include).toEqual(['tests/net/**/*.test.ts']);
    expect(net.testTimeout).toBeGreaterThan(unit.testTimeout);
    const mission = await vitestInclude({ MISSION: '1' });
    expect(mission.include).toEqual(['tests/mission/**/*.test.ts']);
  });

  it('Playwright has the acceptance project on tests/acceptance, and the functional project is unchanged', async () => {
    const mod = (await import('../../playwright.config')) as { default: { testDir: string; globalSetup: string; projects: { name: string; testDir?: string; testIgnore?: string[] }[] } };
    const cfg = mod.default;
    expect(cfg.projects.map((p) => p.name)).toEqual(['functional', 'perf', 'mission', 'acceptance']);
    expect(cfg.projects.find((p) => p.name === 'acceptance')!.testDir).toBe('tests/acceptance');
    expect(cfg.projects.find((p) => p.name === 'functional')!.testIgnore).toEqual(['**/*.perf.spec.ts', 'mission/**']);
    expect(cfg.testDir).toBe('tests/browser');
  });

  it('package.json has the scripts the briefs name, and .gitignore the three data directories', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts['typecheck']).toBe('tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json');
    expect(pkg.scripts['stack']).toBe('node tools/dev/stack.mjs');
    expect(pkg.scripts['stack:client']).toBe('node tools/dev/heavy.mjs --class=cpu -- node tools/dev/build-client.mjs --target=stack');
    expect(pkg.scripts['build:ci']).toContain('tools/dev/build-client.mjs --target=ci');
    expect(pkg.scripts['test:net']).toBe('node tools/dev/run-net.mjs');
    // The stack's Postgres is pinned to one PostgreSQL major: an exact version, no range.
    expect(pkg.devDependencies['embedded-postgres']).toMatch(/^18\.\d+\.\d+/);
    for (const dep of ['pg', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']) expect(pkg.dependencies[dep]).toBeDefined();
    expect(pkg.devDependencies['@types/pg']).toBeDefined();
    const ignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8').split(/\r?\n/);
    for (const dir of ['data/packs/', 'data/baselines/', 'data/stack/']) expect(ignore).toContain(dir);
  });

  it('the no-DOM configuration covers the server side and the headless directories', () => {
    const text = fs.readFileSync(path.join(repoRoot, 'tsconfig.node.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const cfg = JSON.parse(text) as { compilerOptions: { lib: string[] }; include: string[] };
    expect(cfg.compilerOptions.lib.some((l) => /dom/i.test(l))).toBe(false);
    for (const dir of ['server', 'bots', 'deploy', 'src/sim', 'src/universe', 'src/session', 'src/terrain', 'src/pilot']) expect(cfg.include).toContain(dir);
  });
});
