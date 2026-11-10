/** Number formatting for map labels and tooltips (ASCII plus the degree and delta signs of the glyph atlas). */

const RAD = 180 / Math.PI;

export function formatDistance(m: number): string {
  const a = Math.abs(m);
  if (!Number.isFinite(m)) return '--';
  if (a < 1e4) return `${m.toFixed(0)} m`;
  if (a < 1e6) return `${(m / 1e3).toFixed(1)} km`;
  if (a < 1e8) return `${(m / 1e3).toFixed(0)} km`;
  return `${(m / 1e6).toFixed(1)} Mm`;
}

export function formatSpeed(v: number): string {
  if (!Number.isFinite(v)) return '--';
  return Math.abs(v) < 1e4 ? `${v.toFixed(1)} m/s` : `${(v / 1e3).toFixed(2)} km/s`;
}

export function formatDv(v: number): string {
  return `${v.toFixed(1)} m/s`;
}

export function formatAngleDeg(rad: number, digits = 1): string {
  return `${(rad * RAD).toFixed(digits)}°`;
}

/** Duration as "1d 02h 03m", "2h 03m 04s", "3m 04s" or "4.2s". */
export function formatDuration(s: number): string {
  if (!Number.isFinite(s)) return '--';
  const a = Math.abs(s);
  const sign = s < 0 ? '-' : '';
  if (a < 60) return `${sign}${a.toFixed(a < 10 ? 1 : 0)}s`;
  const d = Math.floor(a / 86400);
  const h = Math.floor((a % 86400) / 3600);
  const m = Math.floor((a % 3600) / 60);
  const sec = Math.floor(a % 60);
  const p2 = (n: number): string => n.toString().padStart(2, '0');
  if (d > 0) return `${sign}${d}d ${p2(h)}h ${p2(m)}m`;
  if (h > 0) return `${sign}${h}h ${p2(m)}m ${p2(sec)}s`;
  return `${sign}${m}m ${p2(sec)}s`;
}

/** Time relative to now: "T-3m 04s" before the event, "T+12s" after it. */
export function formatTimeTo(dt: number): string {
  return dt >= 0 ? `T-${formatDuration(dt)}` : `T+${formatDuration(-dt)}`;
}

/**
 * Duration for an editable field, to a tenth of a second and readable back by parseDuration:
 * "2d 03h 04m 05.0s", "1h 02m 03.4s", "4m 05.0s", "12.5s".
 */
export function formatDurationField(s: number): string {
  if (!Number.isFinite(s)) return '--';
  const sign = s < 0 ? '-' : '';
  const tenths = Math.round(Math.abs(s) * 10);
  const d = Math.floor(tenths / 864000);
  const h = Math.floor((tenths % 864000) / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const sec = (tenths % 600) / 10;
  const p2 = (n: number): string => n.toString().padStart(2, '0');
  const ss = sec.toFixed(1).padStart(4, '0');
  if (d > 0) return `${sign}${d}d ${p2(h)}h ${p2(m)}m ${ss}s`;
  if (h > 0) return `${sign}${h}h ${p2(m)}m ${ss}s`;
  if (m > 0) return `${sign}${m}m ${ss}s`;
  return `${sign}${sec.toFixed(1)}s`;
}

const UNIT_SECONDS: Record<string, number> = { d: 86400, h: 3600, m: 60, min: 60, s: 1 };

/**
 * A typed duration in seconds, or NaN. Accepts plain seconds ("90", "12.5"), clock form ("1:30",
 * "2:03:04.5", "1:02:03:04" with days), and unit form ("1h 30m", "2d4h", "90 s", "1.5h"), each optionally
 * prefixed by "T-" or "in". A comma works as the decimal separator.
 */
export function parseDuration(text: string): number {
  let t = text.trim().toLowerCase().replace(/,/g, '.');
  t = t.replace(/^(t\s*[-−]|in\s)\s*/, '');
  if (t === '') return NaN;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^\d+(:\d+){1,3}(\.\d+)?$/.test(t)) {
    const parts = t.split(':').map(Number);
    const weights = [1, 60, 3600, 86400];
    let total = 0;
    for (let i = 0; i < parts.length; i++) total += parts[parts.length - 1 - i]! * weights[i]!;
    return total;
  }
  const unit = /(\d+(?:\.\d+)?)\s*(d|h|min|m|s)/gy;
  let total = 0;
  let matched = 0;
  let m: RegExpExecArray | null;
  while ((m = unit.exec(t)) !== null) {
    total += Number(m[1]) * UNIT_SECONDS[m[2]!]!;
    while (t[unit.lastIndex] === ' ') unit.lastIndex++;
    matched = unit.lastIndex;
  }
  return matched === t.length && matched > 0 ? total : NaN;
}

/** A typed number (comma or point as the decimal separator, an optional unit after it), or NaN. */
export function parseNumber(text: string, unit?: string): number {
  let t = text.trim().replace(/,/g, '.');
  if (unit && t.toLowerCase().endsWith(unit)) t = t.slice(0, -unit.length).trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(t)) return NaN;
  return Number(t);
}

export function formatLatLon(lat: number, lon: number): string {
  const la = lat * RAD;
  let lo = lon * RAD;
  lo = ((((lo + 180) % 360) + 360) % 360) - 180;
  return `${Math.abs(la).toFixed(2)}°${la >= 0 ? 'N' : 'S'} ${Math.abs(lo).toFixed(2)}°${lo >= 0 ? 'E' : 'W'}`;
}

/** Characters the glyph atlas must contain (every string produced here and by the label code). */
export const LABEL_CHARSET = (() => {
  let s = '';
  for (let c = 32; c < 127; c++) s += String.fromCharCode(c);
  return `${s}°Δ±·→`;
})();
