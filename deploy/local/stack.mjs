#!/usr/bin/env node
/**
 * The local stack's launcher (ARCHITECTURE 16.4). `npm run stack` runs it inside the ONE `stack` slot of the
 * heavy gate (tools/dev/stack.mjs); `npm run stack -- status` and `-- down` run it directly. The launcher is
 * written in TypeScript (deploy/local/launcher.ts, type-checked with the Node configuration); this file only
 * loads it through tsx (a dependency of the repository).
 */
import { register } from 'tsx/esm/api';

register();
await import('./launcher.ts');
