/**
 * The v1 names of the fake session (src/core/fakes/fakeSession.ts): `createFakeSim` gives a `FakeSession`
 * of one of the eight flight scenes, typed as the session contract. The fake, its scenes and its options are
 * described there; new code takes `createFakeSession`, which also gives the scenes of the shared universe and
 * the fake's own handles (`setRenderRoot`, `portStates`).
 *
 * Two differences, and only where the caller does not say, both so that every lab and spec written on the v1
 * name draws from the numbers it drew from before (the integration lab's reference images were recorded on them):
 *
 * THE RENDER ROOT. `createFakeSim` keeps the origin of ROOT positions at the library's root body, where v1's
 * FakeSim had it (`renderRoot: 'rootBody'`); `createFakeSession` puts it at the active vessel's SOI body as a
 * session does. The two differ in the scenes at the Moon only, and there the same picture comes from positions
 * 384,000 km larger (docs/handoff/presentation-sweep.md, D7). Pass `renderRoot` to choose.
 *
 * THE FIGURES. `createFakeSim` states v1's stand-in constants whatever parts and vehicle it is given
 * (`figures: 'standIn'`: 50 t, a 55 m bounding radius, the centre of mass at the origin, the stack of
 * `stageLabels` with a burn figure for every stage, the constant fractions and lights of the read-outs);
 * `createFakeSession` derives them from the parts and the vehicle as a session does (fakeSession.ts,
 * "Figures"). The renderer reads the mass and the bounding radius (shadow cascades, the cabin's motion, the
 * ocean's wake, the plasma sheath), so a derived figure would move a recorded picture. Pass `figures` to choose.
 */
import type { DefLibrary } from '../contracts/defs';
import type { LocalSession } from '../contracts/session';
import { FAKE_SESSION_DEFAULT_UT, FakeSession, type FakeScene, type FakeSessionOptions } from './fakeSession';

export type { FakeScene };

/** The options of a fake session of a flight scene. */
export type FakeSimOptions = FakeSessionOptions;

/** Start time of a fake session that is given none, seconds since J2000. */
export const FAKE_SIM_DEFAULT_UT = FAKE_SESSION_DEFAULT_UT;

export { FakeSession as FakeSim };

export const createFakeSim = (defs: DefLibrary, opts: FakeSimOptions): LocalSession => new FakeSession(defs, { renderRoot: 'rootBody', figures: 'standIn', ...opts });
