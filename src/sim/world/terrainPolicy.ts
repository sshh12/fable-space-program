/**
 * Deterministic terrain loading of the world orchestrator (Sim contract in src/core/contracts/sim.ts,
 * ARCHITECTURE sections 6 and 7.2).
 *
 * Terrain is requested only at step boundaries and only from physical triggers:
 *  - slot 'pad' / 'start:<vessel>': the scenario's start state (requested by the world at creation);
 *  - slot 'impact': a disc of IMPACT_DISC_RADIUS at the predicted impact point of the active vessel as soon
 *    as its current trajectory has an `impact` marker, refreshed when the point moves by more than
 *    IMPACT_REFRESH_DISTANCE;
 *  - slot 'vessel:<id>': a disc of VESSEL_DISC_RADIUS under each controllable vessel while it is in the
 *    terrain regime - below LOW_RADAR_ALTITUDE radar altitude, or below SLOW_ALTITUDE with a ground speed
 *    under SLOW_GROUND_SPEED - refreshed when its sub-point moves by more than VESSEL_REFRESH_DISTANCE.
 *    Never a disc swept along under an orbital pass.
 *
 * Every request is an `ensureLoaded` promise; `pending()` is non-null while any of them is outstanding.
 * A disc counts as final only once its promise has resolved. `isFinalAt` answers "does a contact probe or
 * a low-altitude radar query at this point use final data" without touching the provider for points inside
 * a resolved disc, and asks `residency()` otherwise.
 */
import type { TerrainProvider } from '@/core/contracts/terrain';
import { v3, type Vec3 } from '@/core/math/vec3';

export const IMPACT_DISC_RADIUS = 3000;
export const IMPACT_REFRESH_DISTANCE = 500;
export const VESSEL_DISC_RADIUS = 1500;
export const VESSEL_REFRESH_DISTANCE = 500;
export const LOW_RADAR_ALTITUDE = 2000;
export const SLOW_ALTITUDE = 50000;
export const SLOW_GROUND_SPEED = 200;
/** Radar altitude below which warp is clamped to 1x while final data is missing, m. */
export const WARP_CLAMP_RADAR_ALTITUDE = 300;
/** Margin by which a point must lie inside a resolved disc to be known final without asking, m. */
const DISC_MARGIN = 20;

interface Disc {
  bodyId: string;
  bodyRadius: number;
  dir: Vec3;
  radius: number;
  resolved: boolean;
  /** Request serial: a resolution only counts for the request that is still current for the slot. */
  serial: number;
}

export class TerrainPolicy {
  private readonly discs = new Map<string, Disc>();
  private outstanding = 0;
  private waiter: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private fail: ((e: unknown) => void) | null = null;
  private serial = 0;
  /** First I/O error of a request (re-thrown by the world on the next step). */
  error: unknown = null;
  /** Number of ensureLoaded requests issued (diagnostics, tests). */
  requests = 0;

  constructor(private readonly terrain: TerrainProvider) {}

  /** Null when nothing is outstanding; otherwise a promise that resolves when every request so far is in. */
  pending(): Promise<void> | null {
    return this.outstanding > 0 ? this.waiter : null;
  }

  /** Request (and pin under `slot`) the disc; returns the provider's promise. */
  request(slot: string, bodyId: string, bodyRadius: number, dir: Vec3, radius: number): Promise<void> {
    const disc: Disc = { bodyId, bodyRadius, dir: v3.normalize(dir), radius, resolved: false, serial: ++this.serial };
    this.discs.set(slot, disc);
    this.requests++;
    if (this.outstanding === 0) {
      this.waiter = new Promise<void>((resolve, reject) => {
        this.release = resolve;
        this.fail = reject;
      });
      // The world reports the error through `error`; an un-awaited waiter must not raise an unhandled rejection.
      this.waiter.catch(() => undefined);
    }
    this.outstanding++;
    const p = this.terrain.ensureLoaded(bodyId, disc.dir, radius, slot);
    p.then(
      () => {
        if (this.discs.get(slot) === disc) disc.resolved = true;
        this.settle(null);
      },
      (e: unknown) => this.settle(e ?? new Error('terrain request failed')),
    );
    return p;
  }

  private settle(error: unknown): void {
    if (error !== null && this.error === null) this.error = error;
    this.outstanding--;
    if (this.outstanding === 0) {
      const release = this.release;
      const fail = this.fail;
      this.release = null;
      this.fail = null;
      if (this.error !== null) fail?.(this.error);
      else release?.();
    }
  }

  /**
   * Request the disc for `slot` unless the slot already holds a request on the same body whose centre is
   * within `refreshDistance` metres of `dir`.
   */
  track(slot: string, bodyId: string, bodyRadius: number, dir: Vec3, radius: number, refreshDistance: number): void {
    const cur = this.discs.get(slot);
    if (cur && cur.bodyId === bodyId && v3.angle(cur.dir, dir) * bodyRadius <= refreshDistance) return;
    void this.request(slot, bodyId, bodyRadius, dir, radius).catch(() => undefined);
  }

  /** Forget a slot's disc (the provider keeps its pin until the slot is requested again). */
  drop(slot: string): void {
    this.discs.delete(slot);
  }

  /** True when the full-detail surface at the point is built from final data. */
  isFinalAt(bodyId: string, dir: Vec3): boolean {
    for (const d of this.discs.values()) {
      if (!d.resolved || d.bodyId !== bodyId) continue;
      if (v3.angle(d.dir, dir) * d.bodyRadius <= d.radius - DISC_MARGIN) return true;
    }
    return this.terrain.residency(bodyId, dir).complete;
  }
}
