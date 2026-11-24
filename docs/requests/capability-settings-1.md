Status: open
From: capability-settings
Owner path: vite.config.ts (the lead), src/core/contracts/render.ts (the lead)
Blocking: no (the gate runs without the plugin; the deprecated field is kept consistent meanwhile)

## Problem
1. The brief says the gate plugin is registered in vite.config.ts; it is not (vite.config.ts lists
   `fableDataPlugin` and `stackEndpointsPlugin` only). Without it the gate still runs before the main bundle
   (index.html's `<script type="module" data-fsp-gate>` imports `/src/gate/index.ts` and loads the app with
   a dynamic import only on a pass; in a build the app is a chunk only that import names), but the gate is
   one request of its own instead of being part of the page.
2. `RenderContext.quality` is still the deprecated `QualitySettings` (six fields). The quality levels now
   come from `Renderer.setQuality(profile)` and features read them with `coreOf(ctx).quality.params(id)`
   (RENDER_API section 20). The render core keeps the six fields equal to the resolved profile (pixel cap
   and floor as `renderScaleMax` / `renderScaleMin`, and the levels of 'terrain', 'shadows', 'clouds',
   'atmosphere'), so nothing that still reads them is wrong; no feature of the tree reads them any more.

## Evidence
`git show 4eeb9e0 -- index.html tools/server/gatePlugin.ts`; `npx vitest run tests/unit/bench/gatePlugin.test.ts`
(the plugin bundles the gate with rolldown into one IIFE of a few kB, inlines it in the head and rewrites the
page's gate script to take `startGate` from `window.__fspGateModule`; a page without the marked script is
left alone). `grep -rn "ctx.quality" src/render` finds no reader outside the core.

## Requested change
1. In vite.config.ts: `import { gatePlugin } from './tools/server/gatePlugin';` and add
   `gatePlugin(repoRoot)` to `plugins` (before or after `fableDataPlugin`; it only transforms index.html).
   Nothing else changes: labs and their pages have no marked gate script.
2. At the tighten step after 4.3 (when `Renderer.setQuality` becomes required): replace
   `RenderContext.quality: QualitySettings` by the profile in force (`QualityProfile | null`, null = the
   renderer's defaults) or drop the member, and retire `QualitySettings`; `RendererOptions.quality` of the
   render core then keeps only the pinned scale it already is (`Partial<Pick<QualitySettings,
   'renderScaleMin' | 'renderScaleMax'>>`, to become a type of its own).
