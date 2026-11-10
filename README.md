# Meridian - true-scale Earth/Moon spaceflight simulator

Desktop Chrome/Edge, WebGPU, dedicated GPU. Raw WebGPU + WGSL renderer, deterministic TypeScript physics.

- Requirements: `PROMPT.txt`
- Architecture, conventions, ownership, definition of done: `docs/ARCHITECTURE.md`
- Detailed designs: `docs/research/`
- Shared contracts: `src/core/contracts/`

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (app at `/`, lab pages at `/labs/<name>/`) |
| `npm run typecheck` | strict TypeScript over the whole repo |
| `npm run typecheck:paths -- <paths>` | same, but only fails on errors inside the given paths |
| `npm test` | headless unit tests (vitest) |
| `npm run test:mission` | headless full-mission flight (`tests/mission`) |
| `npm run test:py` | Python bake library vs. TypeScript golden files |
| `npm run e2e` | Playwright functional tests in installed Chrome with real WebGPU |
| `npm run e2e:perf` / `npm run e2e:mission` | perf checkpoints (GPU lock) / real-time browser mission |
| `npm run build` | typecheck + production build to `dist/` |
| `npm run golden` | regenerate cross-language golden files in `tools/bake/golden` |

Baked data (`data/tiles`, `data/sky`) is produced by the pipelines under `tools/bake` and is not in git.
API keys live in `.env` (see `.env.example`), are used only by build-time tools, and are never committed
or shipped to the client.
