/**
 * MfdPainter: the six cockpit multi-function display pages (flight, orbit, systems, staging, entry, landing),
 * drawn with Canvas 2D from the same display models and formatters as the HUD (src/ui/model.ts, format.ts).
 * Designed for 1024 x 768 at 15 Hz (rendering-design 10.6) and legible down to 512 x 384; every size is
 * proportional to the canvas height.
 *
 * `buildMfdPage` returns the text content of a page (title, label/value rows, status); `paint` draws it with
 * the page's instrument graphic. The landing and entry pages carry the landing-target rows verbatim.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { MfdPage, MfdPainter } from '@/core/contracts/ui';
import { WARP_LEVELS } from '@/core/contracts/defs';
import { drawIcon, MARKER_COLORS, MARKER_ICONS, STAGE_ICONS, stageIconFor } from '../icons';
import {
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
} from '../format';
import { activeVesselOf, describeFlight, describeLandingTarget, describeNodeBurn, describeOrbit, describeResources, describeStages, describeWarp, landingScope, landingTargetRows } from '../model';

export const MFD_PAGES: readonly MfdPage[] = ['flight', 'orbit', 'systems', 'staging', 'entry', 'landing'];

const TAB: Record<MfdPage, string> = { flight: 'FLT', orbit: 'ORB', systems: 'SYS', staging: 'STG', entry: 'ENT', landing: 'LND' };
const TITLE: Record<MfdPage, string> = { flight: 'Flight', orbit: 'Orbit', systems: 'Systems', staging: 'Staging', entry: 'Entry', landing: 'Landing' };

export type Tone = 'normal' | 'accent' | 'good' | 'caution' | 'warning' | 'dim';

export interface MfdRow {
  label: string;
  value: string;
  tone?: Tone;
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
  warning: '#ff6262',
  dim: '#7c8aa0',
};
const BG = '#03060a';
const PANEL = '#0b121b';
const RULE = 'rgba(120,150,190,0.22)';
const LABEL = '#7f90a8';
const FONT = 'Bahnschrift, "DIN Alternate", "Segoe UI", system-ui, sans-serif';

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
          { label: 'Vertical', value: f.verticalSpeed, tone: r.verticalSpeed < -50 && radar ? 'caution' : 'normal' },
          { label: f.speedMode === 'surface' ? 'Surface spd' : 'Orbital spd', value: f.speed },
          { label: 'Horizontal', value: f.horizontalSpeed },
          { label: 'Pitch', value: f.pitch },
          { label: 'Heading', value: f.heading },
          { label: 'Roll', value: f.roll },
          { label: 'Throttle', value: f.throttle },
          { label: 'G load', value: f.gLoad, tone: r.gLoad > 6 ? 'warning' : r.gLoad > 4 ? 'caution' : 'normal' },
        ],
        status,
      };
    }
    case 'orbit': {
      const o = describeOrbit(s);
      const nb = describeNodeBurn(s);
      const v = activeVesselOf(s);
      return {
        page,
        title: TITLE[page],
        rows: [
          { label: 'Body', value: v ? (defs.bodies[v.bodyId]?.name ?? v.bodyId) : '—' },
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
      return {
        page,
        title: TITLE[page],
        rows: [
          { label: 'Next stage', value: next ? `${next.number} · ${next.label}` : 'none', tone: 'accent' },
          { label: 'Stage Δv', value: next?.hasEngines ? next.deltaV : '—' },
          { label: 'Stage TWR', value: next?.hasEngines ? next.twr : '—' },
          { label: 'Stage burn', value: next?.hasEngines ? next.burnTime : '—' },
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
        { label: 'G load', value: formatG(r.gLoad), tone: r.gLoad > 8 ? 'warning' : r.gLoad > 5 ? 'caution' : 'accent' },
        { label: 'G dose', value: `${formatNumber(r.gDose, 1)} / ${formatNumber(r.gDoseLimit, 0)}${NBSP}g·s`, tone: doseFrac > 0.7 ? 'warning' : doseFrac > 0.4 ? 'caution' : 'normal' },
        { label: 'Heat flux', value: formatHeatFlux(r.heatFlux) },
        { label: 'Ablator', value: r.ablatorFraction !== null ? formatPercent(r.ablatorFraction) : 'none', tone: r.ablatorFraction !== null && r.ablatorFraction < 0.3 ? 'warning' : 'normal' },
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
        { label: 'Vertical', value: f.verticalSpeed, tone: r.verticalSpeed < -5 && r.altitudeRadar < 200 ? 'warning' : 'normal' },
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

function bar(ctx: Ctx, x: number, y: number, w: number, h: number, frac: number, color: string): void {
  ctx.fillStyle = 'rgba(120,150,190,0.16)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
}

function drawRows(ctx: Ctx, rows: MfdRow[], x: number, y: number, w: number, rowH: number, maxRows: number): number {
  const shown = rows.slice(0, maxRows);
  shown.forEach((row, i) => {
    const yy = y + i * rowH;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'transparent';
    ctx.fillRect(x, yy, w, rowH);
    ctx.font = `500 ${Math.round(rowH * 0.46)}px ${FONT}`;
    ctx.fillStyle = LABEL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(row.label.toUpperCase(), x + rowH * 0.3, yy + rowH / 2, w * 0.55);
    ctx.font = `600 ${Math.round(rowH * 0.56)}px ${FONT}`;
    ctx.fillStyle = COLORS[row.tone ?? 'normal'];
    ctx.textAlign = 'right';
    ctx.fillText(row.value, x + w - rowH * 0.3, yy + rowH / 2, w * 0.62);
  });
  return y + shown.length * rowH;
}

function drawHeader(ctx: Ctx, w: number, h: number, page: MfdPage, s: SimSnapshot): number {
  const hh = Math.round(h * 0.085);
  ctx.fillStyle = PANEL;
  ctx.fillRect(0, 0, w, hh);
  const tabW = (w * 0.62) / MFD_PAGES.length;
  MFD_PAGES.forEach((p, i) => {
    const x = i * tabW;
    const on = p === page;
    ctx.font = `${on ? 700 : 500} ${Math.round(hh * 0.4)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = on ? COLORS.accent : LABEL;
    ctx.fillText(TAB[p], x + tabW / 2, hh * 0.48);
    if (on) {
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(x + tabW * 0.18, hh - Math.max(2, hh * 0.07), tabW * 0.64, Math.max(2, hh * 0.07));
    }
  });
  ctx.font = `600 ${Math.round(hh * 0.4)}px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.normal;
  ctx.fillText(formatMet(s.readouts.met), w - hh * 0.4, hh * 0.48);
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
  ctx.font = `500 ${Math.round(fh * 0.46)}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = s.readouts.sasEnabled ? COLORS.accent : LABEL;
  ctx.fillText(model.status, fh * 0.5, h - fh / 2);
  ctx.textAlign = 'right';
  ctx.fillStyle = LABEL;
  ctx.fillText(formatUt(s.ut), w - fh * 0.5, h - fh / 2);
}

/** Artificial horizon (2-D attitude indicator) for the flight page. */
function drawAdi(ctx: Ctx, cx: number, cy: number, r: number, s: SimSnapshot): void {
  const pitch = (s.navball.pitchDeg * Math.PI) / 180;
  const roll = (s.navball.rollDeg * Math.PI) / 180;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-roll);
  const pxPerRad = r / (Math.PI / 4);
  const off = pitch * pxPerRad;
  ctx.fillStyle = '#2d6aa8';
  ctx.fillRect(-2 * r, -4 * r + off, 4 * r, 4 * r);
  ctx.fillStyle = '#7a4a22';
  ctx.fillRect(-2 * r, off, 4 * r, 4 * r);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = Math.max(1.5, r * 0.02);
  ctx.beginPath();
  ctx.moveTo(-2 * r, off);
  ctx.lineTo(2 * r, off);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, r * 0.012);
  ctx.font = `600 ${Math.round(r * 0.1)}px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let p = -90; p <= 90; p += 10) {
    if (p === 0) continue;
    const y = off - ((p * Math.PI) / 180) * pxPerRad;
    if (Math.abs(y) > r * 1.2) continue;
    const half = p % 30 === 0 ? r * 0.3 : r * 0.16;
    ctx.beginPath();
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y);
    ctx.stroke();
    if (p % 30 === 0) ctx.fillText(String(Math.abs(p)), half + r * 0.04, y);
  }
  ctx.restore();
  // Fixed aircraft symbol.
  ctx.strokeStyle = '#ffa53a';
  ctx.lineWidth = Math.max(2, r * 0.035);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.55, cy);
  ctx.lineTo(cx - r * 0.18, cy);
  ctx.lineTo(cx, cy + r * 0.12);
  ctx.lineTo(cx + r * 0.18, cy);
  ctx.lineTo(cx + r * 0.55, cy);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(200,215,235,0.5)';
  ctx.lineWidth = Math.max(1.5, r * 0.02);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  // Roll pointer.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-roll);
  ctx.fillStyle = '#eaf2ff';
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.98);
  ctx.lineTo(-r * 0.06, -r * 0.86);
  ctx.lineTo(r * 0.06, -r * 0.86);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Orbit diagram: the current conic in its own plane with the body, apsides and the vessel. */
function drawOrbit(ctx: Ctx, x: number, y: number, w: number, h: number, s: SimSnapshot, defs: DefLibrary): void {
  const v = activeVesselOf(s);
  const patch = s.patches.current[0];
  const body = v ? defs.bodies[v.bodyId] : undefined;
  if (!v || !body) return;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const R = body.radius;
  const conic = patch?.conic;
  let scale: number;
  if (conic && conic.e < 1) {
    const rp = conic.a * (1 - conic.e);
    const ra = conic.a * (1 + conic.e);
    const b = conic.a * Math.sqrt(1 - conic.e * conic.e);
    // The apsis labels sit outside the ellipse on the major axis: keep room for them inside the graphic area.
    ctx.font = `600 ${Math.round(h * 0.045)}px ${FONT}`;
    const gap = h * 0.02;
    const labelRoom = gap + Math.max(ctx.measureText('Ap').width, ctx.measureText('Pe').width) + h * 0.01;
    scale = Math.min(Math.max(1, w - 2 * labelRoom) / (rp + ra), (h * 0.92) / (2 * b));
    ctx.save();
    // Periapsis to the right; centre of the ellipse at -a e from the focus.
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = Math.max(2, h * 0.006);
    ctx.beginPath();
    // The ellipse centre sits a e from the focus, so with the focus at cx + a e it is exactly cx.
    ctx.ellipse(cx, cy, conic.a * scale, b * scale, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    const focusX = cx + ((ra - rp) / 2) * scale;
    const bodyR = Math.max(3, R * scale);
    ctx.fillStyle = '#1b3a5c';
    ctx.beginPath();
    ctx.arc(focusX, cy, bodyR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,170,230,0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Apsides.
    ctx.fillStyle = COLORS.normal;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('Pe', focusX + rp * scale + gap, cy - h * 0.04);
    ctx.textAlign = 'right';
    ctx.fillText('Ap', focusX - ra * scale - gap, cy - h * 0.04);
    // Vessel: true anomaly from the current position.
    const nu = Math.atan2(v.r.x * conic.Q.x + v.r.y * conic.Q.y + v.r.z * conic.Q.z, v.r.x * conic.P.x + v.r.y * conic.P.y + v.r.z * conic.P.z);
    const rr = conic.p / (1 + conic.e * Math.cos(nu));
    const vx = focusX + rr * Math.cos(nu) * scale;
    const vy = cy - rr * Math.sin(nu) * scale;
    drawIcon(ctx, MARKER_ICONS.prograde, vx, vy, h * 0.06, MARKER_COLORS.prograde);
  } else {
    scale = Math.min(w, h) * 0.3 / R;
    ctx.fillStyle = '#1b3a5c';
    ctx.beginPath();
    ctx.arc(cx, cy, R * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `500 ${Math.round(h * 0.05)}px ${FONT}`;
    ctx.fillStyle = LABEL;
    ctx.textAlign = 'center';
    ctx.fillText(conic ? 'ESCAPE TRAJECTORY' : 'NO ORBIT (SURFACE)', cx, y + h * 0.92);
  }
}

/**
 * Landing-target scope, log-scaled rings around the vessel, north-up at every speed (model.landingScope): the
 * target from distance and bearing, the ground track as a line from the vessel while there is one.
 */
function drawScope(ctx: Ctx, cx: number, cy: number, r: number, s: SimSnapshot): void {
  const lt = describeLandingTarget(s);
  const scope = lt ? landingScope(lt) : null;
  ctx.strokeStyle = 'rgba(120,150,190,0.35)';
  ctx.lineWidth = Math.max(1, r * 0.008);
  const rings = [100, 1000, 10_000, 100_000];
  const map = (m: number): number => (Math.log10(1 + Math.abs(m) / 30) / Math.log10(1 + 300_000 / 30)) * r;
  ctx.font = `500 ${Math.round(r * 0.075)}px ${FONT}`;
  ctx.fillStyle = LABEL;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (const m of rings) {
    ctx.beginPath();
    ctx.arc(cx, cy, map(m), 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, cx + map(m) * 0.72 + 4, cy - map(m) * 0.72);
  }
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  // The vertical hair stops short of the N above and the caption below.
  ctx.moveTo(cx, cy - r * 0.9);
  ctx.lineTo(cx, cy + r * 0.9);
  ctx.stroke();
  ctx.fillStyle = COLORS.normal;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${Math.round(r * 0.075)}px ${FONT}`;
  ctx.fillText('N', cx, cy - r);
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
  ctx.font = `500 ${Math.round(r * 0.07)}px ${FONT}`;
  ctx.fillStyle = LABEL;
  ctx.textBaseline = 'bottom';
  ctx.fillText(lt === null ? 'NORTH UP' : track !== null ? `NORTH UP · TRACK ${formatBearing(track)}` : 'NORTH UP · NO GROUND TRACK', cx, cy + r * 1.08);
  // Vessel at the centre.
  drawIcon(ctx, MARKER_ICONS.stability, cx, cy, r * 0.14, '#ffa53a');
  if (!scope) return;
  const d = Math.hypot(scope.east, scope.north);
  if (d > 0.5) {
    // Beyond the outer ring the target sits on the rim, pointing the way.
    const k = Math.min(map(d), r * 0.94) / d;
    drawIcon(ctx, MARKER_ICONS.target, cx + scope.east * k, cy - scope.north * k, r * 0.16, MARKER_COLORS.target);
  } else drawIcon(ctx, MARKER_ICONS.target, cx, cy, r * 0.16, MARKER_COLORS.target);
}

