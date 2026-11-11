/**
 * Marker label text (value + time-to) and hover details, and the greedy label de-cluttering.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import { formatAngleDeg, formatDistance, formatLatLon, formatSpeed, formatTimeTo } from './format';
import type { LabelSource, MarkerItem } from './scene';

const NAMES: Record<MarkerItem['kind'], string> = {
  apoapsis: 'Apoapsis',
  periapsis: 'Periapsis',
  ascendingNode: 'Ascending node',
  descendingNode: 'Descending node',
  soiEnter: 'SOI entry',
  soiExit: 'SOI exit',
  impact: 'Impact',
  atmosphereEntry: 'Atmosphere entry',
  closestApproach: 'Closest approach',
  maneuverNode: 'Maneuver node',
  impactSurface: 'Impact point',
  entrySurface: 'Entry point',
  patchStart: 'Patch start',
};

const SHORT: Record<MarkerItem['kind'], string> = {
  apoapsis: 'Ap',
  periapsis: 'Pe',
  ascendingNode: 'AN',
  descendingNode: 'DN',
  soiEnter: 'Enter',
  soiExit: 'Exit',
  impact: 'Impact',
  atmosphereEntry: 'Entry',
  closestApproach: 'Closest',
  maneuverNode: 'Node',
  impactSurface: 'Impact',
  entrySurface: 'Entry',
  patchStart: 'Start',
};

const bodyName = (defs: DefLibrary, id: string | undefined): string => (id ? defs.bodies[id]?.name ?? id : '');

export const markerLabels: LabelSource = {
  markerLabel(item, { snapshot, defs }) {
    const m = item.marker;
    const dt = m.ut - snapshot.ut;
    const when = formatTimeTo(dt);
    const details: string[] = [NAMES[item.kind]];
    let head = SHORT[item.kind];
    const patch = (item.patchKey.list === 'current' ? snapshot.patches.current : snapshot.patches.planned)[item.patchKey.index];
    const body = bodyName(defs, m.bodyId);
    switch (item.kind) {
      case 'apoapsis':
      case 'periapsis':
        if (m.altitude !== undefined) {
          head += ` ${formatDistance(m.altitude, 'apsis')}`;
          details.push(`Altitude ${formatDistance(m.altitude, 'apsis')} (${body})`);
        }
        break;
      case 'ascendingNode':
      case 'descendingNode':
        if (m.value !== undefined) {
          head += ` ${formatAngleDeg(m.value)}`;
          details.push(`Relative inclination ${formatAngleDeg(m.value, 2)}`);
        }
        break;
      case 'soiEnter':
      case 'soiExit': {
        const next = bodyName(defs, patch?.nextBodyId);
        const other = item.kind === 'soiEnter' ? next || body : body;
        head = item.kind === 'soiEnter' ? `Enter ${next || 'SOI'}` : `Exit ${body}`;
        details.push(item.kind === 'soiEnter' ? `Entering the sphere of influence of ${other}` : `Leaving the sphere of influence of ${body}${next ? ` for ${next}` : ''}`);
        break;
      }
      case 'impact':
      case 'impactSurface': {
        const ll = m.latitude !== undefined && m.longitude !== undefined ? formatLatLon(m.latitude, m.longitude) : null;
        if (ll) {
          if (item.kind === 'impact') head += ` ${ll}`;
          details.push(`${body} ${ll}`);
        }
        const miss = missFor(snapshot, 'impact', m.bodyId, m.ut);
        if (miss) {
          if (item.kind === 'impact') head += `  miss ${formatDistance(miss.missDistance)}`;
          details.push(`Miss to ${miss.name}: ${formatDistance(miss.missDistance)}, bearing ${miss.missBearingDeg.toFixed(0)}°`);
        }
        if (m.value !== undefined) details.push(`Impact speed ${formatSpeed(m.value)}`);
        break;
      }
      case 'atmosphereEntry':
      case 'entrySurface': {
        if (item.kind === 'atmosphereEntry' && m.value !== undefined) head += ` ${formatSpeed(m.value)}`;
        if (m.value !== undefined) details.push(`Speed ${formatSpeed(m.value)}`);
        if (m.flightPathAngle !== undefined) details.push(`Flight-path angle ${formatAngleDeg(m.flightPathAngle, 2)}`);
        if (m.vacuumPeriapsisAltitude !== undefined) details.push(`Vacuum periapsis ${formatDistance(m.vacuumPeriapsisAltitude, 'apsis')}`);
        if (m.latitude !== undefined && m.longitude !== undefined) details.push(`${body} ${formatLatLon(m.latitude, m.longitude)}`);
        if (m.altitude !== undefined) details.push(`Interface altitude ${formatDistance(m.altitude, 'altitude')}`);
        const miss = missFor(snapshot, 'entry', m.bodyId, m.ut);
        if (miss) details.push(`Miss to ${miss.name}: ${formatDistance(miss.missDistance)}, bearing ${miss.missBearingDeg.toFixed(0)}°`);
        break;
      }
      case 'closestApproach':
        if (m.value !== undefined) {
          head += ` ${formatDistance(m.value)}`;
          details.push(`Separation ${formatDistance(m.value)}${snapshot.readouts.targetBodyId ? ` from ${bodyName(defs, snapshot.readouts.targetBodyId)}` : ''}`);
        }
        break;
      case 'maneuverNode':
        break;
    }
    details.push(when);
    // a ground point (shown only away from its trajectory marker) says what it is in one line
    const label = item.kind === 'impactSurface' || item.kind === 'entrySurface' ? [NAMES[item.kind]] : [head, when];
    return { label, details };
  },
};

function missFor(s: SimSnapshot, kind: 'impact' | 'entry', bodyId: string, ut: number): { missDistance: number; missBearingDeg: number; name: string } | null {
  const lt = s.readouts.landingTarget;
  const pred = lt?.predicted;
  if (!lt || !pred || pred.kind !== kind) return null;
  const target = s.surfaceTargets.find((t) => t.id === lt.targetId);
  if (!target || target.bodyId !== bodyId) return null;
  if (Math.abs(pred.ut - ut) > 60) return null;
  return { missDistance: pred.missDistance, missBearingDeg: pred.missBearingDeg, name: target.name };
}

// ------------------------------------------------------------------------------------- de-cluttering

export interface LabelBox {
  /** Anchor (device px) of the object the label belongs to, and the radius it keeps clear. */
  ax: number;
  ay: number;
  clear: number;
  width: number;
  height: number;
  priority: number;
  /** Resolved top-left corner (valid when placed). */
  x: number;
  y: number;
  placed: boolean;
  /** Placed on the outer ring of candidates, away from its anchor: it gets a leader line. */
  far: boolean;
  /**
   * Preferred side (unit screen vector; 0, 0 = none): the outward normal of the line the anchor sits on. The
   * candidates beside the line come first, its outer side before its inner one, the two along the line last,
   * so a marker's label does not lie on its own trajectory.
   */
  nx: number;
  ny: number;
  /** Identity across frames (hysteresis: a label keeps its place while it stays free); '' = none. */
  key: string;
  /** Width of the label's short form (e.g. an abbreviated site name), used when the full one finds no place; 0 = none. */
  altWidth: number;
  /** Placed in its short form. */
  short: boolean;
}

