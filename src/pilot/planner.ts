/**
 * Maneuver planning the way a player does it in the map view: put a node on the trajectory, drag its
 * time and its three delta-v handles, and watch what the predicted trajectory does. One candidate is
 * tried per control tick: the pilot sets the node (PlayerCommands.setNode) and reads the planned patches
 * of the NEXT snapshot. A plan is a generator that yields candidates and receives those snapshots; the
 * building blocks below are a compass (coordinate) search and a one-dimensional root solve.
 *
 * Every plan is capped at MAX_PLAN_EVALUATIONS predictor evaluations.
 */
import type { PlayerCommands } from '@/core/contracts/controls';
import type { SimSnapshot } from '@/core/contracts/sim';

export const MAX_PLAN_EVALUATIONS = 400;

export interface NodeVars {
  ut: number;
  prograde: number;
  normal: number;
  radial: number;
}
export type VarKey = keyof NodeVars;

/** A plan yields node candidates, receives the snapshot that shows each one, and returns the node to fly (or null). */
export type Plan = Generator<NodeVars, NodeVars | null, SimSnapshot>;

export interface Budget {
  left: number;
}

export interface CompassSpec {
  /** Searched variables with their step sizes, coarse to fine. */
  vars: { key: VarKey; steps: readonly number[] }[];
  /** Cost of the trajectory planned with the candidate (lower is better). */
  cost: (snapshot: SimSnapshot, candidate: NodeVars) => number;
  /** Stop as soon as the cost is at or below this. */
  tolerance: number;
}

export interface SearchResult {
  best: NodeVars;
  cost: number;
}

/**
 * Compass search: for each step size, move one variable at a time by +/- the step while the cost falls
 * (keeping a successful direction), then refine with the next smaller steps.
 */
export function* compassSearch(initial: NodeVars, spec: CompassSpec, budget: Budget): Generator<NodeVars, SearchResult, SimSnapshot> {
  let best: NodeVars = { ...initial };
  budget.left--;
  let bestCost = spec.cost(yield best, best);
  const levels = Math.max(...spec.vars.map((v) => v.steps.length));
  for (let level = 0; level < levels; level++) {
    let improved = true;
    while (improved && bestCost > spec.tolerance && budget.left > 0) {
      improved = false;
      for (const v of spec.vars) {
        const step = v.steps[Math.min(level, v.steps.length - 1)]!;
        for (const dir of [1, -1]) {
          let moved = false;
          while (budget.left > 0 && bestCost > spec.tolerance) {
            const cand: NodeVars = { ...best };
            cand[v.key] += dir * step;
            budget.left--;
            const c = spec.cost(yield cand, cand);
            if (!(c < bestCost)) break;
            best = cand;
            bestCost = c;
            moved = true;
            improved = true;
          }
          if (moved) break;
        }
      }
    }
    if (bestCost <= spec.tolerance || budget.left <= 0) break;
  }
  return { best, cost: bestCost };
}

export interface RootSpec {
  key: VarKey;
  /** Signed residual of the trajectory planned with the candidate; the solve drives it to zero. */
  residual: (snapshot: SimSnapshot, candidate: NodeVars) => number;
  /** First step taken from the initial value to find a second point. */
  firstStep: number;
  /** Largest change of the variable per iteration. */
  maxStep: number;
  tolerance: number;
  maxIterations: number;
}

