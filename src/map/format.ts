/**
 * Number formatting for map labels and tooltips (ASCII plus the few symbols of the glyph atlas). Large numbers
 * are grouped in threes with a narrow no-break space, as in the HUD.
 */

const RAD = 180 / Math.PI;
/** Narrow no-break space: thousands separator. */
export const GROUP = ' ';

/** Fixed-point number with its integer part grouped in threes. */
export function formatGrouped(x: number, decimals = 0): string {
  const s = Math.abs(x).toFixed(decimals);
  const dot = s.indexOf('.');
  const int = dot < 0 ? s : s.slice(0, dot);
  let out = '';
  for (let i = 0; i < int.length; i++) {
    if (i > 0 && (int.length - i) % 3 === 0) out += GROUP;
    out += int[i];
  }
  return `${x < 0 && Number(s) !== 0 ? '-' : ''}${out}${dot < 0 ? '' : s.slice(dot)}`;
}

/**
 * A length as the flight HUD writes it (the same rule as src/ui/format.ts formatLength, which src/map may not
 * import), so a map label and the HUD panel beside it never show one quantity in two units: m below 10 km
 * (0.1 m below 100 m), km below 10,000 km (a `distance` with two decimals below 100 km and none from 1,000 km),
 * Mm below 10 million km (two decimals below 100 Mm), Gm above. `apsis` (apoapsis / periapsis altitude) never
 * uses metres and keeps one decimal in km up to 10,000 km; `altitude` keeps metres up to 50 km.
 */
