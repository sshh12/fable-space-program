/**
 * Number, unit and time formatters shared by the HUD and the cockpit MFD pages, so the two never disagree.
 * All inputs are SI (m, m/s, s, Pa, W/m^2, kg, rad unless the name says Deg). Output uses a narrow no-break
 * space as the thousands separator and between number and unit, and a true minus sign.
 */

export const NBSP = ' ';
const MINUS = '−';

function group(intDigits: string): string {
  let out = '';
  for (let i = 0; i < intDigits.length; i++) {
    if (i > 0 && (intDigits.length - i) % 3 === 0) out += NBSP;
    out += intDigits[i];
  }
  return out;
}

/** Fixed-point number with grouped thousands and a typographic minus. */
export function formatNumber(x: number, decimals = 0): string {
  if (!Number.isFinite(x)) return '—';
  const s = Math.abs(x).toFixed(decimals);
  const dot = s.indexOf('.');
  const int = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? '' : s.slice(dot);
  const negative = x < 0 && Number(s) !== 0;
  return `${negative ? MINUS : ''}${group(int)}${frac}`;
}

/**
 * A length with an SI prefix chosen for readability: m below 10 km (0.1 m precision below 100 m), km below
 * 10,000 km (a `distance` from 1,000 km on without decimals), Mm below 10 million km, Gm above.
 *
 * No unit or precision boundary may sit where a value hovers in flight, or the string flickers between two
 * forms. `altitude` (the current altitude) keeps metres up to 50 km for ascent and landing; no planned orbit
 * or hover is near 50 km (LEO about 185 km, the lunar parking orbit 100 km, the descent orbit 15 x 110 km is
 * crossed in passing), and above it km keep one decimal, so nothing changes form around 100 km either.
 * `apsis` (apoapsis / periapsis) never uses metres and keeps one decimal in km up to 10,000 km, so Ap and Pe
 * shown side by side share unit and precision and nothing changes form around the 100 km circular orbit.
 */
export function formatLength(m: number, style: 'distance' | 'altitude' | 'apsis' = 'distance'): string {
  if (!Number.isFinite(m)) return '—';
  const a = Math.abs(m);
  const meterLimit = style === 'altitude' ? 5e4 : style === 'apsis' ? 0 : 1e4;
  if (a < meterLimit) return `${formatNumber(m, a < 100 ? 1 : 0)}${NBSP}m`;
  if (a < 1e5 && style === 'distance') return `${formatNumber(m / 1e3, 2)}${NBSP}km`;
  // A ground distance of a thousand kilometres and more is read to the kilometre (a tenth would be noise).
  if (a < 1e6 || (a < 1e7 && style !== 'distance')) return `${formatNumber(m / 1e3, 1)}${NBSP}km`;
  if (a < 1e7) return `${formatNumber(m / 1e3, 0)}${NBSP}km`;
  if (a < 1e10) return `${formatNumber(m / 1e6, a < 1e8 ? 2 : 1)}${NBSP}Mm`;
  return `${formatNumber(m / 1e9, 3)}${NBSP}Gm`;
}

export const formatAltitude = (m: number): string => formatLength(m, 'altitude');
export const formatDistance = (m: number): string => formatLength(m, 'distance');
/** Apoapsis / periapsis altitude: always km or larger (see formatLength). */
export const formatApsis = (m: number): string => formatLength(m, 'apsis');

/** Speed in m/s with 0.1 m/s precision. */
export const formatSpeed = (mps: number): string => `${formatNumber(mps, Math.abs(mps) < 1e5 ? 1 : 0)}${NBSP}m/s`;

/** Below this magnitude (m/s) vertical speed reads as level. */
const LEVEL_SPEED = 0.05;

/**
 * Vertical speed as a signed number: "+12.3 m/s" (climbing), "−4.0 m/s" (descending), "0.0 m/s" (level). The
 * direction is drawn as an icon next to it (`verticalTrend`), never as a font glyph.
 */
export function formatVerticalSpeed(mps: number): string {
  if (!Number.isFinite(mps)) return '—';
  if (Math.abs(mps) < LEVEL_SPEED) return formatSpeed(0);
  return `${mps > 0 ? '+' : MINUS}${formatSpeed(Math.abs(mps))}`;
}

export type VerticalTrend = 'up' | 'down' | 'level';

/** Direction of a vertical speed for its icon (the same threshold as formatVerticalSpeed). */
export const verticalTrend = (mps: number): VerticalTrend => (mps >= LEVEL_SPEED ? 'up' : mps <= -LEVEL_SPEED ? 'down' : 'level');

/** Delta-v in m/s (integer above 100 m/s). */
export const formatDeltaV = (mps: number): string => `${formatNumber(mps, Math.abs(mps) < 100 ? 1 : 0)}${NBSP}m/s`;

