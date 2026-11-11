/**
 * MfdPainter: the six cockpit multi-function display pages (flight, orbit, systems, staging, entry, landing),
 * drawn with Canvas 2D from the same display models and formatters as the HUD (src/ui/model.ts, format.ts).
 * Designed for 1024 x 768 at 15 Hz (rendering-design 10.6) and legible down to 512 x 384: every size is
 * proportional to the canvas height and no text is smaller than 3 % of it (12 px at 384).
 *
 * Every page has its own layout, with the instrument dominating it and the page filled edge to edge:
 *   FLT  a primary flight display: a large attitude indicator (graded sky and ground, a pitch ladder every
 *        5 deg with numerals at both ends of every 10 deg line, a fixed bank scale with the sky pointer against
 *        it, the velocity vector), speed and altitude tapes, a vertical-speed scale, a heading tape, and a strip
 *        of throttle / g / horizontal / vertical boxes;
 *   ORB  the conic around the body (its own colour), with the altitude exaggerated for low orbits so Ap and Pe
 *        stay apart; rows on the left;
 *   SYS  vehicle rows and the resources: full-height tank gauges while there are few (up to six), large bars
 *        grouped by stage group otherwise;
 *   STG  a next-stage summary strip and the whole remaining stack;
 *   ENT  entry rows, g / dose / ablator / temperature gauges with scales, zones, redlines and readouts, and the
 *        landing-target rows;
 *   LND  landing rows and target rows beside a full-height north-up landing scope.
 *
 * `buildMfdPage` returns the text content of a page (title, label/value rows, status); `paint` draws it with
 * the page's instruments. The landing and entry pages carry the landing-target rows verbatim.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { MfdPage, MfdPainter } from '@/core/contracts/ui';
import { WARP_LEVELS } from '@/core/contracts/defs';
import { drawIcon, MARKER_COLORS, MARKER_ICONS, STAGE_ICONS, stageIconFor, TREND_ICONS } from '../icons';
import {
  formatApsis,
  formatBearing,
  formatDeltaV,
  formatG,
  formatHeatFlux,
  formatMach,
  formatMass,
  formatMet,
  formatNumber,
  formatPercent,
  formatPressure,
  formatRadAsDeg,
  formatTwr,
  formatUt,
  NBSP,
  type VerticalTrend,
} from '../format';
import {
  activeVesselOf,
  describeFlight,
  describeLandingTarget,
  describeNodeBurn,
  describeOrbit,
  describeResources,
  describeStages,
  describeWarp,
  ABLATOR_REDLINE,
  ablatorTone,
  G_SCALE,
  gTone,
  isLanded,
  landingScope,
  landingTargetRows,
} from '../model';

export const MFD_PAGES: readonly MfdPage[] = ['flight', 'orbit', 'systems', 'staging', 'entry', 'landing'];

const TAB: Record<MfdPage, string> = { flight: 'FLT', orbit: 'ORB', systems: 'SYS', staging: 'STG', entry: 'ENT', landing: 'LND' };
const TITLE: Record<MfdPage, string> = { flight: 'Flight', orbit: 'Orbit', systems: 'Systems', staging: 'Staging', entry: 'Entry', landing: 'Landing' };

export type Tone = 'normal' | 'accent' | 'good' | 'caution' | 'warning' | 'dim';

export interface MfdRow {
  label: string;
  value: string;
  tone?: Tone;
  /** Drawn before the value (vertical-speed direction). */
  icon?: VerticalTrend;
}

export interface MfdPageModel {
  page: MfdPage;
  title: string;
  /** Main label/value rows. */
  rows: MfdRow[];
  /** Second block of rows (landing target, resources...) with its own heading. */
  section?: { heading: string; rows: MfdRow[] };
  /** One-line status at the bottom (SAS / RCS / warp). */
  status: string;
}

const COLORS: Record<Tone, string> = {
  normal: '#eaf2ff',
  accent: '#55d4ff',
  good: '#5fe39a',
  caution: '#ffbb4d',
  warning: '#ff6a6a',
  dim: '#8492a7',
};
const BG = '#03060a';
const PANEL = '#0b121b';
const PANEL_HI = '#101a26';
const RULE = 'rgba(120,150,190,0.26)';
const LABEL = '#97a7bd';
const FONT = 'Bahnschrift, "DIN Alternate", "Segoe UI", system-ui, sans-serif';
/** Smallest text on any page, as a fraction of the page height. */
const MIN_TEXT = 0.03;
const ORANGE = '#ffa53a';

const SAS_TEXT: Record<string, string> = {
  stability: 'STABILITY',
  prograde: 'PROGRADE',
  retrograde: 'RETROGRADE',
  normal: 'NORMAL',
  antinormal: 'ANTI-NORMAL',
  radialOut: 'RADIAL OUT',
  radialIn: 'RADIAL IN',
  maneuver: 'MANEUVER',
};

const toneOf = (t: 'normal' | 'caution' | 'warning'): Tone => t;

function statusLine(s: SimSnapshot): string {
  const r = s.readouts;
  const sas = r.sasEnabled ? `SAS ${SAS_TEXT[r.sasMode] ?? r.sasMode}` : 'SAS OFF';
  return `${sas}   RCS ${r.rcsEnabled ? 'ON' : 'OFF'}   WARP ${describeWarp(s, WARP_LEVELS).factor}`;
}

