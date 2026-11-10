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