/** Secant iteration on one node variable, safeguarded by bisection once the root is bracketed. */
export function* solveRoot(initial: NodeVars, spec: RootSpec, budget: Budget): Generator<NodeVars, SearchResult, SimSnapshot> {
  const at = (x: number): NodeVars => ({ ...initial, [spec.key]: x });
  let x0 = initial[spec.key];
  budget.left--;
  let f0 = spec.residual(yield at(x0), at(x0));
  let best = at(x0);
  let bestAbs = Math.abs(f0);
  if (bestAbs <= spec.tolerance || budget.left <= 0) return { best, cost: bestAbs };
  let x1 = x0 + spec.firstStep;
  let lo: { x: number; f: number } | null = null;
  let hi: { x: number; f: number } | null = null;
  const note = (x: number, f: number): void => {
    if (!Number.isFinite(f)) return;
    if (f < 0) {
      if (!lo || Math.abs(f) < Math.abs(lo.f)) lo = { x, f };
    } else if (!hi || Math.abs(f) < Math.abs(hi.f)) hi = { x, f };
  };
  note(x0, f0);
  for (let i = 0; i < spec.maxIterations && budget.left > 0; i++) {
    budget.left--;
    const f1 = spec.residual(yield at(x1), at(x1));
    note(x1, f1);
    if (Math.abs(f1) < bestAbs) {
      bestAbs = Math.abs(f1);
      best = at(x1);
    }
    if (bestAbs <= spec.tolerance) break;
    let next: number;
    const l = lo as { x: number; f: number } | null;
    const h = hi as { x: number; f: number } | null;
    if (l && h) {
      // Bracketed: regula falsi kept inside the bracket, falling back to the midpoint when it stalls.
      const xs = l.x - (l.f * (h.x - l.x)) / (h.f - l.f);
      const mid = 0.5 * (l.x + h.x);
      const span = Math.abs(h.x - l.x);
      next = Math.abs(xs - l.x) < 0.02 * span || Math.abs(xs - h.x) < 0.02 * span || i % 3 === 2 ? mid : xs;
    } else if (Number.isFinite(f1) && Number.isFinite(f0) && f1 !== f0) {
      let dx = (-f1 * (x1 - x0)) / (f1 - f0);
      if (Math.abs(dx) > spec.maxStep) dx = Math.sign(dx) * spec.maxStep;
      next = x1 + dx;
    } else next = x1 + spec.firstStep;
    x0 = x1;
    f0 = f1;
    x1 = next;
  }
  return { best, cost: bestAbs };
}

export interface NewtonSpec {
  /** The node handles that may move, with the probe step used to see what each one does. */
  vars: { key: VarKey; probe: number; maxStep: number }[];
  /** What the planned trajectory is off by, one number per target (null: the trajectory misses altogether). */
  residuals: (snapshot: SimSnapshot, candidate: NodeVars) => number[] | null;
  /** Stop when the length of the residual vector is at or below this. */
  tolerance: number;
  maxIterations: number;
}

/** Solve the small linear system A x = b in place (Gaussian elimination with partial pivoting); false when singular. */
function solveLinear(A: number[][], b: number[]): boolean {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    if (!(Math.abs(A[piv]![c]!) > 1e-300)) return false;
    if (piv !== c) {
      [A[piv], A[c]] = [A[c]!, A[piv]!];
      [b[piv], b[c]] = [b[c]!, b[piv]!];
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r]![c]! / A[c]![c]!;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r]![k]! -= f * A[c]![k]!;
      b[r]! -= f * b[c]!;
    }
  }
  for (let c = n - 1; c >= 0; c--) {
    let s = b[c]!;
    for (let k = c + 1; k < n; k++) s -= A[c]![k]! * b[k]!;
    b[c] = s / A[c]![c]!;
  }
  return true;
}

const norm = (r: readonly number[]): number => Math.hypot(...r);

/**
 * What a player does with several handles and several things to hit: nudge each handle once to see what
 * it changes, combine the handles into the smallest total change that removes the error, try it, and
 * repeat. (Newton's method with a finite-difference Jacobian; the step is the minimum-norm solution when
 * there are more handles than targets, least squares otherwise, halved while it does not help.)
 */