/** Text content of an MFD page (shared with tests and the HUD comparison). */
export function buildMfdPage(page: MfdPage, s: SimSnapshot, defs: DefLibrary): MfdPageModel {
  const r = s.readouts;
  const status = statusLine(s);
  const lt = describeLandingTarget(s);
  const ltSection = lt ? { heading: `${lt.kindLabel}: ${lt.name}`, rows: landingTargetRows(lt).map(([label, value]) => ({ label, value })) } : undefined;
  switch (page) {
    case 'flight': {
      const f = describeFlight(s);
      const radar = f.altitudeSource === 'radar';
      return {
        page,
        title: TITLE[page],
        rows: [
          { label: radar ? 'Radar alt' : 'Altitude', value: f.altitude, tone: 'accent' },
          { label: 'Vertical', value: f.verticalSpeed, icon: f.verticalTrend, tone: r.verticalSpeed < -50 && radar ? 'caution' : 'normal' },
          { label: f.speedMode === 'surface' ? 'Surface spd' : 'Orbital spd', value: f.speed },
          { label: 'Horizontal', value: f.horizontalSpeed },
          { label: 'Pitch', value: f.pitch },
          { label: 'Heading', value: f.heading },
          { label: 'Roll', value: f.roll },
          { label: 'Throttle', value: f.throttle },
          { label: 'G load', value: f.gLoad, tone: toneOf(gTone(r.gLoad)) },
        ],
        status,
      };
    }
    case 'orbit': {
      const o = describeOrbit(s);
      const nb = describeNodeBurn(s);
      const v = activeVesselOf(s);
      const landed = isLanded(v);
      const none = '—';
      const bodyName = v ? (defs.bodies[v.bodyId]?.name ?? v.bodyId) : none;
      // Landed there is no orbit to tabulate: one status line (the page gives the space to the body graphic).
      if (landed) return { page, title: TITLE[page], rows: [{ label: 'Body', value: bodyName }, { label: 'Situation', value: 'Landed · no orbit', tone: 'dim' }], status };
      return {
        page,
        title: TITLE[page],
        rows: [
          { label: 'Body', value: bodyName },
          { label: 'Apoapsis', value: o.apoapsis, tone: 'accent' },
          { label: 'Time to Ap', value: o.apoapsisTime },
          { label: 'Periapsis', value: o.periapsis, tone: r.periapsisAltitude < 0 ? 'warning' : 'accent' },
          { label: 'Time to Pe', value: o.periapsisTime },
          { label: 'Inclination', value: o.inclination },
          { label: 'Eccentricity', value: o.eccentricity },
          { label: 'Period', value: o.period },
        ],
        section: nb
          ? {
              heading: 'Maneuver',
              rows: [
                { label: 'Δv remaining', value: nb.deltaV, tone: nb.insufficient ? 'warning' : 'accent' },
                { label: 'Burn time', value: nb.burnTime },
                { label: 'Burn start', value: nb.startIn, tone: nb.imminent ? 'caution' : 'normal' },
              ],
            }
          : undefined,
        status,
      };
    }
    case 'systems': {
      const groups = describeResources(s, defs);
      const rows: MfdRow[] = [
        { label: 'Mass', value: formatMass(r.mass) },
        { label: 'Thrust', value: `${formatNumber(r.thrust / 1000, 1)}${NBSP}kN` },
        { label: 'TWR', value: formatTwr(r.twr) },
        { label: 'Δv total', value: formatDeltaV(r.deltaVTotal), tone: 'accent' },
        { label: 'RCS fuel', value: r.rcsFraction !== null ? formatPercent(r.rcsFraction) : '—' },
        { label: 'Max skin temp', value: formatPercent(r.maxTempFraction), tone: r.maxTempFraction > 0.85 ? 'warning' : r.maxTempFraction > 0.7 ? 'caution' : 'normal' },
        { label: 'Gear', value: r.legsDeployed === null ? 'none' : r.legsDeployed ? 'DOWN' : 'UP', tone: r.legsDeployed ? 'good' : 'normal' },
        { label: 'Lights', value: r.lightsOn ? 'ON' : 'OFF' },
        { label: 'Fine control', value: r.fineControl ? 'ON' : 'OFF', tone: r.fineControl ? 'accent' : 'normal' },
      ];
      return {
        page,
        title: TITLE[page],
        rows,
        section: { heading: 'Resources', rows: groups.flatMap((g) => g.bars.map((b) => ({ label: `${g.label} · ${b.name}`, value: b.amount, tone: b.fraction < 0.1 ? ('caution' as Tone) : ('normal' as Tone) }))) },
        status,
      };
    }
    case 'staging': {
      const st = describeStages(s);
      const remaining = st.tiles.filter((t) => !t.fired);
      const next = remaining.find((t) => t.next);
      const active = st.active >= 0 ? st.tiles[st.active] : undefined;
      // The summary strip shows the stage that is burning; before the first ignition, the next engine stage.
      const subject = active ?? (next?.hasEngines ? next : undefined);
      return {
        page,
        title: TITLE[page],
        rows: [
          { label: 'Active stage', value: active ? `${active.number} · ${active.label}` : 'none', tone: active ? 'good' : 'dim' },
          { label: 'Next stage', value: next ? `${next.number} · ${next.label}` : 'none', tone: 'accent' },
          { label: 'Stage Δv', value: subject ? subject.deltaV : '—' },
          { label: 'Stage TWR', value: subject ? subject.twr : '—' },
          { label: 'Stage burn', value: subject ? subject.burnTime : '—' },
          { label: 'Stages left', value: `${remaining.length}` },
          { label: 'Δv remaining (vac)', value: st.deltaVTotal, tone: 'accent' },
          { label: 'Staging', value: st.lockout ? 'LOCKED' : 'READY', tone: st.lockout ? 'caution' : 'good' },
        ],
        status,
      };
    }
    case 'entry': {
      const doseFrac = r.gDoseLimit > 0 ? r.gDose / r.gDoseLimit : 0;
      const rows: MfdRow[] = [
        { label: 'G load', value: formatG(r.gLoad), tone: r.gLoad >= G_SCALE.limit ? 'warning' : r.gLoad >= G_SCALE.caution ? 'caution' : 'accent' },
        { label: 'G dose', value: `${formatNumber(r.gDose, 1)} / ${formatNumber(r.gDoseLimit, 0)}${NBSP}g·s`, tone: doseFrac > 0.7 ? 'warning' : doseFrac > 0.4 ? 'caution' : 'normal' },
        { label: 'Heat flux', value: formatHeatFlux(r.heatFlux) },
        { label: 'Ablator', value: r.ablatorFraction !== null ? formatPercent(r.ablatorFraction) : 'none', tone: r.ablatorFraction === null ? 'dim' : ablatorTone(r.ablatorFraction) === 'warning' ? 'warning' : 'normal' },
        { label: 'Skin temp', value: formatPercent(r.maxTempFraction), tone: r.maxTempFraction > 0.85 ? 'warning' : r.maxTempFraction > 0.7 ? 'caution' : 'normal' },
        { label: 'Dyn. pressure', value: formatPressure(r.dynamicPressure) },
        { label: 'Mach', value: formatMach(r.mach) },
        { label: 'Angle of attack', value: formatRadAsDeg(r.angleOfAttack) },
        { label: 'Lift vector', value: r.liftVectorUp === null ? '—' : r.liftVectorUp ? 'LIFT UP' : 'LIFT DOWN', tone: r.liftVectorUp === null ? 'dim' : 'accent' },
        { label: 'Chutes', value: r.chuteEnvelope === null ? '—' : r.chuteEnvelope.toUpperCase(), tone: r.chuteEnvelope === 'safe' ? 'good' : r.chuteEnvelope === 'risky' ? 'caution' : r.chuteEnvelope === 'unsafe' ? 'warning' : 'dim' },
      ];
      return { page, title: TITLE[page], rows, section: ltSection, status };
    }
    case 'landing': {
      const f = describeFlight(s, 'radar');
      const rows: MfdRow[] = [
        { label: 'Radar alt', value: f.altitude, tone: 'accent' },
        { label: 'Vertical', value: f.verticalSpeed, icon: f.verticalTrend, tone: r.verticalSpeed < -5 && r.altitudeRadar < 200 ? 'warning' : 'normal' },
        { label: 'Horizontal', value: f.horizontalSpeed, tone: r.horizontalSpeed > 2 && r.altitudeRadar < 100 ? 'caution' : 'normal' },
        { label: 'Tilt', value: formatRadAsDeg(r.tiltFromVertical), tone: r.tiltFromVertical > (12 * Math.PI) / 180 ? 'caution' : 'normal' },
        { label: 'Gear', value: r.legsDeployed === null ? 'none' : r.legsDeployed ? 'DOWN' : 'UP', tone: r.legsDeployed ? 'good' : r.altitudeRadar < 1000 ? 'caution' : 'normal' },
        { label: 'Terrain', value: s.terrain.pending ? 'LOADING' : s.terrain.complete ? 'FINAL' : 'COARSE', tone: s.terrain.pending ? 'caution' : 'normal' },
      ];
      return { page, title: TITLE[page], rows, section: ltSection, status };
    }
  }
}

type Ctx = OffscreenCanvasRenderingContext2D;

/** Page geometry: canvas size, content box between header and footer, and the text floor. */
export interface Frame {
  w: number;
  h: number;
  top: number;
  bottom: number;
  pad: number;
  /** Smallest text size, px. */
  min: number;
}

const px = (f: Frame, frac: number): number => Math.round(Math.max(f.h * frac, f.min));

function setFont(ctx: Ctx, weight: number, size: number): void {
  ctx.font = `${weight} ${Math.round(size)}px ${FONT}`;
}

function text(ctx: Ctx, s: string, x: number, y: number, align: CanvasTextAlign, base: CanvasTextBaseline, color: string, maxWidth?: number): void {
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.fillStyle = color;
  if (maxWidth !== undefined) ctx.fillText(s, x, y, maxWidth);
  else ctx.fillText(s, x, y);
}

function bar(ctx: Ctx, x: number, y: number, w: number, h: number, frac: number, color: string): void {
  ctx.fillStyle = 'rgba(120,150,190,0.18)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
}

/** A framed box with a small label above a value (status strips). */
function statBox(ctx: Ctx, f: Frame, x: number, y: number, w: number, h: number, label: string, value: string, tone: Tone = 'normal', icon?: VerticalTrend): void {
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  setFont(ctx, 600, px(f, MIN_TEXT));
  text(ctx, label.toUpperCase(), x + w * 0.06, y + h * 0.3, 'left', 'middle', LABEL, w * 0.9);
  const vs = Math.min(h * 0.4, px(f, 0.042));
  setFont(ctx, 700, vs);
  const tw = Math.min(ctx.measureText(value).width, w * 0.86);
  text(ctx, value, x + w * 0.94, y + h * 0.7, 'right', 'middle', COLORS[tone], w * 0.86);
  if (icon) drawIcon(ctx, TREND_ICONS[icon], x + w * 0.94 - tw - vs * 0.7, y + h * 0.7, vs * 1.05, trendColor(icon), null);
}

const trendColor = (t: VerticalTrend): string => (t === 'up' ? COLORS.good : t === 'down' ? COLORS.caution : LABEL);

/** Label / value rows; returns the y below the last row. */
function drawRows(ctx: Ctx, f: Frame, rows: MfdRow[], x: number, y: number, w: number, rowH: number, maxRows: number): number {
  const shown = rows.slice(0, maxRows);
  const lf = Math.max(Math.min(rowH * 0.46, f.h * 0.034), f.min);
  const vf = Math.max(Math.min(rowH * 0.56, f.h * 0.042), f.min);
  shown.forEach((row, i) => {
    const yy = y + i * rowH;
    if (i % 2 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(x, yy, w, rowH);
    }
    setFont(ctx, 500, lf);
    text(ctx, row.label.toUpperCase(), x + rowH * 0.25, yy + rowH / 2, 'left', 'middle', LABEL, w * 0.56);
    setFont(ctx, 600, vf);
    const right = x + w - rowH * 0.25;
    text(ctx, row.value, right, yy + rowH / 2, 'right', 'middle', COLORS[row.tone ?? 'normal'], w * 0.6);
    if (row.icon) {
      const tw = Math.min(ctx.measureText(row.value).width, w * 0.6);
      drawIcon(ctx, TREND_ICONS[row.icon], right - tw - vf * 0.75, yy + rowH / 2, vf * 1.05, trendColor(row.icon), null);
    }
  });
  return y + shown.length * rowH;
}

function sectionHeading(ctx: Ctx, f: Frame, s: string, x: number, y: number, w: number): void {
  setFont(ctx, 700, px(f, 0.032));
  text(ctx, s.toUpperCase(), x, y, 'left', 'middle', COLORS.accent, w);
}

function drawHeader(ctx: Ctx, w: number, h: number, page: MfdPage, s: SimSnapshot): number {
  const hh = Math.round(h * 0.085);
  ctx.fillStyle = PANEL;
  ctx.fillRect(0, 0, w, hh);
  const tabW = (w * 0.66) / MFD_PAGES.length;
  MFD_PAGES.forEach((p, i) => {
    const x = i * tabW;
    const on = p === page;
    if (on) {
      ctx.fillStyle = PANEL_HI;
      ctx.fillRect(x + tabW * 0.08, 0, tabW * 0.84, hh);
    }
    setFont(ctx, on ? 700 : 500, hh * 0.42);
    text(ctx, TAB[p], x + tabW / 2, hh * 0.5, 'center', 'middle', on ? COLORS.accent : LABEL);
    if (on) {
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(x + tabW * 0.18, hh - Math.max(2, hh * 0.07), tabW * 0.64, Math.max(2, hh * 0.07));
    }
  });
  setFont(ctx, 600, hh * 0.42);
  text(ctx, formatMet(s.readouts.met), w - hh * 0.4, hh * 0.5, 'right', 'middle', COLORS.normal);
  ctx.fillStyle = RULE;
  ctx.fillRect(0, hh, w, 1);
  return hh;
}

