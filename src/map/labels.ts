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
  /** Resolved top-left corner, or null when no position was free. */
  x: number;
  y: number;
  placed: boolean;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Greedy de-cluttering: labels are placed in priority order at the first of eight candidate positions
 * around their anchor that overlaps neither an earlier label nor any icon; labels with no free position
 * are hidden (their icon stays and the hover tooltip still shows the details).
 */
export function declutter(labels: LabelBox[], icons: readonly { x: number; y: number; r: number }[], viewport: { width: number; height: number }, gap: number): void {
  const placed: Rect[] = [];
  const iconRects: Rect[] = icons.map((i) => ({ x0: i.x - i.r, y0: i.y - i.r, x1: i.x + i.r, y1: i.y + i.r }));
  const order = labels.map((_, i) => i).sort((a, b) => labels[b]!.priority - labels[a]!.priority || a - b);
  for (const i of order) {
    const l = labels[i]!;
    l.placed = false;
    const d = l.clear + gap;
    const candidates: [number, number][] = [
      [l.ax + d, l.ay - l.height / 2],
      [l.ax - d - l.width, l.ay - l.height / 2],
      [l.ax - l.width / 2, l.ay - d - l.height],
      [l.ax - l.width / 2, l.ay + d],
      [l.ax + d * 0.75, l.ay - d * 0.75 - l.height],
      [l.ax + d * 0.75, l.ay + d * 0.75],
      [l.ax - d * 0.75 - l.width, l.ay - d * 0.75 - l.height],
      [l.ax - d * 0.75 - l.width, l.ay + d * 0.75],
    ];
    for (const [x, y] of candidates) {
      const r: Rect = { x0: x, y0: y, x1: x + l.width, y1: y + l.height };
      if (r.x0 < 0 || r.y0 < 0 || r.x1 > viewport.width || r.y1 > viewport.height) continue;
      if (placed.some((p) => overlaps(p, r))) continue;
      if (iconRects.some((p) => overlaps(p, r))) continue;
      l.x = Math.round(x);
      l.y = Math.round(y);
      l.placed = true;
      placed.push(r);
      break;
    }
  }
}
