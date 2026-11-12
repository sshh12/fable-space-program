// The validity window of the fitted elements (the lead's decision on request bodies-ephemeris-4) and the Horizons
// sampling of it. Shared by fit-orbits.mjs (which fits) and validate.mjs (which judges the residual), so both
// read the very same cached states.
import { vectorsRange } from './horizons.mjs';
import { utToJd } from './kepler.mjs';
import { LOBBY_EPOCH_UT } from './orbits.mjs';

/** 2029-09-01 and 2060-01-01, TDB. */
export const WINDOW_START_JD = 2462380.5;
export const WINDOW_STOP_JD = 2473459.5;
/** Samples over the window (moons and planets). */
export const WINDOW_SAMPLES = 2000;
const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * Step (whole minutes) close to window / WINDOW_SAMPLES whose fraction of the orbital period is near the golden
 * ratio, so the samples spread evenly over the orbit's phase instead of beating with it.
 */
export function windowStepMinutes(periodDays) {
  const base = Math.round(((WINDOW_STOP_JD - WINDOW_START_JD) * 1440) / WINDOW_SAMPLES);
  const P = periodDays * 1440;
  if (P > 20 * base) return base;
  let best = base;
  let bestErr = Infinity;
  for (let s = base; s < base * 1.1; s++) {
    const f = (s / P) % 1;
    const err = Math.min(Math.abs(f - GOLDEN), Math.abs(f - (1 - GOLDEN)));
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return best;
}

export async function windowSamples(id, command, center, periodDays, { stepMinutes } = {}) {
  const step = stepMinutes ?? windowStepMinutes(periodDays);
  return { step, ...(await vectorsRange(command, center, WINDOW_START_JD.toFixed(6), WINDOW_STOP_JD.toFixed(6), `${step} m`, `win-${id}`)) };
}

/** +-3 periods about the lobby epoch at a 24th of a period: resolves the orbit's shape and its local rate. */
export async function denseSamples(id, command, center, periodDays) {
  const jdL = utToJd(LOBBY_EPOCH_UT);
  const step = Math.max(1, Math.round((periodDays * 1440) / 24));
  return { step, ...(await vectorsRange(command, center, (jdL - 3 * periodDays).toFixed(6), (jdL + 3 * periodDays).toFixed(6), `${step} m`, `dense-${id}`)) };
}
