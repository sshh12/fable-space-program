/**
 * Marker label text (value + time-to) and hover details, and the greedy label de-cluttering.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import { formatAngleDeg, formatDistance, formatDuration, formatLatLon, formatSpeed, formatTimeTo } from './format';
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
          head += ` ${formatDistance(m.altitude)}`;
          details.push(`Altitude ${formatDistance(m.altitude)} (${body})`);
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
        if (m.vacuumPeriapsisAltitude !== undefined) details.push(`Vacuum periapsis ${formatDistance(m.vacuumPeriapsisAltitude)}`);
        if (m.latitude !== undefined && m.longitude !== undefined) details.push(`${body} ${formatLatLon(m.latitude, m.longitude)}`);
        if (m.altitude !== undefined) details.push(`Interface altitude ${formatDistance(m.altitude)}`);
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
    details.push(`${dt >= 0 ? 'In' : 'Ago'} ${formatDuration(Math.abs(dt))}`);
    const label = item.kind === 'impactSurface' || item.kind === 'entrySurface' ? [] : [head, when];
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
}

/** Cost of a screen rectangle (device px) for a label: how much drawn line it covers (0 = none). */
export type RectCost = (x0: number, y0: number, x1: number, y1: number) => number;

/** Score of one unit of line cost against the far-ring penalty (a far label beats crossing a line). */
const LINE_COST_WEIGHT = 10;
const FAR_PENALTY = 6;
/** The outer ring of candidates lies this many device px (per CSS px) further out. */
export const FAR_RING_PX = 22;

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

/**
 * Greedy de-cluttering: labels are placed in priority order at the best of sixteen candidate positions around
 * their anchor (eight beside it, eight on an outer ring `farRing` further out, which get a leader line). A
 * candidate must overlap neither an earlier label, nor any icon, nor a blocked rectangle (node panel, tooltip,
 * HUD panels), and lie inside the viewport. Among those the one covering the least drawn line (`cost`) wins,
 * then the inner ring, then the candidate order. Labels with no free position are hidden (their icon stays and
 * the hover tooltip still shows the details).
 */
export function declutter(
  labels: readonly LabelBox[],
  icons: readonly { x: number; y: number; r: number }[],
  viewport: { width: number; height: number },
  gap: number,
  blocked: readonly BlockedRect[] = [],
  cost: RectCost | null = null,
  farRing = 0,
): void {
  // Fixed obstacles first (icons, blocked rectangles), then the labels as they are placed.
  const nFixed = icons.length + blocked.length;
  ensureRects(nFixed + labels.length);
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
  const W = viewport.width;
  const H = viewport.height;
  const rings = farRing > 0 ? 2 : 1;
  for (const i of order) {
    const l = labels[i]!;
    l.placed = false;
    l.far = false;
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (let ring = 0; ring < rings && best >= 0.1; ring++) {
      const d = l.clear + gap + ring * farRing;
      const e = d * 0.75;
      for (let c = 0; c < 8; c++) {
        let x: number;
        let y: number;
        switch (c) {
          case 0:
            x = l.ax + d;
            y = l.ay - l.height / 2;
            break;
          case 1:
            x = l.ax - d - l.width;
            y = l.ay - l.height / 2;
            break;
          case 2:
            x = l.ax - l.width / 2;
            y = l.ay - d - l.height;
            break;
          case 3:
            x = l.ax - l.width / 2;
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
            x = l.ax - e - l.width;
            y = l.ay - e - l.height;
            break;
          default:
            x = l.ax - e - l.width;
            y = l.ay + e;
        }
        const x1 = x + l.width;
        const y1 = y + l.height;
        if (x < 0 || y < 0 || x1 > W || y1 > H) continue;
        let free = true;
        for (let k = 0; k < n; k++) {
          const o = 4 * k;
          if (x < rects[o + 2]! && rects[o]! < x1 && y < rects[o + 3]! && rects[o + 1]! < y1) {
            free = false;
            break;
          }
        }
        if (!free) continue;
        const score = (cost ? cost(x, y, x1, y1) * LINE_COST_WEIGHT : 0) + ring * FAR_PENALTY + c * 0.01;
        if (score < best) {
          best = score;
          bx = x;
          by = y;
          l.far = ring > 0;
          // The first free inner candidate that crosses no line cannot be beaten.
          if (score < 0.1) break;
        }
      }
    }
    if (best === Infinity) continue;
    l.x = Math.round(bx);
    l.y = Math.round(by);
    l.placed = true;
    rects[4 * n] = bx;
    rects[4 * n + 1] = by;
    rects[4 * n + 2] = bx + l.width;
    rects[4 * n + 3] = by + l.height;
    n++;
  }
}