export function* minNormNewton(initial: NodeVars, spec: NewtonSpec, budget: Budget): Generator<NodeVars, SearchResult, SimSnapshot> {
  let x: NodeVars = { ...initial };
  budget.left--;
  let r = spec.residuals(yield x, x);
  if (r === null) return { best: x, cost: Infinity };
  let best = x;
  let bestNorm = norm(r);
  const n = spec.vars.length;
  for (let it = 0; it < spec.maxIterations && bestNorm > spec.tolerance && budget.left > n + 1; it++) {
    const m = r.length;
    // Jacobian, one column per handle.
    const J: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    let ok = true;
    for (let j = 0; j < n && ok; j++) {
      const v = spec.vars[j]!;
      let h = v.probe;
      let rp: number[] | null = null;
      for (const sign of [1, -1]) {
        const xp: NodeVars = { ...x };
        xp[v.key] += sign * v.probe;
        budget.left--;
        rp = spec.residuals(yield xp, xp);
        h = sign * v.probe;
        if (rp !== null) break;
      }
      if (rp === null) {
        ok = false;
        break;
      }
      for (let i = 0; i < m; i++) J[i]![j] = (rp[i]! - r[i]!) / h;
    }
    if (!ok) break;
    // Step: dx = -J^T (J J^T)^-1 r (minimum norm) or -(J^T J)^-1 J^T r (least squares), lightly regularised.
    const dx = new Array<number>(n).fill(0);
    if (m <= n) {
      const A: number[][] = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, k) => J[i]!.reduce((s, _v, j) => s + J[i]![j]! * J[k]![j]!, 0)));
      for (let i = 0; i < m; i++) A[i]![i]! *= 1 + 1e-9;
      const y = r.slice();
      if (!solveLinear(A, y)) break;
      for (let j = 0; j < n; j++) for (let i = 0; i < m; i++) dx[j]! -= J[i]![j]! * y[i]!;
    } else {
      const A: number[][] = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a]! * row[b]!, 0)));
      for (let a = 0; a < n; a++) A[a]![a]! *= 1 + 1e-9;
      const y = Array.from({ length: n }, (_, a) => -J.reduce((s, row, i) => s + row[a]! * r![i]!, 0));
      if (!solveLinear(A, y)) break;
      for (let j = 0; j < n; j++) dx[j] = y[j]!;
    }
    // Trust region per handle, then a short line search.
    let scale = 1;
    for (let j = 0; j < n; j++) if (Math.abs(dx[j]!) * scale > spec.vars[j]!.maxStep) scale = spec.vars[j]!.maxStep / Math.abs(dx[j]!);
    let accepted = false;
    for (let ls = 0; ls < 5 && budget.left > 0; ls++) {
      const xn: NodeVars = { ...x };
      for (let j = 0; j < n; j++) xn[spec.vars[j]!.key] += scale * dx[j]!;
      budget.left--;
      const rn = spec.residuals(yield xn, xn);
      if (rn !== null && norm(rn) < bestNorm) {
        x = xn;
        r = rn;
        best = xn;
        bestNorm = norm(rn);
        accepted = true;
        break;
      }
      scale *= 0.4;
    }
    if (!accepted) break;
  }
  return { best, cost: bestNorm };
}

/** Drives a plan one evaluation per control tick. */
export class PlanRunner {
  readonly budget: Budget;
  evaluations = 0;
  done = false;
  /** The node the plan settled on (null: it found nothing acceptable). */
  result: NodeVars | null = null;
  private started = false;

  constructor(
    readonly nodeId: string,
    private readonly plan: Plan,
    budget?: Budget,
  ) {
    this.budget = budget ?? { left: MAX_PLAN_EVALUATIONS };
  }

  private apply(commands: PlayerCommands, x: NodeVars): void {
    commands.setNode(this.nodeId, { ut: x.ut, dv: { prograde: x.prograde, normal: x.normal, radial: x.radial } });
  }

  /** One tick: feed the snapshot of the previous candidate to the plan and set the next. Returns true when finished. */
  step(snapshot: SimSnapshot, commands: PlayerCommands): boolean {
    if (this.done) return true;
    const r = this.started ? this.plan.next(snapshot) : this.plan.next();
    this.started = true;
    if (r.done) {
      this.done = true;
      this.result = r.value;
      if (r.value) this.apply(commands, r.value);
      return true;
    }
    this.evaluations++;
    this.apply(commands, r.value);
    return false;
  }
}
