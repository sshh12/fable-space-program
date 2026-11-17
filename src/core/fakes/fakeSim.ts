/**
 * The v1 names of the fake session (src/core/fakes/fakeSession.ts): `createFakeSim` gives a `FakeSession`
 * of one of the eight flight scenes, typed as the session contract. The fake, its scenes and its options are
 * described there; new code takes `createFakeSession`, which also gives the scenes of the shared universe and
 * the fake's own handles (`setRenderRoot`, `portStates`).
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

export const createFakeSim = (defs: DefLibrary, opts: FakeSimOptions): LocalSession => new FakeSession(defs, opts);