/** The outer ring of candidates lies this many device px (per interface px) further out. */
export const FAR_RING_PX = 22;
/**
 * Cost of a candidate per device px of drawn line under it (LineGrid.length, trajectories weigh 1): a trajectory
 * crossing a label costs more than the whole candidate ring, so a label goes wherever it covers no line, and only
 * where every place covers one does it take the place covering least (its opaque plate then masks the line).
 */
const LINE_LEN_COST = 1.1;
/** Lines this close to a plate (device px per interface px) count as under it. */
const LINE_MARGIN_PX = 1.5;
/** Cost of a candidate that lies nearer to another icon than to its own anchor (it would read as that icon's). */
const FOREIGN_COST = 9;
/**
 * Another marker within this distance (interface px): the label prefers the side away from it, so two labels of
 * neighbouring markers sit on opposite sides and never read crosswise. Cost per unit of the cosine toward it.
 */
const NEIGHBOUR_PX = 44;
const NEIGHBOUR_COST = 7;
/** Cost per axis along which two neighbours' labels lie in the opposite order of their anchors (read crosswise). */
const ORDER_COST = 24;
/** Bonus of the place a label had in the previous draw list (in rank units), so labels do not flip between frames. */
const HYSTERESIS = 3;

/** A disc labels keep clear of; `own` marks the icons a label can be mistaken to belong to (markers, vessels...). */
export interface ClearDisc {
  x: number;
  y: number;
  r: number;
  pair: boolean;
}

