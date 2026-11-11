/**
 * The flight HUD (src/core/contracts/ui.ts `Hud`): DOM + Canvas over the WebGPU canvas, with pointer events
 * only on interactive parts (marked `data-hud-interactive`; the pointer over them is PointerState.overUi, and
 * everywhere else it passes through to the scene). It renders only from the SimSnapshot and the presented
 * CameraState, and acts only by dispatching ButtonActions (the same path as the keys) or, for target selection
 * on the pad, PlayerCommands.
 *
 * Layout by camera.kind (unknown modes behave as their kind):
 *   external  everything;
 *   interior  clock, warp, notifications, stage stack and the system strip (the cockpit instruments show the rest);
 *   map       clock, warp, altitude, orbit, landing target, node burn, navball with SAS (no stage stack).
 * The bottom cluster is a three-column grid with the navball alone in the middle column, so the ball stays on
 * the screen's centre line whatever appears beside it (a maneuver panel, the gauges).
 *
 * The navball: every update renders the shared 512 x 512 texture (NavballRenderer.view, published as
 * 'ui.navball' for the cockpit) and, while the navball is on screen, the lit instrument ball at native
 * resolution into the HUD's own WebGPU canvas, under a static 2-D bezel. The app must not render the navball
 * separately.
 *
 * Main-thread cost: a changed text node costs a style / layout / paint / layerization pass of the page (about
 * 1 ms here), far more than the JavaScript that formats it. So the numeric readouts refresh at TEXT_HZ (10 Hz,
 * a readable rate for changing digits), all in the same frame, while the navball, the throttle and g gauges
 * (composited transforms) and every indicator light and panel visibility follow each frame. Any discrete
 * change (a panel appearing, SAS mode, navball mode, warp level, a stage fired...) refreshes the text in the
 * same frame, so labels and their numbers never disagree.
 */
import type { ButtonAction, PlayerCommands, SasMode } from '@/core/contracts/controls';
import { SAS_MODES } from '@/core/contracts/controls';
import { WARP_LEVELS, MAX_PHYSICS_WARP_INDEX, type DefLibrary } from '@/core/contracts/defs';
import type { CameraState, ViewKind } from '@/core/contracts/render';
import type { SimEvent, SimSnapshot } from '@/core/contracts/sim';
import type { Hud } from '@/core/contracts/ui';
import type { GpuHandle } from '@/core/gpu/device';
import { formatHeatFlux, formatMach, formatMet, formatPercent, formatPressure, formatRadAsDeg, formatUt, type VerticalTrend } from '../format';
import { LOCK_ICON, MARKER_COLORS, MARKER_ICONS, STAGE_ICONS, stageIconFor, svgIcon, TREND_ICONS, UNLOCK_ICON } from '../icons';
import {
  activeVesselOf,
  altitudeDatumName,
  altitudeSource,
  describeFlight,
  describeLandingTarget,
  describeNodeBurn,
  describeOrbit,
  describePad,
  describeResources,
  describeStages,
  describeWarp,
  G_SCALE,
  gTone,
  isLanded,
  isPredictionRow,
  landingTargetRows,
  orbitPhase,
  RADAR_ALTITUDE_SWITCH,
  type AltitudeMode,
} from '../model';
import { drawNavballBezel } from '../navball/bezel';
import { HUD_BALL_RADIUS_FRACTION } from '../navball/navballMath';
import type { NavballRendererImpl } from '../navball/navballRenderer';
import { AttrSlot, bar, classFlag, el, FillSlot, Flag, hiddenFlag, hudButton, INTERACTIVE_ATTR, RevealSlot, TextSlot, ToneSlot } from './dom';
import { HUD_CSS, HUD_STYLE_ID } from './hudStyles';

/** One line of the key-help overlay (structurally the input system's KeyHelpEntry). */
export interface HudKeyHelpEntry {
  group: string;
  text: string;
  keys: string[];
  lockedKeys: string[];
}

export interface HudOptions {
  defs: DefLibrary;
  /** GPU handle and navball renderer; the HUD renders the navball every update. */
  gpu: GpuHandle;
  navball: NavballRendererImpl;
  /** On-screen controls fire ButtonActions here (the app connects InputSystem.trigger). */
  dispatch: (action: ButtonAction) => void;
  /** Click-to-capture control (InputSystem.requestKeyboardCapture, called inside the click handler). */
  requestKeyboardCapture?: () => void;
  /** Key-help content generated from the binding table (keyHelpEntries(input.bindings)). */
  keyHelp: readonly HudKeyHelpEntry[];
  /** Key label per ButtonAction for hints on buttons (e.g. { stage: 'Space' }). */
  keyFor?: (action: ButtonAction) => string | null;
  /** Commands for target selection on the pad; when absent the pad panel only displays the target. */
  commands?: () => PlayerCommands | null;
}

export interface HudImpl extends Hud {
  readonly root: HTMLElement;
  readonly visible: boolean;
  setKeyboardLocked(locked: boolean): void;
  toggleKeyHelp(force?: boolean): void;
  readonly keyHelpOpen: boolean;
  /** CPU time of the last update and its running mean, ms (JavaScript only; see the hand-off for the full cost). */
  readonly lastUpdateMs: number;
  readonly meanUpdateMs: number;
  /** Number of updates that refreshed the text readouts (about TEXT_HZ per second while visible). */
  readonly textUpdates: number;
  /** Label/value rows currently shown by the landing-target panel (null when hidden). */
  landingTargetRows(): [string, string][] | null;
  /** Current notifications (oldest first). */
  notifications(): string[];
}

/** Refresh rate of the numeric text readouts. */
export const HUD_TEXT_HZ = 10;
const TEXT_PERIOD = 1 / HUD_TEXT_HZ;

/** Stacks longer than this show the stages after the next two as compact one-line tiles. */
const FULL_STAGE_TILES = 6;

/** Most landing-target rows (landingTargetRows). */
const LT_ROWS = 5;

const SAS_NAMES: Record<SasMode, string> = {
  stability: 'Stability',
  prograde: 'Prograde',
  retrograde: 'Retrograde',
  normal: 'Normal',
  antinormal: 'Anti-normal',
  radialOut: 'Radial out',
  radialIn: 'Radial in',
  maneuver: 'Maneuver',
};

/** Punctuation key caps show the glyph with its shifted glyph, so "." and "," never shrink to specks. */
const GLYPH_CAPS: Record<string, string> = { '.': '. >', ',': ', <', '/': '/ ?', '`': '` ~', '-': '- _', '=': '= +', '[': '[ {', ']': '] }', ';': '; :', "'": '\' "', '\\': '\\ |' };

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOAST_SECONDS = 4.5;
const MAX_TOASTS = 4;