function drawStages(ctx: Ctx, x: number, y: number, w: number, h: number, s: SimSnapshot): void {
  const st = describeStages(s);
  // Every remaining stage, next first; tiles shrink to fit long stacks (and leave a row for the lockout line).
  const tiles = st.tiles.filter((t) => !t.fired);
  const th = Math.min(h / Math.max(7, tiles.length + (st.lockout ? 1 : 0)), h * 0.14);
  tiles.forEach((t, i) => {
    const yy = y + i * th;
    ctx.fillStyle = t.next ? 'rgba(85,212,255,0.12)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(x, yy + th * 0.06, w, th * 0.88);
    if (t.next) {
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(x, yy + th * 0.06, Math.max(3, th * 0.05), th * 0.88);
    }
    drawIcon(ctx, STAGE_ICONS[stageIconFor(t.icon)], x + th * 0.55, yy + th / 2, th * 0.55, t.next ? COLORS.accent : '#c9d4e3', null);
    ctx.font = `600 ${Math.round(th * 0.3)}px ${FONT}`;
    ctx.fillStyle = COLORS.normal;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${t.number}  ${t.label}`, x + th * 1.05, yy + th * 0.36, w * 0.55);
    ctx.font = `500 ${Math.round(th * 0.24)}px ${FONT}`;
    ctx.fillStyle = LABEL;
    if (t.hasEngines) ctx.fillText(`Δv ${t.deltaV}   TWR ${t.twr}   ${t.burnTime}`, x + th * 1.05, yy + th * 0.68, w * 0.7 - th * 1.25);
    if (t.propellant !== null) bar(ctx, x + w * 0.74, yy + th * 0.6, w * 0.23, th * 0.14, t.propellant, t.propellant < 0.1 ? COLORS.caution : COLORS.good);
  });
  if (st.lockout) {
    ctx.font = `700 ${Math.round(th * 0.3)}px ${FONT}`;
    ctx.fillStyle = COLORS.caution;
    ctx.textAlign = 'center';
    ctx.fillText('STAGING LOCKED', x + w / 2, y + h - th * 0.3);
  }
}

function drawEntryGauges(ctx: Ctx, x: number, y: number, w: number, h: number, s: SimSnapshot): void {
  const r = s.readouts;
  const items: [string, number, string][] = [
    ['G', Math.min(1, r.gLoad / 10), r.gLoad > 8 ? COLORS.warning : r.gLoad > 5 ? COLORS.caution : COLORS.accent],
    ['DOSE', r.gDoseLimit > 0 ? r.gDose / r.gDoseLimit : 0, COLORS.caution],
    ['ABL', r.ablatorFraction ?? 0, (r.ablatorFraction ?? 1) < 0.3 ? COLORS.warning : COLORS.good],
    ['TEMP', r.maxTempFraction, r.maxTempFraction > 0.85 ? COLORS.warning : COLORS.caution],
  ];
  const bw = w / (items.length * 1.6);
  items.forEach(([label, frac, color], i) => {
    const bx = x + i * bw * 1.6 + bw * 0.3;
    const bh = h * 0.78;
    ctx.fillStyle = 'rgba(120,150,190,0.16)';
    ctx.fillRect(bx, y, bw, bh);
    ctx.fillStyle = color;
    const f = Math.max(0, Math.min(1, frac));
    ctx.fillRect(bx, y + bh * (1 - f), bw, bh * f);
    ctx.font = `600 ${Math.round(h * 0.07)}px ${FONT}`;
    ctx.fillStyle = LABEL;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, bx + bw / 2, y + bh + h * 0.03);
  });
  // Lift vector arrow.
  if (r.liftVectorUp !== null) {
    const icon = MARKER_ICONS.liftVector;
    ctx.save();
    const cx = x + w * 0.93;
    const cy = y + h * 0.4;
    ctx.translate(cx, cy);
    if (!r.liftVectorUp) ctx.rotate(Math.PI);
    drawIcon(ctx, icon, 0, 0, h * 0.22, MARKER_COLORS.liftVector);
    ctx.restore();
  }
}

function drawResources(ctx: Ctx, x: number, y: number, w: number, h: number, s: SimSnapshot, defs: DefLibrary): void {
  const groups = describeResources(s, defs);
  const lines = groups.reduce((n, g) => n + 1 + g.bars.length, 0);
  const lh = Math.min(h / Math.max(1, lines), h * 0.09);
  let yy = y;
  for (const g of groups) {
    ctx.font = `700 ${Math.round(lh * 0.5)}px ${FONT}`;
    ctx.fillStyle = COLORS.accent;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(g.label.toUpperCase(), x, yy + lh / 2);
    yy += lh;
    for (const b of g.bars) {
      ctx.font = `500 ${Math.round(lh * 0.46)}px ${FONT}`;
      ctx.fillStyle = LABEL;
      ctx.fillText(b.name, x + lh * 0.4, yy + lh / 2, w * 0.36);
      bar(ctx, x + w * 0.4, yy + lh * 0.3, w * 0.44, lh * 0.4, b.fraction, b.fraction < 0.1 ? COLORS.caution : COLORS.good);
      ctx.fillStyle = COLORS.normal;
      ctx.textAlign = 'right';
      ctx.fillText(b.amount, x + w, yy + lh / 2);
      ctx.textAlign = 'left';
      yy += lh;
    }
  }
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
      const top = drawHeader(ctx, width, height, page, s);
      const bottom = height - Math.round(height * 0.062);
      const pad = height * 0.03;
      const contentTop = top + pad;
      const contentH = bottom - contentTop - pad;
      // Page title.
      ctx.font = `700 ${Math.round(height * 0.04)}px ${FONT}`;
      ctx.fillStyle = COLORS.normal;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(model.title.toUpperCase(), pad, contentTop);
      const rowsTop = contentTop + height * 0.06;
      const leftW = width * 0.48;
      const sectionInLeft = model.section !== undefined && page !== 'systems' && page !== 'staging' && page !== 'entry';
      const rowH = Math.min(height * 0.062, (contentH - height * 0.06) / Math.max(1, model.rows.length + (sectionInLeft ? model.section!.rows.length + 1.4 : 0)));
      let y = drawRows(ctx, model.rows, pad, rowsTop, leftW, rowH, 12);
      if (model.section && page !== 'systems' && page !== 'staging' && page !== 'entry') {
        y += rowH * 0.4;
        ctx.font = `700 ${Math.round(rowH * 0.48)}px ${FONT}`;
        ctx.fillStyle = COLORS.accent;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(model.section.heading.toUpperCase(), pad, y + rowH * 0.5, leftW);
        drawRows(ctx, model.section.rows, pad, y + rowH, leftW, rowH, 8);
      }
      const gx = pad * 2 + leftW;
      const gw = width - gx - pad;
      const gy = contentTop;
      const gh = contentH;
      switch (page) {
        case 'flight':
          drawAdi(ctx, gx + gw / 2, gy + gh * 0.48, Math.min(gw, gh) * 0.44, s);
          break;
        case 'orbit':
          drawOrbit(ctx, gx, gy, gw, gh, s, defs);
          break;
        case 'systems':
          drawResources(ctx, gx, gy + gh * 0.02, gw, gh * 0.96, s, defs);
          break;
        case 'staging':
          drawStages(ctx, gx, gy, gw, gh, s);
          break;
        case 'entry':
          drawEntryGauges(ctx, gx, gy + gh * 0.03, gw, model.section ? gh * 0.5 : gh * 0.85, s);
          if (model.section) {
            const sy = gy + gh * 0.6;
            ctx.font = `700 ${Math.round(rowH * 0.48)}px ${FONT}`;
            ctx.fillStyle = COLORS.accent;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(model.section.heading.toUpperCase(), gx, sy, gw);
            drawRows(ctx, model.section.rows, gx, sy + rowH * 0.6, gw, Math.min(rowH, (gh * 0.4 - rowH) / model.section.rows.length), 6);
          }
          break;
        case 'landing':
          drawScope(ctx, gx + gw / 2, gy + gh / 2, Math.min(gw, gh) * 0.46, s);
          break;
      }
      drawFooter(ctx, width, height, model, s);
      ctx.restore();
    },
  };
}