/** Line cost of a screen rectangle (device px): LineGrid.cost (cell weights) and LineGrid.length (exact length). */
export interface LineCost {
  cost(x0: number, y0: number, x1: number, y1: number): number;
  length(x0: number, y0: number, x1: number, y1: number): number;
}

/** Unit directions of the eight candidates (index = candidate). */
const S = Math.SQRT1_2;
const DIR_X = [1, -1, 0, 0, S, S, -S, -S];
const DIR_Y = [0, 0, -1, 1, -S, S, -S, S];
const NATURAL = [0, 1, 2, 3, 4, 5, 6, 7];
const ranked = [0, 1, 2, 3, 4, 5, 6, 7];
const score = new Float64Array(8);

/** An axis-aligned screen rectangle (device px) that labels must keep clear of, e.g. a DOM panel. */
export interface BlockedRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Scratch rectangles (x0, y0, x1, y1 per entry), grown on demand and reused between frames. */
let rects = new Float64Array(4 * 256);
const ensureRects = (n: number): void => {
  if (4 * n > rects.length) rects = new Float64Array(4 * Math.max(n, rects.length / 2));
};
const order: number[] = [];

/** Distance from (x, y) to the rectangle [x0, x1] x [y0, y1] (0 inside). */
const rectDist = (x: number, y: number, x0: number, y0: number, x1: number, y1: number): number => {
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
  const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
  return Math.sqrt(dx * dx + dy * dy);
};

/** Connectors of the labels placed so far (anchor to the plate's nearest point), x0, y0, x1, y1 per entry. */
let links = new Float64Array(4 * 64);
/** Anchors and plate centres of the labels placed so far, ax, ay, cx, cy per entry. */
let cents = new Float64Array(4 * 64);
/** Per label: the obstacles (indices into the rectangle buffer) and icons near enough to matter. */
let nearRects = new Int32Array(256);
let nearIcons = new Int32Array(256);

/** Distance from (px, py) to the segment (ax, ay)-(bx, by). */
const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const d2 = dx * dx + dy * dy;
  const t = d2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / d2)) : 0;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
};

/** Orientation of r relative to the directed line p-q (twice the signed triangle area). */
const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number => (qx - px) * (ry - py) - (qy - py) * (rx - px);

/** Whether the segments a-b and c-d cross (strictly, not merely touching at an end). */
const segmentsCross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean =>
  orient(ax, ay, bx, by, cx, cy) * orient(ax, ay, bx, by, dx, dy) < 0 && orient(cx, cy, dx, dy, ax, ay) * orient(cx, cy, dx, dy, bx, by) < 0;

/**
 * Greedy de-cluttering: labels are placed in priority order at the best free one of sixteen candidate
 * positions around their anchor: eight beside it, ordered by the anchor's preferred side (LabelBox.nx / ny),
 * then the same eight on an outer ring `farRing` further out. A candidate must overlap neither an earlier
 * label, nor any icon, nor a blocked rectangle (node panel, tooltip, badges, HUD panels), and lie inside the
 * viewport. Among the free ones the cost is the candidate's rank
 *  - plus the drawn line it would cover, by exact length (`lines.length`, trajectories weigh most): a label
 *    crossed by a trajectory costs more than the whole ring, so it goes where no line is if such a place exists;
 *  - plus a cost for lying toward another marker within NEIGHBOUR_PX (two neighbours' labels go to opposite
 *    sides and never read crosswise), and a penalty when another marker's icon lies nearer to the plate than
 *    its own anchor (it would be read as that marker's label);
 *  - plus a penalty when its connector (anchor to the plate's nearest point, where a leader is drawn) crosses
 *    an icon, a gizmo arm or handle, or an earlier label's connector;
 *  - minus HYSTERESIS for the place the label (by key) had in the previous draw list, so labels keep their
 *    place while it stays free instead of flipping on small changes.
 * Candidates are visited by rank, so the search stops as soon as no later one can be cheaper. A label that
 * finds no free place in full tries its short form (altWidth); one with none is hidden (its icon stays and the
 * hover tooltip still shows the details). Plates are opaque: a line that still passes under one is masked.
 * `scale` is device px per interface px.
 */