const titleCase = (id: string): string =>
  id
    .toLowerCase()
    .split(/[_\s-]+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');

function row(label: string, value: TextSlot, valueCls = ''): { root: HTMLDivElement; label: TextSlot; valueEl: HTMLSpanElement } {
  const l = new TextSlot(label);
  const valueEl = el('span', `val ${valueCls}`.trim(), [value.node]);
  return { root: el('div', 'row', [el('span', 'lbl', [l.node]), valueEl]), label: l, valueEl };
}

function keyCap(label: string, cls = 'kbd', title?: string): HTMLSpanElement {
  const glyph = GLYPH_CAPS[label];
  return el('span', glyph ? `${cls} glyph` : cls, [glyph ?? label], title ? { title } : {});
}

/** Vertical-speed trend icon (SVG path swapped on change; class carries the tone). */
function trendIcon(): { el: SVGSVGElement; set(t: VerticalTrend): void } {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  svg.append(path);
  const d = new AttrSlot(path, 'd');
  const cls = new AttrSlot(svg, 'class');
  return {
    el: svg,
    set(t) {
      d.set(TREND_ICONS[t].stroke);
      cls.set(`vsi ${t}`);
    },
  };
}

/**
 * A tape gauge: value, numerals beside a tube whose colour layer is fixed to the scale (revealed by the fill),
 * ticks, an optional limit mark, a slot under the tube (the g-dose bar) and a caption. The four parts are grid
 * items of the gauges panel, so paired gauges share their rows.
 */
function tapeGauge(cls: string, caption: string, nums: [string, number][], ticks: number, limit: number | null, under: HTMLElement | null): { root: HTMLElement; value: TextSlot; valueEl: HTMLElement; fill: RevealSlot } {
  const value = new TextSlot('');
  const layer = el('i');
  const win = el('div', 'win', [layer]);
  const tube = el('div', 'tube', [el('div', 'track'), win, el('div', 'ticks', [], { style: `--n:${ticks}` })]);
  if (limit !== null) tube.append(el('div', 'limit', [], { style: `bottom:calc(${(limit * 100).toFixed(3)}% - 1px)` }));
  const numsEl = el('div', 'nums', nums.map(([t, f]) => el('span', '', [t], { style: `bottom:${(f * 100).toFixed(3)}%` })));
  const valueEl = el('span', 'gv', [value.node]);
  const root = el('div', `gauge ${cls}`, [valueEl, el('div', 'scale', [numsEl, tube]), el('div', 'dose', under ? [under] : []), el('span', 'gl', [caption])]);
  return { root, value, valueEl, fill: new RevealSlot(win, layer) };
}

interface StageSlot {
  /** Index into SimSnapshot.staging.stages. */
  index: number;
  dv: TextSlot;
  meta: TextSlot | null;
  fill: FillSlot | null;
  barTone: Flag | null;
}

export function createHud(opts: HudOptions): HudImpl {
  const { defs, gpu, navball, dispatch } = opts;
  const keyFor = opts.keyFor ?? (() => null);

  if (!document.getElementById(HUD_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = HUD_STYLE_ID;
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
  }

  const root = el('div', 'hud', [], { 'data-kind': 'external' });
  const kindFlag = { cur: '' as string };
  let visible = true;
  /** Altimeter source chosen by clicking the altitude panel (model.altitudeSource). */
  let altMode: AltitudeMode = 'auto';

  // ------------------------------------------------------------------------------------ top left: clock
  const met = new TextSlot('T+ 00:00:00');
  const ut = new TextSlot('');
  const warpFactor = new TextSlot('×1');
  const warpLimit = new TextSlot('');
  // Warp chevrons: one SVG, one polygon per warp level above x1 (physics-warp levels flagged 'phys').
  const chevSvg = document.createElementNS(SVG_NS, 'svg');
  chevSvg.setAttribute('class', 'chev');
  const chevCount = WARP_LEVELS.length - 1;
  const chevW = 10;
  const chevGap = 1.2;
  chevSvg.setAttribute('viewBox', `0 0 ${chevCount * chevW + (chevCount - 1) * chevGap} 10`);
  chevSvg.setAttribute('preserveAspectRatio', 'none');
  chevSvg.setAttribute('aria-hidden', 'true');
  const chevrons: SVGPolygonElement[] = [];
  for (let i = 1; i <= chevCount; i++) {
    const x = (i - 1) * (chevW + chevGap);
    const p = document.createElementNS(SVG_NS, 'polygon');
    p.setAttribute('points', `${x},0 ${x + 0.7 * chevW},0 ${x + chevW},5 ${x + 0.7 * chevW},10 ${x},10 ${x + 0.3 * chevW},5`);
    if (i <= MAX_PHYSICS_WARP_INDEX) p.setAttribute('class', 'phys');
    chevSvg.append(p);
    chevrons.push(p);
  }
  const chevOn = chevrons.map((c) => classFlag(c, 'on'));
  const chevCap = chevrons.map((c) => classFlag(c, 'cap'));
  const warpLimitEl = el('div', 'warp-limit', [warpLimit.node]);
  const warpLimitShow = hiddenFlag(warpLimitEl);
  const clock = el('div', 'panel clock', [
    el('div', 'ptitle', [el('span', '', ['Mission time']), el('span', 'rails', [])]),
    el('div', 'met', [met.node]),
    el('div', 'ut', [ut.node]),
    el('div', 'warp', [
      hudButton(['‹'], 'warpdown', 'Slower time warp (,)', () => dispatch('warpDown')),
      chevSvg,
      hudButton(['›'], 'warpup', 'Faster time warp (.)', () => dispatch('warpUp')),
      el('span', 'factor', [warpFactor.node]),
    ]),
    warpLimitEl,
  ]);
  const railsLabel = new TextSlot('');
  clock.querySelector('.rails')!.append(railsLabel.node);

  // ------------------------------------------------------------------------------- top centre: altitude
  const altLabel = new TextSlot('Altitude · sea level');
  const altValue = new TextSlot('');
  const vsValue = new TextSlot('');
  const hsValue = new TextSlot('');
  const vsIcon = trendIcon();
  vsIcon.set('level');
  const altPanel = el(
    'div',
    'panel alt',
    [
      el('div', 'ptitle', [el('span', '', [altLabel.node])]),
      el('span', 'val big', [altValue.node]),
      el('div', 'vs', [vsIcon.el, el('b', '', [vsValue.node]), el('span', '', ['·']), el('span', '', ['horiz. ', hsValue.node])]),
    ],
    {
      [INTERACTIVE_ATTR]: '',
      title: 'Click: automatic / sea level (datum on bodies without an ocean) / radar altitude',
    },
  );
  altPanel.style.display = 'block';
  altPanel.querySelector('.ptitle')!.setAttribute('style', 'justify-content:center');
  altPanel.addEventListener('click', () => {
    altMode = altMode === 'auto' ? 'asl' : altMode === 'asl' ? 'radar' : 'auto';
  });
  // Terrain-loading notice: under the altimeter (whose radar value is coarse while it shows), above the toasts.
  const notice = el('div', 'notice', [el('div', 'pill', [el('span', 'spin'), el('span', '', ['Loading terrain…'])])]);
  const noticeShow = hiddenFlag(notice);
  const toastsEl = el('div', 'toasts');
  const tc = el('div', 'tc', [el('div', '', [altPanel], { 'data-show': 'external map' }), notice, toastsEl]);

  // ------------------------------------------------------------------------- top right: keyboard + help
  const kbCapture = hudButton(
    [svgIcon(UNLOCK_ICON), el('span', '', ['Browser shortcuts active · ']), el('b', '', ['Click to capture keyboard'])],
    'pill kbcap',
    'Fullscreen with keyboard lock: Ctrl+W and similar shortcuts reach the game, and Left Ctrl becomes an extra throttle-down key',
    () => opts.requestKeyboardCapture?.(),
  );
  const kbOk = el('div', 'pill kbok', [svgIcon(LOCK_ICON), el('span', '', ['Keyboard captured'])]);
  const kbCaptureShow = hiddenFlag(kbCapture);
  const kbOkShow = hiddenFlag(kbOk);
  kbOkShow.set(false);
  let helpOpen = false;
  const helpBtn = hudButton(['?'], 'helpbtn', 'Key help (`)', () => toggleKeyHelp());
  const tr = el('div', 'tr', [kbCapture, kbOk, helpBtn], { 'data-show': 'external interior map' });

  // ----------------------------------------------------------------------------------- left column
  const orbit = { ap: new TextSlot(), apT: new TextSlot(), pe: new TextSlot(), peT: new TextSlot(), inc: new TextSlot(), per: new TextSlot() };
  const apsis = (label: string, value: TextSlot, time: TextSlot): { root: HTMLDivElement; valueEl: HTMLSpanElement; subEl: HTMLSpanElement } => {
    const valueEl = el('span', 'val', [value.node]);
    const subEl = el('span', 'sub', [time.node]);
    return { root: el('div', 'apsis', [el('span', 'lbl', [label]), valueEl, subEl]), valueEl, subEl };
  };
  const peRow = apsis('Periapsis', orbit.pe, orbit.peT);
  const peTone = new ToneSlot(peRow.valueEl);
  const peSubTone = new ToneSlot(peRow.subEl);
  const orbitPanel = el('div', 'panel orbit', [
    el('div', 'ptitle', [el('span', '', ['Orbit']), el('span', 'pname', [])]),
    apsis('Apoapsis', orbit.ap, orbit.apT).root,
    peRow.root,
    row('Inclination', orbit.inc).root,
    row('Period', orbit.per).root,
  ]);
  const orbitBody = new TextSlot('');
  orbitPanel.querySelector('.pname')!.append(orbitBody.node);
  const orbitShow = hiddenFlag(orbitPanel);

  // Atmospheric flight rows: in their own panel during an ascent, folded into the entry panel while it shows.
  const atm = { q: new TextSlot(), mach: new TextSlot(), aoa: new TextSlot() };
  const atmRows = el('div', 'atmrows', [row('Dyn. pressure', atm.q).root, row('Mach', atm.mach).root, row('Angle of attack', atm.aoa).root]);
  const atmPanel = el('div', 'panel atm', [el('div', 'ptitle', [el('span', '', ['Atmosphere'])])], { 'data-show': 'external' });
  atmPanel.append(atmRows);
  const atmShow = hiddenFlag(atmPanel);

  const entry = { flux: new TextSlot(), abl: new TextSlot(), temp: new TextSlot(), lift: new TextSlot(), chute: new TextSlot() };
  const ablBar = bar('accent');
  const tempBar = bar('caution');
  const ablRow = row('Heat shield', entry.abl);
  const ablBlock = el('div', '', [ablRow.root, ablBar.root]);
  const ablShow = hiddenFlag(ablBlock);
  const liftRow = el('div', 'row', [el('span', 'lbl', ['Lift vector']), el('span', 'lift', [entry.lift.node])]);
  const liftShow = hiddenFlag(liftRow);
  const chuteLight = el('span', 'light', [entry.chute.node]);
  const chuteTone = new ToneSlot(chuteLight);
  const chuteRow = el('div', 'row', [el('span', 'lbl', ['Chute envelope']), chuteLight]);
  const chuteShow = hiddenFlag(chuteRow);
  const fluxRow = row('Heat flux', entry.flux);
  const fluxShow = hiddenFlag(fluxRow.root);
  const entryAtmSlot = el('div', 'atmslot');
  const entrySep = el('div', 'sep');
  const entrySepShow = hiddenFlag(entrySep);
  const entryPanel = el('div', 'panel entry', [el('div', 'ptitle', [el('span', '', ['Entry'])]), entryAtmSlot, entrySep, fluxRow.root, ablBlock, row('Skin temperature', entry.temp).root, tempBar.root, liftRow, chuteRow], { 'data-show': 'external' });
  const entryShow = hiddenFlag(entryPanel);
  /** Where the atmosphere rows live: in the entry panel while it shows (one panel fewer on the left edge). */
  const atmInEntry = new Flag((on) => {
    (on ? entryAtmSlot : atmPanel).append(atmRows);
    entrySepShow.set(on);
  });

  const ltName = new TextSlot('');
  const ltKind = new TextSlot('Landing target');
  const ltRows: { label: TextSlot; value: TextSlot; root: HTMLDivElement; show: Flag; pred: Flag }[] = [];
  const ltRowsEl = el('div', 'rows');
  for (let i = 0; i < LT_ROWS; i++) {
    const v = new TextSlot();
    const r = row('', v);
    ltRows.push({ label: r.label, value: v, root: r.root, show: hiddenFlag(r.root), pred: classFlag(r.root, 'pred') });
    ltRowsEl.append(r.root);
  }
  // Recovery-zone status: a light row at value size (green inside, amber outside once it matters).
  const zoneText = new TextSlot('');
  const zoneSub = new TextSlot('');
  const zoneEl = el('div', 'zone', [el('span', 'light', [zoneText.node]), el('span', 'sub', [zoneSub.node])]);
  const zoneTone = new ToneSlot(zoneEl);
  const zoneShow = hiddenFlag(zoneEl);
  const ltPanel = el('div', 'panel lt', [el('div', 'ptitle', [el('span', '', [ltKind.node])]), el('div', 'tname', [el('span', 'pname', [ltName.node])]), ltRowsEl, zoneEl], {
    'data-show': 'external map interior',
  });
  const ltShow = hiddenFlag(ltPanel);
  let ltCurrentRows: [string, string][] | null = null;

  const pad = { target: new TextSlot(), relInc: new TextSlot(), cross: new TextSlot(), az: new TextSlot() };
  const padTargets = el('div', 'targets');
  const relIncRow = row('Relative inclination', pad.relInc);
  const crossRow = row('Plane crossing', pad.cross);
  const azRow = row('Launch azimuth', pad.az);
  const relIncShow = hiddenFlag(relIncRow.root);
  const crossShow = hiddenFlag(crossRow.root);
  const azShow = hiddenFlag(azRow.root);
  const padPanel = el('div', 'panel pad', [el('div', 'ptitle', [el('span', '', ['Launch']), el('span', 'pname', [pad.target.node])]), padTargets, relIncRow.root, crossRow.root, azRow.root], { 'data-show': 'external' });
  const padShow = hiddenFlag(padPanel);
  const targetButtons = new Map<string, { btn: HTMLButtonElement; on: Flag; show: Flag }>();
  const commands = opts.commands;
  if (commands) {
    for (const b of Object.values(defs.bodies)) {
      // The root body has no orbit to compare planes with: it is never a launch target.
      if (b.gravityRole !== 'attractor' || b.parent === null) continue;
      const btn = hudButton([b.name], '', `Set ${b.name} as target`, () => {
        const c = commands();
        if (!c) return;
        const current = lastSnapshot?.readouts.targetBodyId ?? null;
        const r = c.setTarget(current === b.id ? null : b.id);
        if (!r.ok) notify(r.reason ?? 'Target refused');
      });
      targetButtons.set(b.id, { btn, on: classFlag(btn, 'on'), show: hiddenFlag(btn) });
      padTargets.append(btn);
    }
  }
  const padTargetsShow = hiddenFlag(padTargets);

  const lcol = el('div', 'lcol', [clock, padPanel, orbitPanel, ltPanel, atmPanel, entryPanel]);

  // ---------------------------------------------------------------------------------- right column
  // The stack is a column-reverse flexbox: the next stage (first child) sits at the bottom; a stack taller than
  // the column is clipped at the far end (top), never at the next stage.
  const stagesEl = el('div', 'stages');
  const stagesMore = new TextSlot('');
  const stagesMoreEl = el('div', 'more', [stagesMore.node]);
  const resGroupsEl = el('div', 'groups');
  const resPanel = el('div', 'panel res', [el('div', 'ptitle', [el('span', '', ['Resources'])]), resGroupsEl], { 'data-show': 'external' });
  const resShow = hiddenFlag(resPanel);
  const rcol = el('div', 'rcol', [el('div', 'stagewrap', [stagesMoreEl, stagesEl], { 'data-show': 'external interior' }), resPanel]);
  let stageKey = '';
  let stageSlots: StageSlot[] = [];
  let resKey = '';
  let resSlots: { fill: FillSlot; pct: TextSlot; low: Flag }[] = [];

  // ---------------------------------------------------------------------------------- bottom cluster
  const sasBtn = hudButton(['SAS'], 'sasbtn', 'SAS on / off (T)', () => dispatch('toggleSas'));
  const rcsBtn = hudButton(['RCS'], '', 'RCS on / off (R)', () => dispatch('toggleRcs'));
  const gearBtn = hudButton(['GEAR'], '', 'Landing gear (G)', () => dispatch('toggleLegs'));
  const lightsBtn = hudButton(['LIGHTS'], '', 'Lights (U)', () => dispatch('toggleLights'));
  const fineBtn = hudButton(['FINE'], '', 'Fine control (Caps Lock)', () => dispatch('toggleFineControl'));
  const toggles = el('div', 'toggles', [sasBtn, rcsBtn, gearBtn, lightsBtn, fineBtn, hudButton(['ABORT'], 'abort', 'Abort (Backspace)', () => dispatch('abort'))]);
  const sasOn = classFlag(sasBtn, 'on');
  const rcsOn = classFlag(rcsBtn, 'on');
  const gearOn = classFlag(gearBtn, 'on');
  const lightsOn = classFlag(lightsBtn, 'on');
  const fineOn = classFlag(fineBtn, 'on');
  const gearAvail = new Flag((on) => gearBtn.setAttribute('aria-disabled', on ? 'false' : 'true'));
  const modeButtons = new Map<SasMode, { on: Flag; enabled: Flag }>();
  const modes = el('div', 'modes');
  SAS_MODES.forEach((mode, i) => {
    const icon = MARKER_ICONS[mode === 'stability' ? 'stability' : mode];
    const key = keyFor(`sas:${mode}`) ?? String(i + 1);
    const b = hudButton([svgIcon(icon, { color: MARKER_COLORS[mode === 'stability' ? 'stability' : mode] }), el('span', 'key', [key])], '', `Hold ${SAS_NAMES[mode]} (${key})`, () =>
      dispatch(`sas:${mode}`),
    );
    modes.append(b);
    modeButtons.set(mode, { on: classFlag(b, 'on'), enabled: new Flag((on) => b.setAttribute('aria-disabled', on ? 'false' : 'true')) });
  });
  const sasCaption = new TextSlot('');
  const sasPanel = el('div', 'panel sas bl', [toggles, modes, el('div', 'modecap', [sasCaption.node])], { 'data-show': 'external map' });

  const speedMode = new TextSlot('Surface');
  const speedValue = new TextSlot('');
  const speedPanel = el('div', 'panel speed', [el('div', 'ptitle', [el('span', 'mode', [speedMode.node]), el('span', '', ['speed'])]), el('span', 'val big', [speedValue.node])], {
    [INTERACTIVE_ATTR]: '',
    title: 'Click: surface / orbit navball (Tab)',
  });
  speedPanel.querySelector('.ptitle')!.setAttribute('style', 'justify-content:center');
  speedPanel.addEventListener('click', () => dispatch('toggleNavballMode'));
  const ballCanvas = el('canvas', 'ballgl');
  const bezelCanvas = el('canvas', 'bezel');
  const hdg = new TextSlot('000°');
  const pitchText = new TextSlot('');
  const rollText = new TextSlot('');
  const ball = el('div', 'ball', [
    ballCanvas,
    bezelCanvas,
    el('div', 'hdg', [hdg.node]),
    el('div', 'pr pitch', [el('span', 'lbl', ['Pitch']), pitchText.node]),
    el('div', 'pr roll', [el('span', 'lbl', ['Roll']), rollText.node]),
  ]);
  const nbwrap = el('div', 'nbwrap bc', [speedPanel, ball], { 'data-show': 'external map' });

  const doseBar = bar('caution');
  const doseShow = new Flag((on) => (doseBar.root.style.visibility = on ? 'visible' : 'hidden'));
  const thr = tapeGauge('thr', 'THROTTLE', [['0', 0], ['50', 0.5], ['100', 1]], 10, null, null);
  const gG = tapeGauge(
    'g',
    'G LOAD',
    [['0', 0], ['4', 4 / G_SCALE.full], ['8', 8 / G_SCALE.full], ['12', 1]],
    G_SCALE.full,
    G_SCALE.limit / G_SCALE.full,
    doseBar.root,
  );
  const gTextTone = new ToneSlot(gG.valueEl);
  gG.root.title = `G load: green to ${G_SCALE.caution} g, amber to the ${G_SCALE.limit} g limit (above it the crew's g-dose builds up)`;
  const gauges = el('div', 'panel gauges', [thr.root, gG.root]);

  const node = { dv: new TextSlot(), burn: new TextSlot(), start: new TextSlot() };
  const nodePanel = el('div', 'panel node', [el('div', 'ptitle', [el('span', '', ['Maneuver'])]), row('Δv remaining', node.dv).root, row('Burn time', node.burn).root, row('Burn start', node.start).root], {
    'data-show': 'external map',
  });
  const nodeShow = hiddenFlag(nodePanel);
  const nodeImminent = classFlag(nodePanel, 'imminent');
  const nodeDvTone = new ToneSlot(nodePanel.querySelector('.row .val')!);
  const rightStack = el('div', 'br', [nodePanel, el('div', '', [gauges], { 'data-show': 'external' })]);

  const bottom = el('div', 'bottom', [sasPanel, nbwrap, rightStack]);

  // ---------------------------------------------------------------------------------------- centre
  const failReason = new TextSlot('');
  const failed = el('div', 'failed', [el('h2', '', ['MISSION FAILED']), el('p', '', [failReason.node])]);
  const failedShow = hiddenFlag(failed);

  // --------------------------------------------------------------------------------------- key help
  const groups = new Map<string, HudKeyHelpEntry[]>();
  for (const e of opts.keyHelp) {
    const list = groups.get(e.group) ?? [];
    list.push(e);
    groups.set(e.group, list);
  }
  const cols = el('div', 'cols');
  for (const [g, entries] of groups) {
    const group = el('div', 'group', [el('h3', '', [g])]);
    for (const e of entries) {
      const keys = el('span', 'keys', [...e.keys.map((k) => keyCap(k)), ...e.lockedKeys.map((k) => keyCap(k, 'kbd locked', 'Only while the keyboard is captured (fullscreen)'))]);
      group.append(el('div', 'item', [el('span', '', [e.text]), keys]));
    }
    cols.append(group);
  }
  const help = el(
    'div',
    'help',
    [
      el('div', 'sheet', [
        el('div', 'head', [
          el('div', '', [el('h2', '', ['Flight controls']), el('div', 'note', ['Keys with an amber outline work only while the keyboard is captured (fullscreen).'])]),
          hudButton(['Close'], '', 'Close key help (`)', () => toggleKeyHelp(false)),
        ]),
        cols,
      ]),
    ],
    { [INTERACTIVE_ATTR]: '' },
  );
  help.addEventListener('click', (e) => {
    if (e.target === help) toggleKeyHelp(false);
  });
  const helpShow = hiddenFlag(help);
  helpShow.set(false);
  const helpClass = classFlag(root, 'help-open');

  root.append(tc, tr, lcol, rcol, bottom, failed, help);

  // ---------------------------------------------------------------------------------- navball canvas
  const ctx = ballCanvas.getContext('webgpu');
  if (!ctx) throw new Error('HUD: cannot create a WebGPU context for the navball canvas');
  ctx.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: 'premultiplied' });
  const bezelCtx = bezelCanvas.getContext('2d');
  let ballPx = 0;
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const box = e.devicePixelContentBoxSize?.[0];
      const px = box ? Math.round(box.inlineSize) : Math.round(e.contentRect.width * devicePixelRatio);
      ballPx = Math.max(1, Math.min(2048, px));
      ballCanvas.width = ballPx;
      ballCanvas.height = ballPx;
      bezelCanvas.width = ballPx;
      bezelCanvas.height = ballPx;
      if (bezelCtx) drawNavballBezel(bezelCtx, ballPx, HUD_BALL_RADIUS_FRACTION);
    }
  });
  ro.observe(ballCanvas);
  const ballOpts = { radiusFraction: HUD_BALL_RADIUS_FRACTION, instrument: true };

  // ------------------------------------------------------------------------------------- toasts
  interface Toast {
    text: string;
    count: number;
    life: number;
    /** HUD frame of the last notification (repeats inside one frame do not count). */
    frame: number;
    el: HTMLDivElement;
    countSlot: TextSlot;
    fading: boolean;
  }
  const toasts: Toast[] = [];
  /** Incremented at the end of every update: notifications between two updates belong to one frame. */
  let frameNo = 0;
  const notify = (message: string, tone: 'caution' | 'info' = 'caution'): void => {
    const existing = toasts.find((t) => t.text === message);
    if (existing) {
      // The same message reported twice for one event (e.g. a command result and a sim event) is one toast.
      if (existing.frame !== frameNo) {
        existing.count++;
        existing.countSlot.set(`×${existing.count}`);
      }
      existing.frame = frameNo;
      existing.life = TOAST_SECONDS;
      if (existing.fading) {
        existing.fading = false;
        existing.el.classList.remove('fade');
      }
      return;
    }
    const countSlot = new TextSlot('');
    const t: Toast = { text: message, count: 1, life: TOAST_SECONDS, frame: frameNo, el: el('div', `toast ${tone === 'info' ? 'info' : ''}`.trim(), [message, el('span', 'count', [countSlot.node])]), countSlot, fading: false };
    toasts.push(t);
    toastsEl.append(t.el);
    while (toasts.length > MAX_TOASTS) toasts.shift()!.el.remove();
  };

  /** Warp index of the previous snapshot (null before the first update). */
  let warpSeen: number | null = null;

  const eventToast = (e: SimEvent, s: SimSnapshot): void => {
    switch (e.type) {
      case 'milestone':
        notify(titleCase(e.milestone.id), 'info');
        break;
      case 'soiChange':
        notify(`Entering ${defs.bodies[e.toBodyId]?.name ?? e.toBodyId} sphere of influence`, 'info');
        break;
      case 'crewLost':
        notify(`Crew lost: ${e.cause}`);
        break;
      case 'partDestroyed':
        if (e.vesselId === s.activeVesselId) notify(`Part destroyed (${e.cause})`);
        break;
      case 'activeVesselChanged': {
        const v = s.vessels.find((x) => x.id === e.vesselId);
        notify(`Now controlling ${v?.name ?? e.vesselId}`, 'info');
        break;
      }
      case 'chuteFailed':
        notify('Parachute failed');
        break;
      default:
        break;
    }
  };

  function eventToasts(s: SimSnapshot): void {
    let prev = warpSeen ?? s.warp.index;
    for (const e of s.events) {
      if (e.type === 'warpChanged') {
        // A refused request of the player comes back as a CommandResult, which the flight controller reports;
        // the event's reason is shown only when the sim lowered the warp by itself (atmosphere, an event ahead).
        if (e.reason && e.index < prev) notify(e.reason);
        prev = e.index;
      } else eventToast(e, s);
    }
    warpSeen = s.warp.index;
  }

  let lastSnapshot: SimSnapshot | null = null;
  let lastMs = 0;
  let meanMs = 0;
  let samples = 0;
  let textUpdates = 0;
  /** Seconds since the last text refresh; a refresh is forced by `forceText` or a changed signature. */
  let textClock = 0;
  let forceText = true;
  let lastSig = '';
  const sasCaptionOn = new Flag((on) => sasCaption.node.parentElement?.classList.toggle('t-good', on));

  function setKind(kind: ViewKind): void {
    if (kindFlag.cur !== kind) {
      kindFlag.cur = kind;
      root.setAttribute('data-kind', kind);
    }
  }

  function toggleKeyHelp(force?: boolean): void {
    helpOpen = force ?? !helpOpen;
    helpShow.set(helpOpen);
    helpClass.set(helpOpen);
  }

  function updateStages(s: SimSnapshot): void {
    const st = describeStages(s);
    const remaining = st.tiles.filter((t) => !t.fired);
    // One tile per remaining StageInfo, next first. Long stacks keep the next two stages in full and show the
    // rest as compact one-line tiles (number, icon, name, delta-v).
    const compactFrom = remaining.length > FULL_STAGE_TILES ? 2 : Infinity;
    const key = `${remaining.map((t, i) => `${t.index}:${t.label}:${t.icon}:${t.actionKinds.join(',')}:${t.next ? 1 : 0}:${t.hasEngines ? 1 : 0}:${i >= compactFrom ? 'c' : 'f'}`).join('|')}#${st.lockout ? 1 : 0}`;
    if (key !== stageKey) {
      stageKey = key;
      stagesEl.replaceChildren();
      stageSlots = [];
      remaining.forEach((t, i) => {
        const compact = i >= compactFrom;
        const locked = t.next && st.lockout;
        const iconName = stageIconFor(t.icon);
        const dv = new TextSlot('');
        const num = el('div', 'sn', [t.number]);
        const icon = el('div', 'ico', [svgIcon(locked ? LOCK_ICON : STAGE_ICONS[iconName])]);
        let fill: FillSlot | null = null;
        let barTone: Flag | null = null;
        let tile: HTMLElement;
        let meta: TextSlot | null = null;
        if (compact) {
          tile = el('div', 'tile compact', [num, icon, el('div', 'name', [t.label]), el('div', 'dv', [dv.node])]);
        } else {
          // Line 1: the name alone (and the key cap of the next stage). Line 2: delta-v, TWR and burn time, the
          // action icons that differ from the stage icon, the propellant bar; or the lockout and its reason.
          const line1 = el('div', 'l1', [el('div', 'name', [t.label])]);
          let line2: HTMLElement;
          if (locked) {
            line2 = el('div', 'l2 lockline', [el('b', '', ['LOCKED']), el('span', '', ['after last stage'])]);
          } else {
            meta = new TextSlot('');
            const acts = [...new Set(t.actionKinds.map(stageIconFor))].filter((k) => k !== iconName).slice(0, 3);
            const parts: HTMLElement[] = [];
            if (t.next) parts.push(el('span', 'hint', [keyCap(keyFor('stage') ?? 'Space')]));
            parts.push(el('span', 'dv', [dv.node]), el('span', 'meta', [meta.node]));
            if (acts.length > 0) parts.push(el('span', 'acts', acts.map((k) => svgIcon(STAGE_ICONS[k]))));
            if (t.propellant !== null) {
              const b = bar();
              fill = b.fill;
              barTone = classFlag(b.root, 'caution');
              parts.push(b.root);
            }
            line2 = el('div', 'l2', parts);
          }
          tile = el('div', 'tile', [num, icon, el('div', 'main', [line1, line2])]);
          if (t.next) {
            tile.classList.add('next');
            if (locked) tile.classList.add('locked');
            tile.setAttribute(INTERACTIVE_ATTR, '');
            tile.title = locked ? 'Staging is locked for a moment after the last stage' : `Fire this stage (${keyFor('stage') ?? 'Space'})`;
            tile.addEventListener('pointerdown', (e) => e.preventDefault());
            tile.addEventListener('click', () => {
              if (!tile.classList.contains('locked')) dispatch('stage');
            });
          }
        }
        stagesEl.append(tile);
        stageSlots.push({ index: t.index, dv, meta, fill, barTone });
      });
    }
    remaining.forEach((t, i) => {
      const slot = stageSlots[i];
      if (!slot) return;
      const compact = i >= compactFrom;
      slot.dv.set(t.hasEngines ? (compact ? t.deltaV : `Δv ${t.deltaV}`) : '');
      slot.meta?.set(t.hasEngines ? `TWR ${t.twr} · ${t.burnTime}` : 'no engines');
      if (slot.fill && t.propellant !== null) {
        slot.fill.set(t.propellant);
        slot.barTone?.set(t.propellant < 0.1);
      }
    });
    stagesMore.set(remaining.length === 0 ? 'No stages left' : `Δv ${st.deltaVTotal} total`);
  }

  function updateResources(s: SimSnapshot): void {
    const groupsView = describeResources(s, defs);
    resShow.set(groupsView.length > 0);
    const key = groupsView.map((g) => `${g.id}:${g.bars.map((b) => b.resourceId).join(',')}`).join('|');
    if (key !== resKey) {
      resKey = key;
      resGroupsEl.replaceChildren();
      resSlots = [];
      for (const g of groupsView) {
        const grp = el('div', 'grp', [el('div', 'gname', [g.label])]);
        for (const b of g.bars) {
          const pb = bar();
          const pct = new TextSlot(b.amount);
          grp.append(el('div', 'rrow', [el('span', 'rn', [b.name]), pb.root, el('span', 'rp', [pct.node])]));
          resSlots.push({ fill: pb.fill, pct, low: classFlag(pb.root, 'caution') });
        }
        resGroupsEl.append(grp);
      }
    }
    let i = 0;
    for (const g of groupsView) {
      for (const b of g.bars) {
        const slot = resSlots[i++];
        if (!slot) continue;
        slot.fill.set(b.fraction);
        slot.pct.set(b.amount);
        slot.low.set(b.fraction < 0.1);
      }
    }
  }

  function updateToasts(dt: number): void {
    for (let i = toasts.length - 1; i >= 0; i--) {
      const t = toasts[i]!;
      t.life -= dt;
      if (t.life < 0.45 && !t.fading) {
        t.fading = true;
        t.el.classList.add('fade');
      }
      if (t.life <= 0) {
        t.el.remove();
        toasts.splice(i, 1);
      }
    }
  }

  function renderNavball(s: SimSnapshot, showBall: boolean): void {
    const encoder = gpu.device.createCommandEncoder({ label: 'hud.navball' });
    navball.render(encoder, s);
    if (showBall && ballPx > 1) navball.renderTo(encoder, s.navball, ctx!.getCurrentTexture().createView(), gpu.canvasFormat, ballPx, ballOpts);
    gpu.device.queue.submit([encoder.finish()]);
  }

  /** Every frame while visible: panel visibility, indicator lights, the throttle and g gauges. */
  function updateFrame(s: SimSnapshot, kind: ViewKind, dt: number): void {
    const r = s.readouts;
    const v = activeVesselOf(s);
    const landed = isLanded(v);
    const altSrc = altitudeSource(s, altMode);
    const w = s.warp;
    const phase = orbitPhase(s, defs);

    // Panel visibility.
    const showOrbit = !landed && (kind === 'map' || (kind === 'external' && phase.show));
    const inAir = !landed && (r.dynamicPressure > 1 || r.mach > 0.02);
    const heating = r.heatFlux > 1000;
    const showEntry = heating || r.chuteEnvelope !== null || r.liftVectorUp !== null;
    let targetButtonsShown = 0;
    for (const [id, b] of targetButtons) {
      // The body the vessel sits on cannot be its target.
      const show = id !== v?.bodyId;
      b.show.set(show);
      if (show) targetButtonsShown++;
    }
    const onGround = v !== null && (v.situation === 'prelaunch' || v.situation === 'landed');
    // The launch panel shows only with something in it: a target to pick, a target, or a launch window.
    const showPad = onGround && (targetButtonsShown > 0 || r.targetBodyId !== null || r.targetRelativeInclination !== null || r.launchWindow !== null);
    const nb = r.nodeBurn;
    const tBurn = nb?.timeToBurnStart ?? null;
    orbitShow.set(showOrbit);
    atmInEntry.set(showEntry);
    atmShow.set(inAir && !showEntry);
    entryShow.set(showEntry);
    fluxShow.set(heating);
    ablShow.set(r.ablatorFraction !== null);
    liftShow.set(r.liftVectorUp !== null);
    chuteShow.set(r.chuteEnvelope !== null);
    ltShow.set(r.landingTarget !== null);
    if (r.landingTarget === null) ltCurrentRows = null;
    padShow.set(showPad);
    padTargetsShow.set(targetButtonsShown > 0);
    relIncShow.set(r.targetRelativeInclination !== null);
    crossShow.set(r.launchWindow !== null);
    azShow.set(r.launchWindow !== null);
    for (const [id, b] of targetButtons) b.on.set(r.targetBodyId === id);
    nodeShow.set(nb !== null);
    nodeImminent.set(tBurn !== null && tBurn >= 0 && tBurn < 10);
    noticeShow.set(s.terrain.pending && r.altitudeRadar < RADAR_ALTITUDE_SWITCH);
    failedShow.set(s.mission.failed);
    doseShow.set(r.gDose > 0);

    // Warp chevrons.
    for (let i = 0; i < chevrons.length; i++) {
      chevOn[i]!.set(i + 1 <= w.index);
      chevCap[i]!.set(i + 1 > w.maxIndex);
    }

    // Systems and SAS.
    sasOn.set(r.sasEnabled);
    rcsOn.set(r.rcsEnabled);
    gearAvail.set(r.legsDeployed !== null);
    gearOn.set(r.legsDeployed === true);
    lightsOn.set(r.lightsOn);
    fineOn.set(r.fineControl);
    for (const mode of SAS_MODES) {
      const b = modeButtons.get(mode)!;
      b.enabled.set(r.sasModesAvailable.includes(mode));
      b.on.set(r.sasEnabled && r.sasMode === mode);
    }
    sasCaptionOn.set(r.sasEnabled);

    // Gauges (composited transforms: no layout, no paint).
    thr.fill.set(r.throttle);
    gG.fill.set(r.gLoad / G_SCALE.full);

    // Text: at HUD_TEXT_HZ, and at once on any discrete change.
    const lt = r.landingTarget;
    const sig = `${kind}|${altMode}|${altSrc}|${landed}|${s.navball.mode}|${r.sasEnabled}|${r.sasMode}|${w.index}|${w.maxIndex}|${w.onRails}|${w.limitedBy}|${v?.bodyId}|${showOrbit}|${phase.periapsisTone}|${inAir}|${showEntry}|${heating}|${r.ablatorFraction !== null}|${r.liftVectorUp}|${r.chuteEnvelope}|${lt?.targetId}|${lt?.predicted?.kind}|${r.horizontalSpeed >= 0.1}|${showPad}|${r.targetBodyId}|${r.launchWindow !== null}|${nb === null ? '-' : tBurn === null ? 'n' : tBurn < 0 ? 'b' : 'w'}|${nb?.insufficientDeltaV}|${s.staging.nextStage}|${s.staging.lockout}|${s.staging.stages.length}|${s.mission.failed}`;
    textClock += dt;
    const due = textClock >= TEXT_PERIOD - 1e-4;
    if (forceText || due || sig !== lastSig) {
      textClock = due ? Math.min(Math.max(0, textClock - TEXT_PERIOD), TEXT_PERIOD) : 0;
      forceText = false;
      lastSig = sig;
      textUpdates++;
      updateText(s, kind, { showOrbit, inAir: inAir || showEntry, showEntry, showPad });
    }
  }

  /** Every text readout (and the slow bars) of the visible panels. */
  function updateText(s: SimSnapshot, kind: ViewKind, show: { showOrbit: boolean; inAir: boolean; showEntry: boolean; showPad: boolean }): void {
    const r = s.readouts;
    const v = activeVesselOf(s);
    const bodyDef = v ? defs.bodies[v.bodyId] : undefined;
    const f = describeFlight(s, altMode);

    // Clock and warp.
    met.set(formatMet(r.met));
    ut.set(formatUt(s.ut));
    const w = describeWarp(s, WARP_LEVELS);
    warpFactor.set(w.factor);
    railsLabel.set(w.index > 0 ? (w.onRails ? 'rails warp' : 'physics warp') : '');
    warpLimit.set(w.limit ?? '');
    warpLimitShow.set(w.limit !== null);

    // Altitude: the reference is the body's (sea level where there is an ocean, the datum elsewhere).
    altLabel.set(`Altitude · ${f.altitudeSource === 'radar' ? 'radar' : altitudeDatumName(s, defs)}${altMode === 'auto' ? ' · auto' : ''}`);
    altValue.set(f.altitude);
    vsIcon.set(f.verticalTrend);
    vsValue.set(f.verticalSpeed);
    hsValue.set(f.horizontalSpeed);

    // Orbit.
    if (show.showOrbit) {
      const o = describeOrbit(s);
      const phase = orbitPhase(s, defs);
      orbitBody.set(bodyDef?.name ?? '');
      orbit.ap.set(o.apoapsis);
      orbit.apT.set(o.apoapsisTime);
      orbit.pe.set(o.periapsis);
      orbit.peT.set(phase.suborbital ? 'suborbital' : o.periapsisTime);
      peTone.set(phase.periapsisTone === 'normal' ? '' : phase.periapsisTone);
      peSubTone.set(phase.suborbital ? 'caution' : '');
      orbit.inc.set(o.inclination);
      orbit.per.set(o.period);
    }

    // Atmospheric flight.
    if (show.inAir) {
      atm.q.set(formatPressure(r.dynamicPressure));
      atm.mach.set(formatMach(r.mach));
      atm.aoa.set(formatRadAsDeg(r.angleOfAttack));
    }

    // Entry: heat shield, skin temperature, lift vector, chute envelope.
    if (show.showEntry) {
      entry.flux.set(formatHeatFlux(r.heatFlux));
      if (r.ablatorFraction !== null) {
        entry.abl.set(formatPercent(r.ablatorFraction));
        ablBar.fill.set(r.ablatorFraction);
      }
      entry.temp.set(formatPercent(r.maxTempFraction));
      tempBar.fill.set(r.maxTempFraction);
      entry.lift.set(r.liftVectorUp ? 'LIFT UP' : 'LIFT DOWN');
      if (r.chuteEnvelope) {
        entry.chute.set(r.chuteEnvelope.toUpperCase());
        chuteTone.set(r.chuteEnvelope === 'safe' ? 'good' : r.chuteEnvelope === 'risky' ? 'caution' : 'warning');
      }
    }

    // Landing target.
    const lt = describeLandingTarget(s);
    if (lt) {
      ltName.set(lt.name);
      ltKind.set(lt.kindLabel);
      const rows = landingTargetRows(lt);
      ltRows.forEach((slot, i) => {
        const rr = rows[i];
        slot.show.set(rr !== undefined);
        if (!rr) return;
        slot.label.set(rr[0]);
        slot.value.set(rr[1]);
        slot.pred.set(isPredictionRow(rr[0]));
      });
      ltCurrentRows = rows;
      // Recovery zone: inside is the go state (green); outside matters once the descent is committed.
      const zone = lt.zoneRadius !== null;
      const committed = r.chuteEnvelope !== null || lt.predicted !== null;
      zoneShow.set(zone && (lt.insideZone || committed));
      zoneText.set(lt.insideZone ? 'INSIDE ZONE' : 'OUTSIDE ZONE');
      zoneSub.set(lt.zoneRadius !== null ? `radius ${lt.zoneRadius}` : '');
      zoneTone.set(lt.insideZone ? 'good' : 'caution');
    } else ltCurrentRows = null;

    // Pad: target and launch opportunity.
    if (show.showPad) {
      const p = describePad(s, defs);
      if (p) {
        pad.target.set(p.target);
        pad.relInc.set(p.relativeInclination ?? '');
        pad.cross.set(p.planeCrossing ?? '');
        pad.az.set(p.launchAzimuth ?? '');
      }
    }

    // Stage stack and resources.
    if (kind !== 'map') updateStages(s);
    if (kind === 'external') updateResources(s);

    // SAS caption, speed, navball readouts, gauges.
    sasCaption.set(r.sasEnabled ? `Hold · ${SAS_NAMES[r.sasMode]}` : 'SAS off');
    speedMode.set(f.speedMode === 'surface' ? 'Surface' : 'Orbit');
    speedValue.set(f.speed);
    hdg.set(f.heading);
    pitchText.set(f.pitch);
    rollText.set(f.roll);
    thr.value.set(f.throttle);
    gG.value.set(f.gLoad);
    const gt = gTone(r.gLoad);
    gTextTone.set(gt === 'normal' ? '' : gt);
    if (r.gDose > 0) doseBar.fill.set(r.gDoseLimit > 0 ? r.gDose / r.gDoseLimit : 0);

    // Node burn.
    const nb = describeNodeBurn(s);
    if (nb) {
      node.dv.set(nb.deltaV);
      node.burn.set(nb.burnTime);
      node.start.set(nb.started ? `burning · ${nb.startIn}` : nb.startIn);
      nodeDvTone.set(nb.insufficient ? 'warning' : 'accent');
    }

    if (s.mission.failed) failReason.set(s.mission.failureReason ?? 'The mission cannot continue.');
  }

  const hud: HudImpl = {
    root,
    get visible() {
      return visible;
    },
    get keyHelpOpen() {
      return helpOpen;
    },
    get lastUpdateMs() {
      return lastMs;
    },
    get meanUpdateMs() {
      return meanMs;
    },
    get textUpdates() {
      return textUpdates;
    },
    mount(container) {
      container.append(root);
    },
    setVisible(v) {
      if (v && !visible) forceText = true;
      visible = v;
      root.hidden = !v;
    },
    notify: (m) => notify(m),
    setKeyboardLocked(locked) {
      kbCaptureShow.set(!locked);
      kbOkShow.set(locked);
    },
    toggleKeyHelp,
    landingTargetRows: () => ltCurrentRows,
    notifications: () => toasts.map((t) => t.text),
    update(s: SimSnapshot, camera: CameraState, realDt: number) {
      const t0 = performance.now();
      const dt = Math.max(0, realDt);
      lastSnapshot = s;
      const kind = camera.kind;
      setKind(kind);
      renderNavball(s, visible && (kind === 'external' || kind === 'map'));
      eventToasts(s);
      updateToasts(dt);
      if (visible) updateFrame(s, kind, dt);
      frameNo++;
      record(t0);
    },
    dispose() {
      ro.disconnect();
      ctx.unconfigure();
      root.remove();
    },
  };

  function record(t0: number): void {
    lastMs = performance.now() - t0;
    samples++;
    meanMs += (lastMs - meanMs) / Math.min(samples, 240);
  }

  return hud;
}