function drawFooter(ctx: Ctx, w: number, h: number, model: MfdPageModel, s: SimSnapshot): void {
  const fh = Math.round(h * 0.062);
  ctx.fillStyle = PANEL;
  ctx.fillRect(0, h - fh, w, fh);
  ctx.fillStyle = RULE;
  ctx.fillRect(0, h - fh, w, 1);
  setFont(ctx, 600, Math.max(fh * 0.48, h * MIN_TEXT));
  text(ctx, model.status, fh * 0.5, h - fh / 2, 'left', 'middle', s.readouts.sasEnabled ? COLORS.accent : LABEL);
  setFont(ctx, 500, Math.max(fh * 0.48, h * MIN_TEXT));
  text(ctx, formatUt(s.ut), w - fh * 0.5, h - fh / 2, 'right', 'middle', LABEL);
}

// ------------------------------------------------------------------------------------------------ flight

/** A "nice" tape step (1, 2, 5 x 10^n) near `x`. */
function niceStep(x: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-9))));
  const m = x / e;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
}

/**
 * A vertical tape (speed or altitude): ticks moving past a fixed pointer box that holds the current value.
 * `side` is where the ADI is: the pointer box points that way. A scale numeral is drawn only where it is whole:
 * clear of both tape ends and of the pointer box (glass-cockpit tapes mask them completely). `floor` is the
 * scale's lower end (a speed tape ends at zero): below it the tape is hatched and carries no ticks.
 */
function drawTape(ctx: Ctx, f: Frame, x: number, y: number, tw: number, th: number, value: number, boxText: string, title: string, side: 'left' | 'right', fmt: (v: number) => string, minSpan: number, floor = -Infinity): void {
  const span = Math.max(minSpan, Math.abs(value) * 0.08);
  const step = niceStep(span / 4);
  const pxPer = th / span;
  const bh = px(f, 0.06);
  const fs = px(f, MIN_TEXT);
  ctx.save();
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, tw, th);
  ctx.beginPath();
  ctx.rect(x, y, tw, th);
  ctx.clip();
  const cy = y + th / 2;
  const tickX = side === 'right' ? x + tw : x;
  const dir = side === 'right' ? -1 : 1;
  // Below the scale's floor: hatched, no ticks.
  const floorY = cy - (floor - value) * pxPer;
  if (floorY < y + th) {
    ctx.fillStyle = 'rgba(120,150,190,0.08)';
    ctx.fillRect(x, floorY, tw, y + th - floorY);
    ctx.strokeStyle = 'rgba(120,150,190,0.22)';
    ctx.lineWidth = 1;
    for (let k = -th; k < tw + th; k += f.h * 0.022) {
      ctx.beginPath();
      ctx.moveTo(x + k, floorY);
      ctx.lineTo(x + k - (y + th - floorY), y + th);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = 'rgba(220,230,245,0.75)';
  ctx.lineWidth = Math.max(1, f.h * 0.003);
  setFont(ctx, 600, fs);
  const first = Math.max(Math.floor((value - span) / (step / 2)) * (step / 2), floor);
  for (let v = first; v <= value + span; v += step / 2) {
    const yy = cy - (v - value) * pxPer;
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    const len = tw * (major ? 0.2 : 0.11);
    ctx.beginPath();
    ctx.moveTo(tickX, yy);
    ctx.lineTo(tickX + dir * len, yy);
    ctx.stroke();
    // A numeral only where its whole line fits: inside the tape and outside the pointer box.
    const halfLine = fs * 0.62;
    const whole = yy - halfLine >= y + 1 && yy + halfLine <= y + th - 1 && Math.abs(yy - cy) >= bh / 2 + halfLine;
    if (major && whole) text(ctx, fmt(v), tickX + dir * tw * 0.27, yy, side === 'right' ? 'right' : 'left', 'middle', '#c9d5e4');
  }
  ctx.restore();
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1);
  // Pointer box with the exact value (the model's string), pointing toward the ADI.
  const bx0 = x - (side === 'left' ? tw * 0.08 : 0);
  const bw = tw * 1.08;
  ctx.beginPath();
  if (side === 'right') {
    ctx.moveTo(bx0, cy - bh / 2);
    ctx.lineTo(bx0 + bw, cy - bh / 2);
    ctx.lineTo(bx0 + bw + bh * 0.3, cy);
    ctx.lineTo(bx0 + bw, cy + bh / 2);
    ctx.lineTo(bx0, cy + bh / 2);
  } else {
    ctx.moveTo(bx0 + bw, cy - bh / 2);
    ctx.lineTo(bx0, cy - bh / 2);
    ctx.lineTo(bx0 - bh * 0.3, cy);
    ctx.lineTo(bx0, cy + bh / 2);
    ctx.lineTo(bx0 + bw, cy + bh / 2);
  }
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.strokeStyle = COLORS.normal;
  ctx.lineWidth = Math.max(1.5, f.h * 0.003);
  ctx.stroke();
  setFont(ctx, 700, px(f, 0.04));
  text(ctx, boxText, bx0 + bw / 2, cy, 'center', 'middle', COLORS.normal, bw * 0.92);
  setFont(ctx, 600, px(f, MIN_TEXT));
  text(ctx, title, x + tw / 2, y - f.h * 0.012, 'center', 'bottom', LABEL, tw * 1.2);
}

/** Vertical speed on a log scale (+-1 / 10 / 100 / 1000 m/s) with a pointer. */
function drawVsi(ctx: Ctx, f: Frame, x: number, y: number, tw: number, th: number, vs: number): void {
  const cy = y + th / 2;
  const map = (v: number): number => (Math.sign(v) * Math.log10(1 + Math.abs(v)) / Math.log10(1001)) * (th / 2);
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, tw, th);
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1);
  setFont(ctx, 600, px(f, MIN_TEXT));
  ctx.strokeStyle = 'rgba(220,230,245,0.7)';
  ctx.lineWidth = Math.max(1, f.h * 0.003);
  // Short ticks on the left edge; the numerals right-aligned after them, a clear gap between the two.
  const tick = Math.min(tw * 0.16, f.h * 0.012);
  for (const [v, l] of [[0, '0'], [10, '10'], [100, '100'], [1000, '1k'], [-10, '10'], [-100, '100'], [-1000, '1k']] as [number, string][]) {
    const yy = cy - map(v) * 0.94;
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + (v === 0 ? tick * 1.8 : tick), yy);
    ctx.stroke();
    text(ctx, l, x + tw - Math.max(2, tw * 0.06), yy, 'right', 'middle', '#c9d5e4', tw - tick - Math.max(4, tw * 0.12));
  }
  const py = cy - map(Math.max(-1000, Math.min(1000, vs))) * 0.94;
  ctx.strokeStyle = vs > 0.05 ? COLORS.good : vs < -0.05 ? COLORS.caution : COLORS.normal;
  ctx.lineWidth = Math.max(2, f.h * 0.005);
  ctx.beginPath();
  ctx.moveTo(x - tw * 0.25, cy);
  ctx.lineTo(x + tw * 0.4, py);
  ctx.stroke();
  setFont(ctx, 600, px(f, MIN_TEXT));
  text(ctx, 'V/S', x + tw / 2, y - f.h * 0.012, 'center', 'bottom', LABEL);
}

/** Horizontal heading tape under the ADI (+-35 deg) with the boxed heading. */
function drawHeadingTape(ctx: Ctx, f: Frame, cx: number, y: number, tw: number, th: number, heading: number, headingText: string): void {
  const x = cx - tw / 2;
  const pxPerDeg = tw / 70;
  ctx.save();
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, tw, th);
  ctx.beginPath();
  ctx.rect(x, y, tw, th);
  ctx.clip();
  ctx.strokeStyle = 'rgba(220,230,245,0.75)';
  ctx.lineWidth = Math.max(1, f.h * 0.003);
  setFont(ctx, 600, px(f, 0.032));
  const start = Math.floor((heading - 36) / 5) * 5;
  for (let d = start; d <= heading + 36; d += 5) {
    const xx = cx + (d - heading) * pxPerDeg;
    const major = d % 10 === 0;
    ctx.beginPath();
    ctx.moveTo(xx, y);
    ctx.lineTo(xx, y + th * (major ? 0.32 : 0.18));
    ctx.stroke();
    if (major) {
      const n = ((d % 360) + 360) % 360;
      const name = ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' } as Record<number, string>)[n] ?? String(n / 10).padStart(2, '0');
      // Only labels that sit whole inside the tape, with a margin from its ends.
      const half = ctx.measureText(name).width / 2 + f.h * 0.006;
      if (xx - half >= x && xx + half <= x + tw) text(ctx, name, xx, y + th * 0.66, 'center', 'middle', n % 90 === 0 ? COLORS.normal : '#c9d5e4');
    }
  }
  ctx.restore();
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1);
  // Boxed heading above the tape centre, pointing down at it.
  const bw = px(f, 0.13);
  const bh = px(f, 0.05);
  const by = y - bh * 0.95;
  ctx.beginPath();
  ctx.moveTo(cx - bw / 2, by);
  ctx.lineTo(cx + bw / 2, by);
  ctx.lineTo(cx + bw / 2, by + bh * 0.8);
  ctx.lineTo(cx + bh * 0.25, by + bh * 0.8);
  ctx.lineTo(cx, by + bh * 1.05);
  ctx.lineTo(cx - bh * 0.25, by + bh * 0.8);
  ctx.lineTo(cx - bw / 2, by + bh * 0.8);
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.strokeStyle = COLORS.normal;
  ctx.lineWidth = Math.max(1.5, f.h * 0.003);
  ctx.stroke();
  setFont(ctx, 700, px(f, 0.036));
  text(ctx, headingText, cx, by + bh * 0.42, 'center', 'middle', COLORS.normal);
}