export function formatDistance(m: number, style: 'distance' | 'altitude' | 'apsis' = 'distance'): string {
  if (!Number.isFinite(m)) return '--';
  const a = Math.abs(m);
  const num = (x: number, decimals: number): string => formatGrouped(x, decimals).replace('-', MINUS);
  const meterLimit = style === 'altitude' ? 5e4 : style === 'apsis' ? 0 : 1e4;
  if (a < meterLimit) return `${num(m, a < 100 ? 1 : 0)}${GROUP}m`;
  if (a < 1e5 && style === 'distance') return `${num(m / 1e3, 2)}${GROUP}km`;
  if (a < 1e6 || (a < 1e7 && style !== 'distance')) return `${num(m / 1e3, 1)}${GROUP}km`;
  if (a < 1e7) return `${num(m / 1e3, 0)}${GROUP}km`;
  if (a < 1e10) return `${num(m / 1e6, a < 1e8 ? 2 : 1)}${GROUP}Mm`;
  return `${num(m / 1e9, 3)}${GROUP}Gm`;
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

/**
 * Short form of a long place name, for a label that finds no room in full: "<place>, <facility> <number>" becomes
 * the place's first two words and the facility's initials with its number ("Ka Lae Pacific Spaceport, Launch
 * Complex 1" -> "Ka Lae LC-1"), a facility without a number keeps its initials alone; a name without a comma
 * keeps its first two words when it has more than three. Shorter names come back unchanged.
 */
export function shortSiteName(name: string): string {
  const parts = name.split(/,\s*/).filter((p) => p.length > 0);
  if (parts.length < 2) {
    const w = name.split(/\s+/).filter((x) => x.length > 0);
    return w.length > 3 ? w.slice(0, 2).join(' ') : name;
  }
  const place = parts[0]!.split(/\s+/).filter((x) => x.length > 0).slice(0, 2).join(' ');
  const words = parts[parts.length - 1]!.split(/\s+/).filter((x) => x.length > 0);
  const last = words[words.length - 1] ?? '';
  const num = words.length > 1 && /\d/.test(last) ? words.pop()! : null;
  const initials = words.map((w) => w[0]!.toUpperCase()).join('');
  const short = num ? `${place} ${initials}-${num}` : `${place} ${initials}`;
  return short.length < name.length ? short : name;
}

/** Minus sign and no-break space of the HUD's countdowns ("T− 44:10"). */
export const MINUS = '−';
export const NBSP = ' ';

/** Clock form of a duration, as the HUD writes countdowns: "3d 18:51", "1:32:00", "44:10", "0:09". */
export function formatClock(s: number): string {
  if (!Number.isFinite(s)) return '--';
  const a = Math.floor(Math.abs(s));
  const d = Math.floor(a / 86400);
  const h = Math.floor((a % 86400) / 3600);
  const m = Math.floor((a % 3600) / 60);
  const sec = a % 60;
  const p2 = (n: number): string => n.toString().padStart(2, '0');
  if (d > 0) return `${d}d${NBSP}${p2(h)}:${p2(m)}`;
  if (h > 0) return `${h}:${p2(m)}:${p2(sec)}`;
  return `${m}:${p2(sec)}`;
}

/**
 * Time relative to now, in the HUD's countdown notation (one notation for labels, tooltips and the panel):
 * "T− 3d 18:51" / "T− 1:32:00" / "T− 0:09" before the event (also "T− 0:00" within its last second, as the HUD's
 * formatCountdown writes it), "T+ 0:12" after it.
 */
export function formatTimeTo(dt: number): string {
  return dt >= 0 ? `T${MINUS}${NBSP}${formatClock(dt)}` : `T+${NBSP}${formatClock(-dt)}`;
}

/**
 * Time to an event for the panel's editable field: the countdown notation to a tenth of a second, readable back
 * by parseDuration: "T− 2d 03:04:05.0", "T− 1:02:03.4", "T− 4:05.0", "T− 0:12.5".
 */
export function formatDurationField(s: number): string {
  if (!Number.isFinite(s)) return '--';
  const tenths = Math.round(Math.abs(s) * 10);
  const d = Math.floor(tenths / 864000);
  const h = Math.floor((tenths % 864000) / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const sec = (tenths % 600) / 10;
  const p2 = (n: number): string => n.toString().padStart(2, '0');
  const ss = sec.toFixed(1).padStart(4, '0');
  const body = d > 0 ? `${d}d ${p2(h)}:${p2(m)}:${ss}` : h > 0 ? `${h}:${p2(m)}:${ss}` : `${m}:${ss}`;
  return s < 0 ? `T+${NBSP}${body}` : `T${MINUS}${NBSP}${body}`;
}

/** J2000.0 epoch (2000-01-01 12:00:00, treated as UTC as the HUD does), ms since the Unix epoch. */
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** Calendar time of a UT (s since J2000) as the HUD's clock shows it, without the zone: "2028-03-03 20:26:40". */
export function formatUtDate(ut: number): string {
  if (!Number.isFinite(ut)) return '--';
  const d = new Date(J2000_MS + Math.floor(ut) * 1000);
  const p2 = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

/**
 * A typed calendar time "YYYY-MM-DD HH:MM[:SS[.s]]" (optionally ending in "UTC", a "T" between date and time
 * accepted) as UT in s since J2000, or NaN.
 */
export function parseUtDate(text: string): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ t]+(\d{1,2}):(\d{2})(?::(\d{2}(?:[.,]\d+)?))?(?:\s*utc)?$/i.exec(text.trim());
  if (!m) return NaN;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const sec = m[6] ? Number(m[6].replace(',', '.')) : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || !(sec < 60)) return NaN;
  return (Date.UTC(y, mo - 1, d, h, mi, 0) - J2000_MS) / 1000 + sec;
}

const UNIT_SECONDS: Record<string, number> = { d: 86400, h: 3600, m: 60, min: 60, s: 1 };

/**
 * A typed duration in seconds, or NaN. Accepts plain seconds ("90", "12.5"), clock form ("1:30",
 * "2:03:04.5", "1:02:03:04" with days, "2d 03:04:05" as the panel writes it), and unit form ("1h 30m",
 * "2d4h", "90 s", "1.5h"), each optionally prefixed by "T-" / "T−" or "in". A comma works as the decimal
 * separator.
 */
export function parseDuration(text: string): number {
  let t = text.trim().toLowerCase().replace(/,/g, '.').replace(/ /g, ' ');
  t = t.replace(/^(t\s*[-−]|in\s)\s*/, '');
  if (t === '') return NaN;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const dayClock = /^(\d+)\s*d\s+(\d+(?::\d+){1,2}(?:\.\d+)?)$/.exec(t);
  if (dayClock) {
    const rest = parseDuration(dayClock[2]!);
    return Number.isFinite(rest) ? Number(dayClock[1]) * 86400 + rest : NaN;
  }
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
  return `${s}°Δ±·→ ${MINUS}${NBSP}`;
})();