export function declutter(
  labels: readonly LabelBox[],
  icons: readonly ClearDisc[],
  viewport: { width: number; height: number },
  gap: number,
  blocked: readonly BlockedRect[] = [],
  farRing = 0,
  lines: LineCost | null = null,
  memory: Map<string, number> | null = null,
  scale = 1,
): void {
  // Fixed obstacles first (icons, blocked rectangles), then the labels as they are placed.
  const nFixed = icons.length + blocked.length;
  ensureRects(nFixed + labels.length);
  if (links.length < 4 * labels.length) {
    links = new Float64Array(4 * labels.length);
    cents = new Float64Array(4 * labels.length);
  }
  if (nearRects.length < nFixed + labels.length) nearRects = new Int32Array(2 * (nFixed + labels.length));
  if (nearIcons.length < icons.length) nearIcons = new Int32Array(2 * icons.length);
  let nLinks = 0;
  const margin = LINE_MARGIN_PX * scale;
  const neighbourReach = NEIGHBOUR_PX * scale;
  const orderTol = 4 * scale;
  let n = 0;
  for (const i of icons) {
    rects[4 * n] = i.x - i.r;
    rects[4 * n + 1] = i.y - i.r;
    rects[4 * n + 2] = i.x + i.r;
    rects[4 * n + 3] = i.y + i.r;
    n++;
  }
  for (const b of blocked) {
    rects[4 * n] = b.x0;
    rects[4 * n + 1] = b.y0;
    rects[4 * n + 2] = b.x1;
    rects[4 * n + 3] = b.y1;
    n++;
  }
  order.length = labels.length;
  for (let i = 0; i < labels.length; i++) order[i] = i;
  order.sort((a, b) => labels[b]!.priority - labels[a]!.priority || a - b);
  // Two neighbouring anchors on lines that run side by side (their outer sides point the same way): the label of
  // the inner one takes the inner side and the outer one's the outer side, so the two labels lie on opposite
  // sides of the pair of lines instead of one beside the other's marker.
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i]!;
    if (a.nx === 0 && a.ny === 0) continue;
    for (let j = i + 1; j < labels.length; j++) {
      const b = labels[j]!;
      if (b.nx === 0 && b.ny === 0) continue;
      const dx = a.ax - b.ax;
      const dy = a.ay - b.ay;
      if (dx * dx + dy * dy >= neighbourReach * neighbourReach || a.nx * b.nx + a.ny * b.ny < 0.5) continue;
      const s = dx * (a.nx + b.nx) + dy * (a.ny + b.ny);
      if (Math.abs(s) < orderTol) continue;
      const inner = s < 0 ? a : b;
      inner.nx = -inner.nx;
      inner.ny = -inner.ny;
    }
  }
  const W = viewport.width;
  const H = viewport.height;
  const rings = farRing > 0 ? 2 : 1;
  for (const i of order) {
    const l = labels[i]!;
    l.placed = false;
    l.far = false;
    l.short = false;
    // candidate order: beside the anchor's line (outer side first), along it last
    let seq = NATURAL;
    if (l.nx !== 0 || l.ny !== 0) {
      for (let c = 0; c < 8; c++) {
        const d = DIR_X[c]! * l.nx + DIR_Y[c]! * l.ny;
        score[c] = Math.abs(d) + (d > 0 ? 0.5 : 0);
        ranked[c] = c;
      }
      for (let a = 1; a < 8; a++) {
        const c = ranked[a]!;
        let b = a - 1;
        while (b >= 0 && score[ranked[b]!]! < score[c]!) {
          ranked[b + 1] = ranked[b]!;
          b--;
        }
        ranked[b + 1] = c;
      }
      seq = ranked;
    }
    // The obstacles and icons that can matter to any of its candidates (within the reach of the outer ring and
    // the label's size, with room for the foreign-icon and connector tests): each candidate tests only these.
    const reachBox = l.clear + gap + (rings - 1) * farRing + Math.max(l.width, l.altWidth) + l.height + 30 * scale;
    let nNear = 0;
    for (let k = 0; k < n; k++) {
      const o = 4 * k;
      if (rects[o]! < l.ax + reachBox && rects[o + 2]! > l.ax - reachBox && rects[o + 1]! < l.ay + reachBox && rects[o + 3]! > l.ay - reachBox) nearRects[nNear++] = k;
    }
    let nIcons = 0;
    for (let k = 0; k < icons.length; k++) {
      const ic = icons[k]!;
      if (Math.abs(ic.x - l.ax) < reachBox + ic.r && Math.abs(ic.y - l.ay) < reachBox + ic.r) nearIcons[nIcons++] = k;
    }
    // the nearest other marker: the label leans away from it
    let fx = 0;
    let fy = 0;
    let fd = neighbourReach;
    for (let q = 0; q < nIcons; q++) {
      const ic = icons[nearIcons[q]!]!;
      if (!ic.pair) continue;
      const dx = ic.x - l.ax;
      const dy = ic.y - l.ay;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 0.5 || d >= fd) continue;
      fd = d;
      fx = dx / d;
      fy = dy / d;
    }
    const prevSlot = memory && l.key ? memory.get(l.key) ?? -1 : -1;
    const bonus = prevSlot >= 0 ? HYSTERESIS : 0;
    let found = false;
    let best = Infinity;
    let bx = 0;
    let by = 0;
    let bfar = false;
    let bslot = -1;
    let bShort = false;
    for (let form = 0; form < 2 && !found; form++) {
      const width = form === 0 ? l.width : l.altWidth;
      if (form === 1 && !(width > 0 && width < l.width)) break;
      // the place the label had in the last draw list first (it gets the hysteresis bonus), then the others in
      // rank order: a candidate costs at least its rank, so the search stops once none left can beat the best
      let prevRing = -1;
      let prevR = -1;
      if (prevSlot >= 0 && ((prevSlot / 8) | 0) < rings) {
        prevRing = (prevSlot / 8) | 0;
        for (let r = 0; r < 8; r++) if (seq[r] === prevSlot % 8) prevR = r;
      }
      {
        for (let step = prevR >= 0 ? -1 : 0; step < rings * 8; step++) {
          let ring: number;
          let r: number;
          if (step < 0) {
            ring = prevRing;
            r = prevR;
          } else {
            ring = (step / 8) | 0;
            r = step % 8;
            if (ring === prevRing && r === prevR) continue;
          }
          const rank = ring * 8 + r;
          if (step >= 0 && best <= rank) break;
          const d = l.clear + gap + ring * farRing;
          const e = d * 0.75;
          const c = seq[r]!;
          let x: number;
          let y: number;
          switch (c) {
            case 0:
              x = l.ax + d;
              y = l.ay - l.height / 2;
              break;
            case 1:
              x = l.ax - d - width;
              y = l.ay - l.height / 2;
              break;
            case 2:
              x = l.ax - width / 2;
              y = l.ay - d - l.height;
              break;
            case 3:
              x = l.ax - width / 2;
              y = l.ay + d;
              break;
            case 4:
              x = l.ax + e;
              y = l.ay - e - l.height;
              break;
            case 5:
              x = l.ax + e;
              y = l.ay + e;
              break;
            case 6:
              x = l.ax - e - width;
              y = l.ay - e - l.height;
              break;
            default:
              x = l.ax - e - width;
              y = l.ay + e;
          }
          const x1 = x + width;
          const y1 = y + l.height;
          if (x < 0 || y < 0 || x1 > W || y1 > H) continue;
          const slot = ring * 8 + c;
          let cost = rank - (slot === prevSlot ? bonus : 0);
          if (cost >= best) continue;
          let free = true;
          for (let q = 0; q < nNear; q++) {
            const o = 4 * nearRects[q]!;
            if (x < rects[o + 2]! && rects[o]! < x1 && y < rects[o + 3]! && rects[o + 1]! < y1) {
              free = false;
              break;
            }
          }
          if (!free) continue;
          if (fd < neighbourReach) {
            const cx = (x + x1) / 2 - l.ax;
            const cy = (y + y1) / 2 - l.ay;
            const cl = Math.sqrt(cx * cx + cy * cy);
            if (cl > 0) cost += NEIGHBOUR_COST * Math.max(0, (cx * fx + cy * fy) / cl);
            // The labels of two neighbouring anchors keep the anchors' order: labels are read row by row, so one
            // set beside its marker (or diagonally) keeps the vertical order, one above or below it the horizontal
            // one. A label level with the other marker, the other's level with this one, reads crosswise however
            // short the leaders.
            const mx = (x + x1) / 2;
            const my = (y + y1) / 2;
            const vertical = c === 2 || c === 3;
            for (let k = 0; k < nLinks; k++) {
              const o = 4 * k;
              const ax = cents[o]!;
              const ay = cents[o + 1]!;
              const dax = l.ax - ax;
              const day = l.ay - ay;
              if (dax * dax + day * day >= neighbourReach * neighbourReach) continue;
              if (vertical ? Math.abs(dax) > orderTol && dax * (mx - cents[o + 2]!) < 0 : Math.abs(day) > orderTol && day * (my - cents[o + 3]!) < 0) cost += ORDER_COST;
            }
          }
          if (cost >= best) continue;
          if (lines) cost += LINE_LEN_COST * lines.length(x - margin, y - margin, x1 + margin, y1 + margin);
          if (cost >= best) continue;
          // another marker's icon nearer to the plate than its own anchor: it would read as that marker's label
          const own = rectDist(l.ax, l.ay, x, y, x1, y1);
          for (let q = 0; q < nIcons; q++) {
            const ic = icons[nearIcons[q]!]!;
            if (!ic.pair || (Math.abs(ic.x - l.ax) < 0.5 && Math.abs(ic.y - l.ay) < 0.5)) continue;
            if (rectDist(ic.x, ic.y, x, y, x1, y1) + ic.r * 0.5 + 2 < own) {
              cost += FOREIGN_COST;
              break;
            }
          }
          if (cost >= best) continue;
          // the connector to the plate (a leader where one is drawn) must not cross an icon, an arm or a
          // handle of the gizmo, or another label's connector
          const qx = Math.max(x, Math.min(l.ax, x1));
          const qy = Math.max(y, Math.min(l.ay, y1));
          if (own > l.clear + 2 * scale) {
            let crosses = false;
            for (let q = 0; q < nIcons; q++) {
              const ic = icons[nearIcons[q]!]!;
              if (Math.abs(ic.x - l.ax) < 0.5 && Math.abs(ic.y - l.ay) < 0.5) continue;
              if (segDist(ic.x, ic.y, l.ax, l.ay, qx, qy) < ic.r * 0.9) {
                crosses = true;
                break;
              }
            }
            for (let k = 0; !crosses && k < nLinks; k++) {
              const o = 4 * k;
              if (segmentsCross(l.ax, l.ay, qx, qy, links[o]!, links[o + 1]!, links[o + 2]!, links[o + 3]!)) crosses = true;
            }
            if (crosses) cost += FOREIGN_COST;
          }
          if (cost < best) {
            best = cost;
            found = true;
            bx = x;
            by = y;
            bfar = ring > 0;
            bslot = slot;
            bShort = form === 1;
          }
          // the place beside its anchor it had is still free and costs nothing beyond its rank: it keeps it (no
          // flip to a slightly better-ranked place that has just come free); a place on the outer ring is
          // searched again every time, so a label does not stay out on a leader once room comes back
          if (step < 0 && found && ring === 0 && best <= rank - bonus) break;
        }
      }
    }
    if (!found) continue;
    if (bShort) l.width = l.altWidth;
    const width = l.width;
    l.far = bfar;
    l.short = bShort;
    l.x = Math.round(bx);
    l.y = Math.round(by);
    l.placed = true;
    if (memory && l.key) memory.set(l.key, bslot);
    rects[4 * n] = bx;
    rects[4 * n + 1] = by;
    rects[4 * n + 2] = bx + width;
    rects[4 * n + 3] = by + l.height;
    n++;
    links[4 * nLinks] = l.ax;
    links[4 * nLinks + 1] = l.ay;
    links[4 * nLinks + 2] = Math.max(bx, Math.min(l.ax, bx + width));
    links[4 * nLinks + 3] = Math.max(by, Math.min(l.ay, by + l.height));
    cents[4 * nLinks] = l.ax;
    cents[4 * nLinks + 1] = l.ay;
    cents[4 * nLinks + 2] = bx + width / 2;
    cents[4 * nLinks + 3] = by + l.height / 2;
    nLinks++;
  }
}