/**
 * Attitude indicator: graded sky and ground rotated by roll, a pitch ladder (every 5 deg, numerals at both ends
 * of every 10 deg line, none near the aircraft symbol) clipped to 0.8 r, a fixed bank scale outside the disc
 * with the sky pointer against it, the fixed aircraft symbol and the velocity vector.
 */
function drawAdi(ctx: Ctx, f: Frame, cx: number, cy: number, r: number, s: SimSnapshot): void {
  const pitch = s.navball.pitchDeg;
  const roll = (s.navball.rollDeg * Math.PI) / 180;
  const ladderR = r * 0.8;
  const pxPerDeg = ladderR / 25;
  const off = pitch * pxPerDeg;
  // Zenith and nadir on the ladder's scale (90 deg from the horizon): the fills are graded around them, so the
  // disc is never one flat colour, and the ladder continues over the pole.
  const zenY = off - 90 * pxPerDeg;
  const nadY = off + 90 * pxPerDeg;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-roll);
  const sky = ctx.createRadialGradient(0, zenY, 0, 0, zenY, 90 * pxPerDeg);
  sky.addColorStop(0, '#0d2f5e');
  sky.addColorStop(0.55, '#2c74bd');
  sky.addColorStop(1, '#5aa6e8');
  ctx.fillStyle = sky;
  ctx.fillRect(-2 * r, off - 6 * r, 4 * r, 6 * r);
  const ground = ctx.createRadialGradient(0, nadY, 0, 0, nadY, 90 * pxPerDeg);
  ground.addColorStop(0, '#2e1808');
  ground.addColorStop(0.55, '#7a4720');
  ground.addColorStop(1, '#a8693a');
  ctx.fillStyle = ground;
  ctx.fillRect(-2 * r, off, 4 * r, 6 * r);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, r * 0.016);
  ctx.beginPath();
  ctx.moveTo(-2 * r, off);
  ctx.lineTo(2 * r, off);
  ctx.stroke();
  // Pitch ladder, every 5 deg, continued over the poles (a line 10 deg past the zenith reads 80, on the other
  // side). A rung is drawn only where the ladder's clip leaves most of it (no lens-shaped slivers at the edge);
  // numerals stay upright whatever the roll.
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, ladderR, 0, Math.PI * 2);
  ctx.clip();
  const lw = Math.max(1.5, r * 0.011);
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  const numSize = Math.max(r * 0.085, f.min);
  setFont(ctx, 600, numSize);
  const upright = (label: string, x: number, y: number, align: CanvasTextAlign): void => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(roll);
    text(ctx, label, 0, 0, align, 'middle', '#ffffff');
    ctx.restore();
  };
  for (let p = -175; p <= 175; p += 5) {
    if (p === 0 || Math.abs(p) === 90) continue;
    const y = off - p * pxPerDeg;
    const major = p % 10 === 0;
    const half = major ? r * 0.24 : r * 0.1;
    const chord = ladderR * ladderR - y * y;
    if (chord <= 0 || Math.sqrt(chord) < half * 0.85 + lw) continue;
    const real = Math.abs(p) > 90 ? Math.sign(p) * (180 - Math.abs(p)) : p;
    if (real < 0 && major) {
      // Below the horizon: split lines.
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(-half * 0.35, y);
      ctx.moveTo(half * 0.35, y);
      ctx.lineTo(half, y);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(half, y);
      ctx.stroke();
    }
    // Numerals at both ends where they fit whole, kept off the aircraft symbol (none within 4 deg of the centre).
    if (major && Math.abs(y) > 4 * pxPerDeg && Math.sqrt(chord) > half + r * 0.04 + numSize * 1.3) {
      const label = String(Math.abs(real));
      upright(label, -half - r * 0.04 - numSize * 0.55, y, 'center');
      upright(label, half + r * 0.04 + numSize * 0.55, y, 'center');
    }
  }
  ctx.restore();
  // Zenith (a ring with eight spokes) and nadir (a ring with a cross) marks.
  const poleMark = (y: number, zenith: boolean): void => {
    if (Math.abs(y) > r * 1.2) return;
    const pr = r * 0.075;
    ctx.save();
    ctx.translate(0, y);
    ctx.lineCap = 'round';
    for (const [col, wd] of [
      ['rgba(0,0,0,0.6)', lw * 2.6],
      [zenith ? '#ffffff' : '#ffe2be', lw * 1.3],
    ] as [string, number][]) {
      ctx.strokeStyle = col;
      ctx.lineWidth = wd;
      ctx.beginPath();
      ctx.arc(0, 0, pr, 0, Math.PI * 2);
      for (let k = 0; k < (zenith ? 8 : 4); k++) {
        const a = (k * Math.PI * 2) / (zenith ? 8 : 4) + (zenith ? 0 : Math.PI / 4);
        const r0 = zenith ? pr * 1.35 : 0;
        const r1 = zenith ? pr * 2.1 : pr;
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      }
      ctx.stroke();
    }
    ctx.restore();
  };
  poleMark(zenY, true);
  poleMark(nadY, false);
  // Sky pointer: rides with the horizon against the fixed bank scale.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.985);
  ctx.lineTo(-r * 0.055, -r * 0.88);
  ctx.lineTo(r * 0.055, -r * 0.88);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Rim and fixed bank scale outside the disc (0, 10, 20, 30, 45, 60 deg each side) with the top index.
  ctx.strokeStyle = 'rgba(210,222,238,0.6)';
  ctx.lineWidth = Math.max(1.5, r * 0.012);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#e6edf6';
  for (const a of [10, 20, 30, 45, 60]) {
    for (const sgn of [-1, 1]) {
      const t = (sgn * a * Math.PI) / 180;
      const long = a === 30 || a === 60;
      const r1 = r * (long ? 1.1 : 1.065);
      ctx.lineWidth = Math.max(1.5, r * (long ? 0.014 : 0.01));
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(t) * r * 1.015, cy - Math.cos(t) * r * 1.015);
      ctx.lineTo(cx + Math.sin(t) * r1, cy - Math.cos(t) * r1);
      ctx.stroke();
    }
  }
  ctx.fillStyle = '#e6edf6';
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 1.015);
  ctx.lineTo(cx - r * 0.05, cy - r * 1.1);
  ctx.lineTo(cx + r * 0.05, cy - r * 1.1);
  ctx.closePath();
  ctx.fill();

  // Fixed aircraft symbol: two wings and an open centre square.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const wing = (sgn: number): void => {
    ctx.beginPath();
    ctx.moveTo(cx + sgn * r * 0.56, cy);
    ctx.lineTo(cx + sgn * r * 0.22, cy);
    ctx.lineTo(cx + sgn * r * 0.22, cy + r * 0.08);
  };
  for (const [col, wd] of [
    ['rgba(0,0,0,0.85)', Math.max(4, r * 0.05)],
    [ORANGE, Math.max(2.5, r * 0.028)],
  ] as [string, number][]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = wd;
    wing(-1);
    ctx.stroke();
    wing(1);
    ctx.stroke();
    ctx.strokeRect(cx - r * 0.025, cy - r * 0.025, r * 0.05, r * 0.05);
  }

  // Velocity vector (navball prograde in the vessel frame) within the ladder, drawn over the aircraft symbol so
  // a velocity on the nose shows around its open centre.
  const pg = s.navball.markers.prograde;
  if (pg && pg.y > 0.05) {
    const az = (Math.atan2(pg.x, pg.y) * 180) / Math.PI;
    const el = (Math.atan2(pg.z, Math.hypot(pg.x, pg.y)) * 180) / Math.PI;
    const vx = az * pxPerDeg;
    const vy = -el * pxPerDeg;
    if (Math.hypot(vx, vy) < ladderR * 0.92) drawIcon(ctx, MARKER_ICONS.prograde, cx + vx, cy + vy, r * 0.17, MARKER_COLORS.prograde);
  }
}

