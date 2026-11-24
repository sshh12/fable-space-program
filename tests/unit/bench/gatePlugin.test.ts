/**
 * tools/server/gatePlugin.ts: the gate bundled into one small IIFE and inlined into index.html, the page's
 * gate script then taking `startGate` from the global, the dynamic import of the main entry left for Vite.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { bundleGate, GATE_GLOBAL, inlineGate } from '../../../tools/server/gatePlugin';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

describe('gatePlugin', () => {
  it('bundles the gate into a few kB that define the global and nothing of the app', async () => {
    const code = await bundleGate(repoRoot);
    expect(code.length).toBeLessThan(16 * 1024);
    expect(code).not.toMatch(/src\/app|import\s*\(/);
    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(code, sandbox);
    const mod = sandbox[GATE_GLOBAL] as { startGate?: unknown } | undefined;
    expect(typeof mod?.startGate).toBe('function');
  });
  it('rewrites index.html: the gate inline in the head, the module script keeps only the main import', async () => {
    const out = inlineGate(indexHtml, 'var __fspGateModule=(function(){return{startGate:function(){}}})();');
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<script data-fsp-gate-inline>var __fspGateModule=');
    const gateScript = /<script type="module" data-fsp-gate>([\s\S]*?)<\/script>/.exec(out)![1]!;
    expect(gateScript).toContain(`const { startGate } = window.${GATE_GLOBAL};`);
    expect(gateScript).toContain("import('/src/app/main.ts')");
    expect(gateScript).not.toContain('/src/gate/index.ts');
    expect(out).not.toMatch(/<script[^>]*src="\/src\/app\/main\.ts"/);
  });
  it('escapes a closing script tag inside the code and leaves other pages alone', () => {
    const out = inlineGate(indexHtml, 'var s="</script>";');
    expect(out).toContain('var s="<\\/script>";');
    const lab = '<html><head></head><body><script type="module" src="./main.ts"></script></body></html>';
    expect(inlineGate(lab, 'x')).toBe(lab);
  });
});
