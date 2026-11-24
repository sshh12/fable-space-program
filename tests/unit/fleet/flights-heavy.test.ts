/**
 * The heavy vehicles to orbit from Ka Lae (pad lc-2, beside LC-1), flown by the generic ascent pilot. Their
 * payloads stay on the upper stage in orbit (the Egret's and the depot's M-3 burns again for the transfer; the
 * Albatross is in orbit on its own engines). See ascent.ts for what is held.
 */
import { beforeAll, describe, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { ascentToOrbit } from './ascent';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

describe('the generic ascent pilot flies the heavy vehicles to orbit from a Ka Lae heavy pad', () => {
  for (const id of ['meridian-egret', 'meridian-albatross', 'meridian-pelican-heavy']) {
    it(`${id}: orbit, clean separations, max-q under the stack's limits`, async () => {
      await ascentToOrbit(defs, id, true);
    }, 300_000);
  }
});