function paintFlight(ctx: Ctx, f: Frame, s: SimSnapshot, model: MfdPageModel): void {
  const fl = describeFlight(s);
  const r = s.readouts;
  const { w, h } = f;
  // The ADI takes about 60 % of the page height, tapes on both sides, the heading tape under it.
  const headingH = h * 0.065;
  const areaTop = f.top + h * 0.045;
  const areaBottom = f.bottom - headingH - h * 0.05;
  const rr = Math.min((areaBottom - areaTop) / 2 / 1.06, w * 0.25);
  const cx = w / 2;
  const cy = areaTop + rr * 1.08;
  drawAdi(ctx, f, cx, cy, rr, s);
  const tapeW = w * 0.13;
  const tapeH = rr * 1.7;
  const tapeY = cy - rr * 0.95;
  const speed = fl.speedMode === 'surface' ? r.speedSurface : r.speedOrbital;
  const leftX = f.pad + w * 0.02;
  // A speed cannot be negative: the speed tape's scale ends at zero.
  drawTape(ctx, f, leftX, tapeY, tapeW, tapeH, speed, formatNumber(speed, 1), fl.speedMode === 'surface' ? 'SRF SPD m/s' : 'ORB SPD m/s', 'right', (v) => formatNumber(v, 0), 60, 0);
  const radar = fl.altitudeSource === 'radar';
  const alt = radar ? r.altitudeRadar : r.altitudeAsl;
  const altFmt = (v: number): string => (Math.abs(alt) >= 2e4 ? `${formatNumber(v / 1000, 0)}` : formatNumber(v, 0));
  const altTitle = `${radar ? 'RADAR ALT' : 'ALT'} ${Math.abs(alt) >= 2e4 ? 'km' : 'm'}`;
  const vsiW = w * 0.055;
  const altX = w - f.pad - vsiW - w * 0.015 - tapeW;
  drawTape(ctx, f, altX, tapeY, tapeW, tapeH, alt, fl.altitude, altTitle, 'left', altFmt, 300);
  drawVsi(ctx, f, w - f.pad - vsiW, tapeY, vsiW, tapeH, r.verticalSpeed);
  const tapeHalf = rr * 0.66;
  drawHeadingTape(ctx, f, cx, f.bottom - headingH, tapeHalf * 2, headingH, s.navball.headingDeg, fl.heading);
  // Read-out boxes under the tapes: throttle and g on the left, horizontal and vertical speed on the right.
  const row = (label: string): MfdRow => model.rows.find((x) => x.label === label)!;
  const boxTop = tapeY + tapeH + h * 0.035;
  const boxH = Math.min(h * 0.085, (f.bottom - boxTop - h * 0.012) / 2);
  const lw = tapeW * 1.25;
  const rw = w - f.pad - altX;
  statBox(ctx, f, leftX, boxTop, lw, boxH, 'Throttle', row('Throttle').value);
  statBox(ctx, f, leftX, boxTop + boxH + h * 0.012, lw, boxH, 'G load', row('G load').value, row('G load').tone ?? 'normal');
  statBox(ctx, f, altX, boxTop, rw, boxH, 'Horizontal', row('Horizontal').value);
  const vr = row('Vertical');
  statBox(ctx, f, altX, boxTop + boxH + h * 0.012, rw, boxH, 'Vertical', vr.value, vr.tone ?? 'normal', vr.icon);
  // Pitch and roll read-outs flanking the heading tape (clear of the read-out boxes whatever their length).
  const prY = f.bottom - headingH / 2;
  const gapX = h * 0.025;
  setFont(ctx, 600, px(f, MIN_TEXT));
  text(ctx, 'PITCH', cx - tapeHalf - gapX, prY - h * 0.02, 'right', 'middle', LABEL);
  text(ctx, 'ROLL', cx + tapeHalf + gapX, prY - h * 0.02, 'left', 'middle', LABEL);
  setFont(ctx, 700, px(f, 0.036));
  text(ctx, fl.pitch, cx - tapeHalf - gapX, prY + h * 0.02, 'right', 'middle', COLORS.normal, altX - (cx + tapeHalf) - gapX * 2);
  text(ctx, fl.roll, cx + tapeHalf + gapX, prY + h * 0.02, 'left', 'middle', COLORS.normal, altX - (cx + tapeHalf) - gapX * 2);
}

// ------------------------------------------------------------------------------------------------ orbit

const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Display colour of a body from its mean albedo (linear), normalised to a dark-display brightness. */
function bodyColor(meanColor: readonly number[] | undefined, gain: number): string {
  const c = meanColor ?? [0.2, 0.2, 0.2];
  const k = 0.3 / Math.max(1e-3, Math.max(c[0]!, c[1]!, c[2]!));
  return `rgb(${c.map((x) => Math.round(255 * linearToSrgb(Math.min(1, x * k * gain)))).join(',')})`;
}

/**
 * Orbit diagram: the conic around the body in its own plane, periapsis to the right. True to scale when that
 * leaves the orbit clear of the body; otherwise (low orbits) the radius is drawn as body + exaggerated altitude,
 * so a 100 x 100 km orbit is a ring well outside the disc with Ap and Pe apart, and the page says so.
 */
function drawOrbitDiagram(ctx: Ctx, f: Frame, x: number, y: number, w: number, h: number, s: SimSnapshot, defs: DefLibrary): void {
  const v = activeVesselOf(s);
  const body = v ? defs.bodies[v.bodyId] : undefined;
  if (!v || !body) return;
  const cx = x + w / 2;
  const cy = y + h * 0.47;
  const half = Math.min(w, h) / 2;
  const R = body.radius;
  const conic = s.patches.current[0]?.conic;
  const landed = isLanded(v);
  const closed = !!conic && conic.e < 1;
  const rp = conic ? (conic.e < 1 ? conic.a * (1 - conic.e) : conic.p / (1 + conic.e)) : R;
  const ra = closed ? conic.a * (1 + conic.e) : rp;
  // Map a radius to the display: true scale when the orbit is well clear of the body, else exaggerated altitude.
  let bodyR: number;
  let mapR: (r: number) => number;
  let exaggeration = 1;
  const trueScale = (half * 0.8) / Math.max(closed ? (ra + rp) / 2 + (ra - rp) / 2 : rp * 2.2, R);
  if (!landed && conic && R * trueScale > half * 0.55) {
    bodyR = half * 0.5;
    const altMax = Math.max(1000, (closed ? ra : rp * 1.5) - R);
    const k = (half * 0.86 - bodyR) / altMax;
    exaggeration = k / (bodyR / R);
    mapR = (r) => bodyR + (r - R) * k;
  } else if (landed || !conic) {
    bodyR = half * 0.55;
    mapR = (r) => (r / R) * bodyR;
  } else {
    bodyR = Math.max(3, R * trueScale);
    mapR = (r) => r * trueScale;
  }
  // The focus sits so that the drawn conic is centred in the area (true scale), or at the centre (exaggerated).
  const focusX = exaggeration > 1 || !closed ? cx : cx + ((mapR(ra) - mapR(rp)) / 2);
  // The view looks down the orbit normal: screen right = P (periapsis), screen up = Q. On the surface (no
  // conic) the vessel is at the top: screen up = its radial direction.
  const up = Math.hypot(v.r.x, v.r.y, v.r.z) > 0 ? scaleVec(v.r, 1 / Math.hypot(v.r.x, v.r.y, v.r.z)) : { x: 0, y: 0, z: 1 };
  const frame = conic ? { P: conic.P, Q: conic.Q, W: conic.W } : surfaceFrame(up);
  const sunDir = s.bodies.find((b) => b.id === body.id)?.sunDir ?? null;
  drawBodyDisc(ctx, focusX, cy, bodyR, body.render?.meanColor, body.atmosphere !== null, sunDir, frame);
  setFont(ctx, 600, px(f, MIN_TEXT));
  const name = body.name.toUpperCase();
  if (landed || !conic) {
    // On the surface: the vessel on the limb at the top.
    drawIcon(ctx, MARKER_ICONS.prograde, focusX, cy - bodyR, f.h * 0.06, MARKER_COLORS.prograde);
    text(ctx, `${name} · ${landed ? 'LANDED · NO ORBIT' : 'NO TRAJECTORY'}`, cx, y + h * 0.97, 'center', 'middle', LABEL, w);
    return;
  }
  // The conic as a polyline (clipped outside the body; hyperbolas within their asymptotes).
  const nuMax = closed ? Math.PI : Math.acos(-1 / conic.e) * 0.96;
  const steps = 240;
  const pt = (nu: number): [number, number] => {
    const rr = conic.p / (1 + conic.e * Math.cos(nu));
    const d = mapR(rr);
    return [focusX + d * Math.cos(nu), cy - d * Math.sin(nu)];
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.arc(focusX, cy, bodyR, 0, Math.PI * 2, true);
  ctx.clip('evenodd');
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = Math.max(2, f.h * 0.005);
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const nu = -nuMax + (2 * nuMax * i) / steps;
    const [px0, py0] = pt(nu);
    if (i === 0) ctx.moveTo(px0, py0);
    else ctx.lineTo(px0, py0);
  }
  if (closed) ctx.closePath();
  ctx.stroke();
  ctx.restore();
  // Apsides: diamonds with labels and values (Pe right, Ap left).
  const apsis = (nu: number, label: string, alt: number, align: 'left' | 'right'): void => {
    const [ax, ay] = pt(nu);
    const d = f.h * 0.014;
    ctx.fillStyle = COLORS.normal;
    ctx.beginPath();
    ctx.moveTo(ax, ay - d);
    ctx.lineTo(ax + d, ay);
    ctx.lineTo(ax, ay + d);
    ctx.lineTo(ax - d, ay);
    ctx.closePath();
    ctx.fill();
    // Label above the point and value below it, both clear of the vessel icon that may sit on the apsis.
    const tx = ax + (align === 'left' ? 1 : -1) * f.h * 0.012;
    setFont(ctx, 700, px(f, 0.036));
    text(ctx, label, tx, ay - f.h * 0.05, align, 'middle', COLORS.normal);
    setFont(ctx, 600, px(f, MIN_TEXT));
    text(ctx, formatApsis(alt), tx, ay + f.h * 0.05, align, 'middle', alt < 0 ? COLORS.warning : LABEL);
  };
  apsis(0, 'Pe', rp - R, 'right');
  if (closed) apsis(Math.PI, 'Ap', ra - R, 'left');
  // Vessel: true anomaly from the current position.
  const nu = Math.atan2(v.r.x * conic.Q.x + v.r.y * conic.Q.y + v.r.z * conic.Q.z, v.r.x * conic.P.x + v.r.y * conic.P.y + v.r.z * conic.P.z);
  const [vx, vy] = pt(nu);
  drawIcon(ctx, MARKER_ICONS.prograde, vx, vy, f.h * 0.06, MARKER_COLORS.prograde);
  setFont(ctx, 600, px(f, MIN_TEXT));
  const caption = !closed ? 'ESCAPE TRAJECTORY' : exaggeration > 1.5 ? `ALTITUDE EXAGGERATED ×${formatNumber(exaggeration, 0)}` : 'TRUE SCALE';
  text(ctx, `${name} · ${caption}`, cx, y + h * 0.97, 'center', 'middle', LABEL, w);
}

