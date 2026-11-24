/**
 * The CPU score sent in hello (ARCHITECTURE 24, frontend-ux 3.6 and 9.3; `UniverseRules.planning.weakClientCpuScore`):
 *
 *   cpuScore = 100 x sqrt( (frameRef / frame) x (simRef / sim) )
 *
 * where `frame` is the p95 of the main thread's frame time during the confirmation shot (the lift-off: the
 * renderer's CPU work, the session, the HUD) and `sim` the wall time of `simSteps` steps of a local session
 * flying the lift-off scenario headless (the simulation's CPU work, which the planning shares). `frameRef`
 * and `simRef` are the same two numbers measured on the reference machine (quality.json `cpuReference`),
 * which therefore scores 100; a client half as fast in both scores 50. The geometric mean keeps one slow
 * half from hiding behind a fast one. The score is a capacity hint for the server, never a gate.
 */
export interface CpuReference {
  frameP95Ms: number;
  simMs: number;
  /** Steps of the simulation workload (the host's `cpuProbe` runs exactly this many). */
  simSteps: number;
}

export function cpuScoreOf(m: { frameP95Ms: number; simMs: number }, ref: CpuReference): number {
  const f = ref.frameP95Ms / Math.max(1e-3, m.frameP95Ms);
  const s = ref.simMs / Math.max(1e-3, m.simMs);
  return Math.round(100 * Math.sqrt(f * s) * 10) / 10;
}
