/**
 * Inlines the capability gate (src/gate, ARCHITECTURE 24) into index.html, so the gate is part of the page
 * itself: no request stands between the first byte and the checks, and the main bundle is requested only by
 * the gate's dynamic import after a pass.
 *
 * index.html works without this plugin (its gate script imports '/src/gate/index.ts' as a module). With it,
 * `transformIndexHtml` (before Vite's own HTML handling, in the dev server and in a build alike):
 *   1. bundles src/gate/index.ts with rolldown (Vite's own bundler) into one IIFE that sets
 *      `window.__fspGateModule`, minified, and puts it in a classic inline <script> in the <head>;
 *   2. rewrites the gate script of the page (`<script type="module" data-fsp-gate>`) to take `startGate`
 *      from that global instead of importing it. What is left of the module script is the dynamic import of
 *      the main entry, which Vite resolves (in a build: to the main chunk, requested only when it runs).
 * A page without the marked gate script is left as it is. Registered in vite.config.ts by the lead.
 */
import path from 'node:path';
import { rolldown } from 'rolldown';
import type { Plugin } from 'vite';

/** The marked gate script and the import of the gate in it. */
const GATE_SCRIPT = /<script type="module" data-fsp-gate>([\s\S]*?)<\/script>/;
const GATE_IMPORT = /import\s*\{\s*startGate\s*\}\s*from\s*['"]\/src\/gate\/index\.ts['"];?/;
/** The global the inlined gate defines. */
export const GATE_GLOBAL = '__fspGateModule';

/** The gate as one minified IIFE that assigns its exports to `window.__fspGateModule`. */
export async function bundleGate(repoRoot: string): Promise<string> {
  const bundle = await rolldown({ input: path.join(repoRoot, 'src', 'gate', 'index.ts'), platform: 'browser', logLevel: 'silent' });
  try {
    const { output } = await bundle.generate({ format: 'iife', name: GATE_GLOBAL, minify: true });
    const chunk = output.find((o) => o.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('gatePlugin: the gate bundle has no chunk');
    return chunk.code;
  } finally {
    await bundle.close();
  }
}

/** Rewrite a page: the gate inlined as a classic script, the module script taking it from the global. Unchanged when the page has no marked gate script. */
export function inlineGate(html: string, gateCode: string): string {
  const m = GATE_SCRIPT.exec(html);
  if (!m) return html;
  const body = m[1]!;
  if (!GATE_IMPORT.test(body)) throw new Error('gatePlugin: the gate script of the page does not import startGate from /src/gate/index.ts');
  const rewritten = `<script type="module" data-fsp-gate>${body.replace(GATE_IMPORT, `const { startGate } = window.${GATE_GLOBAL};`)}</script>`;
  // A literal "</script" inside the code would end the inline element.
  const safeCode = gateCode.replace(/<\/script/gi, '<\\/script');
  const classic = `<script data-fsp-gate-inline>${safeCode}</script>`;
  const withModule = html.slice(0, m.index) + rewritten + html.slice(m.index + m[0].length);
  return withModule.replace('</head>', `    ${classic}\n  </head>`);
}

export function gatePlugin(repoRoot: string): Plugin {
  let cached: Promise<string> | null = null;
  return {
    name: 'fsp-gate',
    // The gate's source can change while the dev server runs: bundle again on every page in serve mode.
    configureServer() {
      cached = null;
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html, ctx) {
        if (!GATE_SCRIPT.test(html)) return html;
        const code = ctx.server || !cached ? (cached = bundleGate(repoRoot)) : cached;
        return inlineGate(html, await code);
      },
    },
  };
}