const scaleVec = (a: { x: number; y: number; z: number }, k: number): { x: number; y: number; z: number } => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): { x: number; y: number; z: number } => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

type Axes = { P: { x: number; y: number; z: number }; Q: { x: number; y: number; z: number }; W: { x: number; y: number; z: number } };

/** A view frame with `up` as screen up (Q), screen right P perpendicular to it, W toward the viewer. */
function surfaceFrame(up: { x: number; y: number; z: number }): Axes {
  const ref = Math.abs(up.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const p = cross3(up, ref);
  const P = scaleVec(p, 1 / Math.hypot(p.x, p.y, p.z));
  return { P, Q: up, W: cross3(P, up) };
}

/**
 * The body as seen down the view's W axis: night side in a dark tone of its own colour, the sunlit part
 * (bounded by the limb and the terminator, the projection of the great circle facing the sun) graded from the
 * sub-solar side, limb darkening, and an atmosphere rim brighter on the day side. Without a sun direction the
 * whole disc is lit from the upper left.
 */
function drawBodyDisc(ctx: Ctx, x: number, y: number, R: number, meanColor: readonly number[] | undefined, atmosphere: boolean, sunDir: { x: number; y: number; z: number } | null, axes: Axes): void {
  // Sun in the view: in-plane direction (screen x right, screen y down) and its component toward the viewer.
  const su = sunDir ? dot3(sunDir, axes.P) : -0.5;
  const sv = sunDir ? dot3(sunDir, axes.Q) : 0.5;
  const sz = sunDir ? dot3(sunDir, axes.W) : 0.7;
  const ang = Math.hypot(su, sv) > 1e-6 ? Math.atan2(-sv, su) : 0;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = bodyColor(meanColor, 0.09);
  ctx.fillRect(x - R, y - R, 2 * R, 2 * R);
  // Lit region in a frame whose +u axis points at the sun: with the sun at (c, 0, sz) in (u, v, toward the viewer),
  // the front half of the terminator projects to u = -sz sqrt(R^2 - v^2) (a half-ellipse of semi-axis R |sz|);
  // the lit part lies between it and the limb on the sun's side.
  ctx.translate(x, y);
  ctx.rotate(ang);
  const n = 48;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / n;
    if (i === 0) ctx.moveTo(Math.cos(t) * R, Math.sin(t) * R);
    else ctx.lineTo(Math.cos(t) * R, Math.sin(t) * R);
  }
  for (let i = n; i >= 0; i--) {
    const vv = -R + (2 * R * i) / n;
    ctx.lineTo(-sz * Math.sqrt(Math.max(0, R * R - vv * vv)), vv);
  }
  ctx.closePath();
  const day = ctx.createLinearGradient(R, 0, Math.min(R * 0.8, -sz * R), 0);
  day.addColorStop(0, bodyColor(meanColor, 1.35));
  day.addColorStop(0.6, bodyColor(meanColor, 1.0));
  day.addColorStop(1, bodyColor(meanColor, 0.42));
  ctx.fillStyle = day;
  ctx.fill();
  ctx.rotate(-ang);
  // Limb darkening over day and night.
  const limb = ctx.createRadialGradient(0, 0, R * 0.55, 0, 0, R);
  limb.addColorStop(0, 'rgba(0,0,0,0)');
  limb.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = limb;
  ctx.fillRect(-R, -R, 2 * R, 2 * R);
  ctx.restore();
  if (atmosphere) {
    // A thin blue rim, brighter where it is lit.
    const rim = ctx.createLinearGradient(x + Math.cos(ang) * R, y + Math.sin(ang) * R, x - Math.cos(ang) * R, y - Math.sin(ang) * R);
    rim.addColorStop(0, 'rgba(120,180,255,0.8)');
    rim.addColorStop(1, 'rgba(120,180,255,0.18)');
    ctx.strokeStyle = rim;
    ctx.lineWidth = Math.max(2, R * 0.03);
    ctx.beginPath();
    ctx.arc(x, y, R + ctx.lineWidth * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function paintOrbit(ctx: Ctx, f: Frame, s: SimSnapshot, defs: DefLibrary, model: MfdPageModel): void {
  if (isLanded(activeVesselOf(s))) {
    // Landed: the status in two boxes on top and the body graphic over the rest of the page.
    const bh = f.h * 0.095;
    const gap = f.w * 0.012;
    const bw = (f.w - 2 * f.pad - gap) / 2;
    model.rows.slice(0, 2).forEach((row, i) => statBox(ctx, f, f.pad + i * (bw + gap), f.top, bw, bh, row.label, row.value, row.tone ?? 'normal'));
    const top = f.top + bh + f.h * 0.02;
    drawOrbitDiagram(ctx, f, f.pad, top, f.w - 2 * f.pad, f.bottom - top, s, defs);
    return;
  }
  const leftW = f.w * 0.4;
  const n = model.rows.length + (model.section ? model.section.rows.length + 1.3 : 0);
  const rowH = Math.min(f.h * 0.072, (f.bottom - f.top) / n);
  let y = drawRows(ctx, f, model.rows, f.pad, f.top, leftW, rowH, 12);
  if (model.section) {
    sectionHeading(ctx, f, model.section.heading, f.pad, y + rowH * 0.65, leftW);
    drawRows(ctx, f, model.section.rows, f.pad, y + rowH * 1.3, leftW, rowH, 8);
  }
  const gx = f.pad * 2 + leftW;
  drawOrbitDiagram(ctx, f, gx, f.top, f.w - gx - f.pad, f.bottom - f.top, s, defs);
}

// ---------------------------------------------------------------------------------------------- systems

function paintSystems(ctx: Ctx, f: Frame, s: SimSnapshot, defs: DefLibrary, model: MfdPageModel): void {
  const leftW = f.w * 0.42;
  const rowH = Math.min(f.h * 0.085, (f.bottom - f.top) / model.rows.length);
  drawRows(ctx, f, model.rows, f.pad, f.top, leftW, rowH, 12);
  // Resources: one block per stage group, bars as large as the column allows.
  const x = f.pad * 2.5 + leftW;
  const w = f.w - x - f.pad;
  const groups = describeResources(s, defs);
  const nBars = groups.reduce((a, g) => a + g.bars.length, 0);
  if (nBars > 0 && nBars <= TANK_LAYOUT_MAX) {
    paintTanks(ctx, f, groups, x, w);
    return;
  }
  // The resource blocks take the column's whole height (bars grow when there are few of them).
  const lines = 0.9 + groups.reduce((acc, g) => acc + 1.2 + g.bars.length * 1.25, 0);
  const lh = Math.min(f.h * 0.14, (f.bottom - f.top) / Math.max(1, lines));
  let y = f.top;
  sectionHeading(ctx, f, 'Resources', x, y + lh * 0.4, w);
  y += lh * 0.9;
  for (const g of groups) {
    setFont(ctx, 700, px(f, 0.032));
    text(ctx, g.label.toUpperCase(), x, y + lh * 0.45, 'left', 'middle', '#c9d5e4', w);
    y += lh * 0.9;
    for (const b of g.bars) {
      setFont(ctx, 500, px(f, 0.032));
      text(ctx, b.name, x + lh * 0.2, y + lh * 0.3, 'left', 'middle', LABEL, w * 0.6);
      setFont(ctx, 700, px(f, 0.034));
      text(ctx, b.amount, x + w, y + lh * 0.3, 'right', 'middle', b.fraction < RESOURCE_LOW ? COLORS.caution : COLORS.normal);
      bar(ctx, x + lh * 0.2, y + lh * 0.62, w - lh * 0.2, lh * 0.32, b.fraction, b.fraction < RESOURCE_LOW ? COLORS.caution : COLORS.good);
      y += lh * 1.25;
    }
    y += lh * 0.3;
  }
}

/** Up to this many resources the systems page draws them as full-height tank gauges side by side. */
const TANK_LAYOUT_MAX = 6;

/** Below this fraction a resource reads amber (the HUD's resource bars use the same threshold). */
const RESOURCE_LOW = 0.1;

/**
 * Few resources (late in a mission: a lander, a capsule): one tall tank gauge per resource, grouped under the
 * stage group's name, so the column is filled by instruments instead of a few bars over an empty panel.
 */
function paintTanks(ctx: Ctx, f: Frame, groups: ReturnType<typeof describeResources>, x: number, w: number): void {
  const nBars = groups.reduce((a, g) => a + g.bars.length, 0);
  sectionHeading(ctx, f, 'Resources', x, f.top + f.h * 0.03, w);
  const gap = w * 0.08;
  const slot = (w - gap * (groups.length - 1)) / nBars;
  // Group name, then the readout over each tube; scale numerals at the tube's left, the name under it.
  const groupY = f.top + f.h * 0.095;
  const tubeTop = groupY + f.h * 0.1;
  const tubeBottom = f.bottom - f.h * 0.065;
  const bw = Math.min(slot * 0.34, f.h * 0.12);
  let gx = x;
  for (const g of groups) {
    const gw = slot * g.bars.length;
    setFont(ctx, 700, px(f, 0.032));
    text(ctx, g.label.toUpperCase(), gx + gw / 2, groupY, 'center', 'middle', '#c9d5e4', gw);
    ctx.strokeStyle = RULE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx + slot * 0.12, groupY + f.h * 0.03);
    ctx.lineTo(gx + gw - slot * 0.12, groupY + f.h * 0.03);
    ctx.stroke();
    g.bars.forEach((b, i) => {
      const cx = gx + slot * (i + 0.5) + bw * 0.25;
      const low = b.fraction < RESOURCE_LOW;
      drawBarGauge(ctx, f, cx - bw / 2, tubeTop, bw, tubeBottom - tubeTop, {
        label: b.name.toUpperCase(),
        value: b.amount,
        frac: b.fraction,
        zones: [
          [RESOURCE_LOW, COLORS.caution],
          [1, COLORS.good],
        ],
        redline: null,
        ticks: [
          [0, '0'],
          [0.5, '50'],
          [1, '100'],
        ],
        tone: low ? 'caution' : 'normal',
        lowIsBad: true,
      });
    });
    gx += gw + gap;
  }
}

// ---------------------------------------------------------------------------------------------- staging

function paintStaging(ctx: Ctx, f: Frame, s: SimSnapshot, model: MfdPageModel): void {
  const st = describeStages(s);
  const active = st.active >= 0 ? st.tiles[st.active]! : null;
  // The stack: the stage burning now first (green), then the next (cyan) and the later stages.
  const tiles = [...(active ? [active] : []), ...st.tiles.filter((t) => !t.fired)];
  // Summary strip: the active stage's numbers (the next engine stage's before the first ignition), total
  // delta-v, staging state.
  const stripH = f.h * 0.095;
  const gap = f.w * 0.012;
  const get = (label: string): MfdRow => model.rows.find((r) => r.label === label)!;
  const who = active ? 'Active' : 'Next';
  const boxes: [string, MfdRow][] = [
    [`${who} Δv`, get('Stage Δv')],
    [`${who} TWR`, get('Stage TWR')],
    [`${who} burn`, get('Stage burn')],
    ['Δv remaining', get('Δv remaining (vac)')],
    ['Staging', get('Staging')],
  ];
  const bw = (f.w - 2 * f.pad - (boxes.length - 1) * gap) / boxes.length;
  boxes.forEach(([label, b], i) => statBox(ctx, f, f.pad + i * (bw + gap), f.top, bw, stripH, label, b.value, i < 3 && active ? 'good' : (b.tone ?? 'normal')));
  // The stack fills the rest of the page: tiles grow when few stages remain (two stages take two thirds of it).
  const y0 = f.top + stripH + f.h * 0.03;
  const avail = f.bottom - y0;
  const th = avail / Math.max(3, tiles.length);
  const x = f.pad;
  const w = f.w - 2 * f.pad;
  tiles.forEach((t, i) => {
    const yy = y0 + i * th;
    const isActive = t === active;
    const locked = t.next && st.lockout;
    ctx.fillStyle = isActive ? 'rgba(95,227,154,0.12)' : locked ? 'rgba(255,187,77,0.14)' : t.next ? 'rgba(85,212,255,0.13)' : i % 2 === 0 ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.015)';
    ctx.fillRect(x, yy + th * 0.05, w, th * 0.9);
    if (t.next || isActive) {
      ctx.fillStyle = isActive ? COLORS.good : locked ? COLORS.caution : COLORS.accent;
      ctx.fillRect(x, yy + th * 0.05, Math.max(3, th * 0.06), th * 0.9);
    }
    const tone = isActive ? COLORS.good : locked ? COLORS.caution : t.next ? COLORS.accent : '#d2deec';
    const s1 = Math.min(th * 0.36, f.h * 0.05);
    setFont(ctx, 700, Math.max(s1, f.min));
    text(ctx, t.number, x + th * 0.5, yy + th / 2, 'center', 'middle', tone);
    drawIcon(ctx, STAGE_ICONS[stageIconFor(t.icon)], x + th * 1.25, yy + th / 2, Math.min(th * 0.6, f.h * 0.08), tone, null);
    setFont(ctx, 600, Math.max(Math.min(th * 0.34, f.h * 0.045), f.min));
    const nameX = x + th * 1.9;
    const twoLines = th > f.min * 2.3;
    text(ctx, t.label, nameX, yy + (twoLines ? th * 0.36 : th / 2), 'left', 'middle', COLORS.normal, w * 0.45);
    // Engine stages: their numbers; engine-less stages: what firing them does.
    const meta = t.hasEngines ? `Δv ${t.deltaV}   TWR ${t.twr}   ${t.burnTime}` : t.actions;
    const tag = isActive ? 'ACTIVE · ' : '';
    setFont(ctx, 500, Math.max(Math.min(th * 0.26, f.h * 0.036), f.min));
    if (twoLines) text(ctx, locked ? 'LOCKED · after last stage' : `${tag}${meta}`, nameX, yy + th * 0.72, 'left', 'middle', locked ? COLORS.caution : isActive ? COLORS.good : LABEL, w * 0.55);
    else text(ctx, `${tag}${meta}`, x + w * 0.5, yy + th / 2, 'left', 'middle', isActive ? COLORS.good : LABEL, w * 0.28);
    if (t.propellant !== null) {
      bar(ctx, x + w * 0.8, yy + th * 0.42, w * 0.18, Math.min(th * 0.18, f.h * 0.025), t.propellant, t.propellant < 0.1 ? COLORS.caution : COLORS.good);
    }
  });
  if (tiles.length === 0) {
    setFont(ctx, 600, px(f, 0.04));
    text(ctx, 'NO STAGES LEFT', f.w / 2, y0 + avail / 2, 'center', 'middle', LABEL);
  }
}

// ------------------------------------------------------------------------------------------------ entry

export interface GaugeSpec {
  label: string;
  value: string;
  frac: number;
  /** Zone colours from the bottom: [upTo fraction, colour]. */
  zones: [number, string][];
  /** Redline fraction, or null. */
  redline: number | null;
  ticks: [number, string][];
  tone: Tone;
  /**
   * A remaining quantity, where low is bad (ablator): the whole fill takes the colour of the zone its reading is
   * in, so a nominal reading shows no red; the low zone stays a faint tint on the track under the redline.
   * Otherwise (g, dose, temperature: high is bad) the fill shows each zone it passes in that zone's colour.
   */
  lowIsBad?: boolean;
}

/** The ablator gauge of the entry page: green above the 30 % redline, red only below it. */
export function ablatorGauge(fraction: number): GaugeSpec {
  return {
    label: 'ABLATOR',
    value: formatPercent(fraction),
    frac: fraction,
    zones: [
      [ABLATOR_REDLINE, COLORS.warning],
      [1, COLORS.good],
    ],
    redline: ABLATOR_REDLINE,
    ticks: [
      [0, '0'],
      [0.5, '50'],
      [1, '100'],
    ],
    tone: ablatorTone(fraction) === 'warning' ? 'warning' : 'normal',
    lowIsBad: true,
  };
}

/** A vertical bar gauge with its scale, coloured zones, redline, readout above and label below. */
export function drawBarGauge(ctx: Ctx, f: Frame, x: number, y: number, bw: number, bh: number, g: GaugeSpec): void {
  const frac = Math.max(0, Math.min(1, g.frac));
  // Track with faint zones.
  let prev = 0;
  for (const [to, col] of g.zones) {
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = col;
    ctx.fillRect(x, y + bh * (1 - to), bw, bh * (to - prev));
    ctx.globalAlpha = 1;
    prev = to;
  }
  if (g.lowIsBad) {
    // One colour for the whole fill: the zone the reading is in.
    const zone = g.zones.find(([to]) => frac < to) ?? g.zones[g.zones.length - 1]!;
    if (frac > 0) {
      ctx.fillStyle = zone[1];
      ctx.fillRect(x, y + bh * (1 - frac), bw, bh * frac);
    }
  } else {
    // The fill in the zone colour of each part.
    prev = 0;
    for (const [to, col] of g.zones) {
      const fillTo = Math.min(to, frac);
      if (fillTo > prev) {
        ctx.fillStyle = col;
        ctx.fillRect(x, y + bh * (1 - fillTo), bw, bh * (fillTo - prev));
      }
      prev = to;
    }
  }
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
  // Scale on the left.
  setFont(ctx, 600, px(f, MIN_TEXT));
  ctx.strokeStyle = 'rgba(220,230,245,0.7)';
  ctx.lineWidth = Math.max(1, f.h * 0.0025);
  for (const [t, label] of g.ticks) {
    const yy = y + bh * (1 - t);
    ctx.beginPath();
    ctx.moveTo(x - bw * 0.18, yy);
    ctx.lineTo(x, yy);
    ctx.stroke();
    text(ctx, label, x - bw * 0.26, yy, 'right', 'middle', '#c9d5e4');
  }
  if (g.redline !== null) {
    const yy = y + bh * (1 - g.redline);
    ctx.fillStyle = COLORS.warning;
    ctx.fillRect(x - bw * 0.22, yy - Math.max(1.5, f.h * 0.003), bw * 1.44, Math.max(3, f.h * 0.006));
  }
  setFont(ctx, 700, px(f, 0.036));
  text(ctx, g.value, x + bw / 2, y - f.h * 0.03, 'center', 'middle', COLORS[g.tone]);
  setFont(ctx, 600, px(f, MIN_TEXT));
  text(ctx, g.label, x + bw / 2, y + bh + f.h * 0.03, 'center', 'middle', LABEL);
}

function paintEntry(ctx: Ctx, f: Frame, s: SimSnapshot, model: MfdPageModel): void {
  const r = s.readouts;
  const leftW = f.w * 0.42;
  const rowH = Math.min(f.h * 0.08, (f.bottom - f.top) / model.rows.length);
  drawRows(ctx, f, model.rows, f.pad, f.top, leftW, rowH, 12);
  const gx = f.pad * 2.5 + leftW;
  const gw = f.w - gx - f.pad;
  const gTop = f.top + f.h * 0.06;
  const gh = (f.bottom - f.top) * (model.section ? 0.46 : 0.78);
  const doseLimit = r.gDoseLimit > 0 ? r.gDoseLimit : 15;
  const gauges: GaugeSpec[] = [
    {
      label: 'G LOAD',
      value: formatG(r.gLoad),
      frac: r.gLoad / G_SCALE.full,
      zones: [[G_SCALE.caution / G_SCALE.full, COLORS.good], [G_SCALE.limit / G_SCALE.full, COLORS.caution], [1, COLORS.warning]],
      redline: G_SCALE.limit / G_SCALE.full,
      ticks: [[0, '0'], [4 / 12, '4'], [8 / 12, '8'], [1, '12']],
      tone: toneOf(gTone(r.gLoad)),
    },
    {
      label: 'G DOSE',
      value: `${formatNumber(r.gDose, 1)}`,
      frac: r.gDose / doseLimit,
      zones: [[0.4, COLORS.good], [0.7, COLORS.caution], [1, COLORS.warning]],
      redline: 1,
      ticks: [[0, '0'], [0.5, formatNumber(doseLimit / 2, 1)], [1, formatNumber(doseLimit, 0)]],
      tone: r.gDose / doseLimit > 0.7 ? 'warning' : r.gDose / doseLimit > 0.4 ? 'caution' : 'normal',
    },
  ];
  if (r.ablatorFraction !== null) gauges.push(ablatorGauge(r.ablatorFraction));
  gauges.push({
    label: 'SKIN TEMP',
    value: formatPercent(r.maxTempFraction),
    frac: r.maxTempFraction,
    zones: [[0.7, COLORS.good], [0.85, COLORS.caution], [1, COLORS.warning]],
    redline: 0.85,
    ticks: [[0, '0'], [0.5, '50'], [1, '100']],
    tone: r.maxTempFraction > 0.85 ? 'warning' : r.maxTempFraction > 0.7 ? 'caution' : 'normal',
  });
  const slot = gw / gauges.length;
  const bw = Math.min(slot * 0.34, f.h * 0.07);
  gauges.forEach((g, i) => drawBarGauge(ctx, f, gx + slot * i + slot * 0.52 - bw / 2, gTop, bw, gh - f.h * 0.06, g));
  if (model.section) {
    const sy = gTop + gh + f.h * 0.03;
    sectionHeading(ctx, f, model.section.heading, gx, sy, gw);
    const n = model.section.rows.length;
    drawRows(ctx, f, model.section.rows, gx, sy + f.h * 0.03, gw, Math.min(rowH, (f.bottom - sy - f.h * 0.03) / Math.max(1, n)), 6);
  }
}

// ---------------------------------------------------------------------------------------------- landing

/**
 * Landing-target scope, log-scaled rings around the vessel, north-up at every speed (model.landingScope): the
 * target from distance and bearing, the ground track as a line from the vessel while there is one. Ring labels
 * sit on the side opposite the target.
 */
function drawScope(ctx: Ctx, f: Frame, cx: number, cy: number, r: number, s: SimSnapshot): void {
  const lt = describeLandingTarget(s);
  const scope = lt ? landingScope(lt) : null;
  ctx.fillStyle = 'rgba(14,22,32,0.9)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(140,170,210,0.42)';
  ctx.lineWidth = Math.max(1, r * 0.007);
  const rings = [100, 1000, 10_000, 100_000];
  const map = (m: number): number => (Math.log10(1 + Math.abs(m) / 30) / Math.log10(1 + 300_000 / 30)) * r;
  // Ring labels stack along the vertical hair (their widths never meet), on the half away from the target.
  const labelBearing = scope && scope.north < 0 ? 0 : Math.PI;
  setFont(ctx, 600, px(f, MIN_TEXT));
  for (const m of rings) {
    ctx.beginPath();
    ctx.arc(cx, cy, map(m), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();
  for (const m of rings) {
    const lx = cx + Math.sin(labelBearing) * map(m);
    const ly = cy - Math.cos(labelBearing) * map(m);
    const label = m >= 1000 ? `${m / 1000} km` : `${m} m`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(3,6,10,0.85)';
    ctx.fillRect(lx - tw / 2 - 3, ly - f.min * 0.62, tw + 6, f.min * 1.24);
    text(ctx, label, lx, ly, 'center', 'middle', '#b7c5d8');
  }
  // North is marked outside the rim, so ring labels can stack upward without meeting it.
  setFont(ctx, 700, px(f, 0.04));
  text(ctx, 'N', cx, cy - r - f.h * 0.006, 'center', 'bottom', COLORS.normal);
  // Ground track: a dashed line from the vessel to the rim, in the prograde colour.
  const track = scope?.trackDeg ?? null;
  if (track !== null) {
    const t = (track * Math.PI) / 180;
    ctx.save();
    ctx.strokeStyle = MARKER_COLORS.prograde;
    ctx.lineWidth = Math.max(1.5, r * 0.012);
    ctx.setLineDash([r * 0.05, r * 0.035]);
    ctx.beginPath();
    ctx.moveTo(cx + Math.sin(t) * r * 0.1, cy - Math.cos(t) * r * 0.1);
    ctx.lineTo(cx + Math.sin(t) * r, cy - Math.cos(t) * r);
    ctx.stroke();
    ctx.restore();
  }
  setFont(ctx, 600, px(f, MIN_TEXT));
  text(ctx, lt === null ? 'NORTH UP' : track !== null ? `NORTH UP · TRACK ${formatBearing(track)}` : 'NORTH UP · NO GROUND TRACK', cx, cy + r + f.h * 0.035, 'center', 'middle', LABEL);
  // Vessel at the centre.
  drawIcon(ctx, MARKER_ICONS.stability, cx, cy, r * 0.13, ORANGE);
  if (!scope) return;
  const d = Math.hypot(scope.east, scope.north);
  if (d > 0.5) {
    // Beyond the outer ring the target sits on the rim, pointing the way.
    const k = Math.min(map(d), r * 0.94) / d;
    drawIcon(ctx, MARKER_ICONS.target, cx + scope.east * k, cy - scope.north * k, r * 0.15, MARKER_COLORS.target);
  } else drawIcon(ctx, MARKER_ICONS.target, cx, cy, r * 0.15, MARKER_COLORS.target);
}

function paintLanding(ctx: Ctx, f: Frame, s: SimSnapshot, model: MfdPageModel): void {
  const leftW = f.w * 0.42;
  const n = model.rows.length + (model.section ? model.section.rows.length + 1.3 : 0);
  const rowH = Math.min(f.h * 0.075, (f.bottom - f.top) / n);
  const y = drawRows(ctx, f, model.rows, f.pad, f.top, leftW, rowH, 12);
  if (model.section) {
    sectionHeading(ctx, f, model.section.heading, f.pad, y + rowH * 0.65, leftW);
    drawRows(ctx, f, model.section.rows, f.pad, y + rowH * 1.3, leftW, rowH, 8);
  }
  const gx = f.pad * 2 + leftW;
  const gw = f.w - gx - f.pad;
  const gh = f.bottom - f.top;
  const r = Math.min(gw / 2, (gh - f.h * 0.12) / 2) * 0.97;
  drawScope(ctx, f, gx + gw / 2, f.top + f.h * 0.048 + r, r, s);
}

export function createMfdPainter(): MfdPainter & { build(page: MfdPage, s: SimSnapshot, defs: DefLibrary): MfdPageModel } {
  return {
    pages: MFD_PAGES,
    build: buildMfdPage,
    paint(ctx, width, height, page, s, defs) {
      const model = buildMfdPage(page, s, defs);
      ctx.save();
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, width, height);
      const hh = drawHeader(ctx, width, height, page, s);
      const pad = height * 0.03;
      const f: Frame = { w: width, h: height, top: hh + pad, bottom: height - Math.round(height * 0.062) - pad, pad, min: height * MIN_TEXT };
      switch (page) {
        case 'flight':
          paintFlight(ctx, f, s, model);
          break;
        case 'orbit':
          paintOrbit(ctx, f, s, defs, model);
          break;
        case 'systems':
          paintSystems(ctx, f, s, defs, model);
          break;
        case 'staging':
          paintStaging(ctx, f, s, model);
          break;
        case 'entry':
          paintEntry(ctx, f, s, model);
          break;
        case 'landing':
          paintLanding(ctx, f, s, model);
          break;
      }
      drawFooter(ctx, width, height, model, s);
      ctx.restore();
    },
  };
}
