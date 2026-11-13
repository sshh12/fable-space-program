/**
 * Running something that moves by itself to its rest: the camera rigs at a frozen start
 * (`?deterministic=1&paused=1`, request lead-6).
 *
 * With the simulation standing still a camera rig still moves for a while: the chase rig approaches its distance
 * and swings to its angles, a view switch blends, the couch's head sway settles. How far that has come when a
 * capture is taken depends on how many frames the page has drawn, which differs from load to load. A frozen page
 * therefore gives the rigs, within one frame, as many of their fixed steps as it takes until a step no longer
 * changes anything: the camera then stands in its final pose from the first frame on, the same on every load.
 * "No longer changes anything" is exact (the state's key is compared as text), because a rest that is only
 * nearly reached is a different picture in a few pixels.
 */

export interface Rest<T> {
  /** The state after the last step. */
  value: T;
  /** True when the last step left the state as it was. */
  atRest: boolean;
  /** Steps taken (1 = it was at rest already). */
  steps: number;
}

/**
 * Take `step` until the state it returns has the same `key` as the one before, at most `maxSteps` times.
 * `first` is the state to start from.
 */
export function runToRest<T>(first: T, step: () => T, key: (state: T) => string, maxSteps: number): Rest<T> {
  let value = first;
  let k = key(value);
  for (let steps = 1; steps <= maxSteps; steps++) {
    value = step();
    const next = key(value);
    if (next === k) return { value, atRest: true, steps };
    k = next;
  }
  return { value, atRest: false, steps: maxSteps };
}
