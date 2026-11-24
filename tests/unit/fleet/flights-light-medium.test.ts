/**
 * The light and medium vehicles to orbit from Ka Lae, flown by the generic ascent pilot, each separating its
 * payload in orbit and watching it go. See ascent.ts for what is held.
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

describe('the generic ascent pilot flies the light and medium vehicles to orbit from a Ka Lae pad of their class', () => {
  for (const id of ['azimuth-pathfinder', 'solstice-kestrel', 'solstice-atoll', 'solstice-pelican']) {
    it(`${id}: orbit, clean separations (the payload's in orbit too), max-q under the stack's limits`, async () => {
      await ascentToOrbit(defs, id, true);
    }, 300_000);
  }
});