/** Clock-style duration: "12:34", "1:02:03", "3d 04:05" (no seconds beyond a day). Negative durations get a minus sign. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const neg = seconds < 0;
  let s = Math.floor(Math.abs(seconds));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const two = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  let body: string;
  if (d > 0) body = `${d}d${NBSP}${two(h)}:${two(m)}`;
  else if (h > 0) body = `${h}:${two(m)}:${two(s)}`;
  else body = `${m}:${two(s)}`;
  return neg ? `${MINUS}${body}` : body;
}

/** Countdown "T− 12:34" (time until) or "T+ 12:34" (time since, negative input). */
export function formatCountdown(secondsUntil: number): string {
  if (!Number.isFinite(secondsUntil)) return '—';
  return secondsUntil >= 0 ? `T${MINUS}${NBSP}${formatDuration(secondsUntil)}` : `T+${NBSP}${formatDuration(-secondsUntil)}`;
}

/** Mission elapsed time, always with hours: "T+ 00:12:34" / "T+ 1d 02:03:04". */
export function formatMet(seconds: number): string {
  let s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const two = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `T+${NBSP}${d > 0 ? `${d}d${NBSP}` : ''}${two(h)}:${two(m)}:${two(s)}`;
}

/** J2000.0 epoch (2000-01-01T12:00:00, treated as UTC), ms since the Unix epoch. */
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** Universal time from seconds since J2000: "2028-03-01 14:02:11 UTC". */
export function formatUt(ut: number): string {
  if (!Number.isFinite(ut)) return '—';
  const d = new Date(J2000_MS + Math.floor(ut) * 1000);
  const two = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC`;
}

export const formatDeg = (deg: number, decimals = 1): string => `${formatNumber(deg, decimals)}°`;
export const formatRadAsDeg = (rad: number, decimals = 1): string => formatDeg((rad * 180) / Math.PI, decimals);

/** Compass bearing "045°" (0..359). */
export function formatBearing(deg: number): string {
  if (!Number.isFinite(deg)) return '—';
  const b = Math.round(((deg % 360) + 360) % 360) % 360;
  return `${b < 10 ? '00' : b < 100 ? '0' : ''}${b}°`;
}

export const formatPercent = (fraction: number): string => (Number.isFinite(fraction) ? `${Math.round(fraction * 100)}${NBSP}%` : '—');

export function formatPressure(pa: number): string {
  if (!Number.isFinite(pa)) return '—';
  if (Math.abs(pa) < 1000) return `${formatNumber(pa, 0)}${NBSP}Pa`;
  return `${formatNumber(pa / 1000, Math.abs(pa) < 1e5 ? 1 : 0)}${NBSP}kPa`;
}

export function formatHeatFlux(wpm2: number): string {
  if (!Number.isFinite(wpm2)) return '—';
  if (Math.abs(wpm2) < 1e6) return `${formatNumber(wpm2 / 1e3, 0)}${NBSP}kW/m²`;
  return `${formatNumber(wpm2 / 1e6, 2)}${NBSP}MW/m²`;
}

export const formatG = (g: number): string => `${formatNumber(g, 2)}${NBSP}g`;
export const formatMach = (mach: number): string => `M${NBSP}${formatNumber(mach, 2)}`;
export const formatTwr = (twr: number): string => formatNumber(twr, 2);

export function formatMass(kg: number): string {
  if (!Number.isFinite(kg)) return '—';
  if (Math.abs(kg) < 10_000) return `${formatNumber(kg, 0)}${NBSP}kg`;
  return `${formatNumber(kg / 1000, Math.abs(kg) < 1e6 ? 1 : 0)}${NBSP}t`;
}

export function formatForce(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1e6) return `${formatNumber(n / 1e3, 1)}${NBSP}kN`;
  return `${formatNumber(n / 1e6, 2)}${NBSP}MN`;
}

/** Warp factor "×1", "×1 000". */
export const formatWarp = (factor: number): string => `×${formatNumber(factor, 0)}`;

/**
 * A signed range with the sign spelled out: "12.3 km ahead" / "4.5 km behind" (positive = `pos`).
 * Below 0.5 m the target is "on track".
 */
export function formatSignedRange(m: number, pos: string, neg: string): string {
  if (!Number.isFinite(m)) return '—';
  if (Math.abs(m) < 0.5) return 'on track';
  return `${formatDistance(Math.abs(m))} ${m > 0 ? pos : neg}`;
}

/** Latitude / longitude "0.674° N  23.473° E". */
export function formatLatLon(latRad: number, lonRad: number): string {
  const lat = (latRad * 180) / Math.PI;
  let lon = (((lonRad * 180) / Math.PI + 540) % 360) - 180;
  if (lon === -180) lon = 180;
  return `${formatNumber(Math.abs(lat), 3)}°${NBSP}${lat >= 0 ? 'N' : 'S'}  ${formatNumber(Math.abs(lon), 3)}°${NBSP}${lon >= 0 ? 'E' : 'W'}`;
}
