/**
 * The flight HUD (src/core/contracts/ui.ts `Hud`): DOM + Canvas over the WebGPU canvas, with pointer events
 * only on interactive parts (marked `data-hud-interactive`; the pointer over them is PointerState.overUi, and
 * everywhere else it passes through to the scene). It renders only from the SimSnapshot and the presented
 * CameraState, and acts only by dispatching ButtonActions (the same path as the keys) or, for target selection
 * on the pad, PlayerCommands.
 *
 * Layout by camera.kind (unknown modes behave as their kind):
 *   external  everything;
 *   interior  clock, warp, notifications, landing target, stage stack and the system strip (the cockpit
 *             instruments show the rest);
 *   map       clock, warp, altitude, orbit, landing target, node burn, the bottom instrument (no stage stack).
 * The bottom cluster is one instrument: a gunmetal housing symmetric about the navball (SAS controls left, tape
 * gauges right) with the ball's read-outs as windows set into it (speed and heading on the bezel's top arc,
 * pitch at 9 and roll at 3 o'clock), so the ball stays on the screen's centre line; the maneuver readout stands
 * on the housing right of the ball.
 *
 * The frame is for the scene: panels show what the flight phase needs and fold the rest (a coverage budget of
 * 20 % of a 16:9 frame is asserted by the screenshot spec). Only the next stage and the stage that is burning
 * get full tiles, every other stage is one line of one list; resources show the groups in use and fold the full
 * ones into one line; the landing-target panel is one line until a prediction, an entry or a descent makes its
 * rows matter; the orbit panel leaves while the vessel heats up or falls through the air.
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
import { LOCK_ICON, MARKER_COLORS, MARKER_ICONS, STAGE_ICONS, stageIconFor, svgIcon, TREND_ICONS } from '../icons';
import {
  ablatorTone,
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
  inAtmosphere,
  isEntering,
  isLanded,
  isPredictionRow,
  landingTargetExpanded,
  landingTargetRows,
  describeAirData,
  describeChuteEnvelope,
  hasGroundTrack,
  milestoneSoiBody,
  milestoneTitle,
  orbitPhase,
  RADAR_ALTITUDE_SWITCH,
  summarizeResources,
  zoneStatus,
  type AltitudeMode,
  type StageTileView,
} from '../model';
import { drawNavballBezel } from '../navball/bezel';
import { HUD_BALL_LIP, HUD_BALL_RADIUS_FRACTION } from '../navball/navballMath';
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
  /**
   * The keyboard-capture switch (top right): off, a click calls this inside the click handler
   * (InputSystem.requestKeyboardCapture: fullscreen + keyboard lock); on, a click calls releaseKeyboardCapture.
   * Esc leaves the capture as well (the browser's fullscreen exit). The HUD never asks for the capture by itself.
   */
  requestKeyboardCapture?: () => void;
  /** Leave fullscreen and release the lock (InputSystem.releaseKeyboardCapture): the switch's second click. */
  releaseKeyboardCapture?: () => void;
  /** Show the keyboard-capture switch (default true; false for clean footage, see setCaptureControlVisible). */
  showCaptureControl?: boolean;
  /** Key-help content generated from the binding table (keyHelpEntries(input.bindings)). */
  keyHelp: readonly HudKeyHelpEntry[];
  /** Key label per ButtonAction for hints on buttons (e.g. { stage: 'Space' }). */
  keyFor?: (action: ButtonAction) => string | null;
  /** Commands for target selection on the pad; when absent the pad panel only displays the target. */
  commands?: () => PlayerCommands | null;
  /**
   * What the player can do once the mission has failed (revert to launch, restart the scenario, quit to the
   * menu...), offered as buttons on the mission-failed banner. The app shell supplies them; without any the
   * banner says that the flight controls are off.
   */
  failureActions?: readonly HudFailureAction[];
}

/** A next step offered on the mission-failed banner. */
export interface HudFailureAction {
  label: string;
  /** Key cap shown on the button (the app binds the key itself). */
  key?: string;
  title?: string;
  run: () => void;
}

export interface HudImpl extends Hud {
  readonly root: HTMLElement;
  readonly visible: boolean;
  /**
   * The capture state for the switch: `locked` (fullscreen with the keyboard lock held) and `fullscreen` (the
   * capture is on; without the lock when the browser refused it). Default for `fullscreen`: `locked`.
   */
  setKeyboardLocked(locked: boolean, fullscreen?: boolean): void;
  /** Show or hide the keyboard-capture switch (clean footage); the key-help button stays. */
  setCaptureControlVisible(visible: boolean): void;
  toggleKeyHelp(force?: boolean): void;
  readonly keyHelpOpen: boolean;
  /** CPU time of the last update and its running mean, ms (JavaScript only; see the hand-off for the full cost). */
  readonly lastUpdateMs: number;
  readonly meanUpdateMs: number;
  /** Number of updates that refreshed the text readouts (about TEXT_HZ per second while visible). */
  readonly textUpdates: number;
  /**
   * Label/value rows the landing-target panel shows now (null when hidden): landingTargetRows() while the panel
   * is expanded, its first two rows (distance, bearing) while it is one line.
   */
  landingTargetRows(): [string, string][] | null;
  /** Current notifications (oldest first). */
  notifications(): string[];
}

/** Refresh rate of the numeric text readouts. */
export const HUD_TEXT_HZ = 10;
const TEXT_PERIOD = 1 / HUD_TEXT_HZ;

/** Most landing-target rows (landingTargetRows). */
const LT_ROWS = 5;

/** Skin temperature (share of the limit) from which the entry panel shows its rows in any phase (amber from here). */
const SKIN_CAUTION = 0.7;

/** Share of the fatal g-dose from which the dose bar turns red (amber below). */
const DOSE_WARNING = 2 / 3;

/** Longest list of full stage groups (characters, about two lines) the resources panel spells out. */
const FULL_LINE_CHARS = 64;

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

/**
 * Key caps show the key's own glyph, as printed on the keyboard: punctuation drawn large (a "." at the text size is
 * a 2 px speck at 720p) with its name in the tooltip, brackets and arrow keys enlarged.
 */
const NAMED_CAPS: Record<string, string> = { '.': 'Period', ',': 'Comma', '/': 'Slash', '`': 'Backquote', '-': 'Minus', '=': 'Equals', ';': 'Semicolon', "'": 'Quote', '\\': 'Backslash' };
const GLYPH_CAPS = new Set(['[', ']', '←', '→', '↑', '↓']);

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOAST_SECONDS = 4.5;
const MAX_TOASTS = 4;

function row(label: string, value: TextSlot, valueCls = ''): { root: HTMLDivElement; label: TextSlot; valueEl: HTMLSpanElement } {
  const l = new TextSlot(label);
  const valueEl = el('span', `val ${valueCls}`.trim(), [value.node]);
  return { root: el('div', 'row', [el('span', 'lbl', [l.node]), valueEl]), label: l, valueEl };
}

/** A label, a bar and its value on one line (heat shield, skin temperature). */
function barRow(label: string): { root: HTMLDivElement; value: TextSlot; fill: FillSlot; tone: ToneSlot } {
  const value = new TextSlot('');
  const b = bar();
  const root = el('div', 'brow', [el('span', 'lbl', [label]), b.root, el('span', 'bv', [value.node])]);
  return { root, value, fill: b.fill, tone: new ToneSlot(b.root) };
}

function keyCap(label: string, cls = 'kbd', title?: string): HTMLSpanElement {
  const named = NAMED_CAPS[label];
  const kind = named ? ' glyph punct' : GLYPH_CAPS.has(label) ? ' glyph' : '';
  return el('span', `${cls}${kind}`, [label], title ? { title } : named ? { title: named } : {});
}

/** Warp step buttons: chevrons pointing back (slower) and forward (faster). */
const WARP_STEP_DOWN = { stroke: 'M15,5L8,12L15,19', width: 3.4 };
const WARP_STEP_UP = { stroke: 'M9,5L16,12L9,19', width: 3.4 };

/** Horizontal speed: a level arrow (SVG, never a font glyph). */
const HORIZONTAL_ICON = { stroke: 'M3.5,12H19.5 M14.5,7L19.5,12L14.5,17', width: 2.6 };

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
 * ticks, an optional limit mark and a caption. The three parts are placed on the rows of the gauges panel's
 * grid (the gauge's class picks its column), so paired gauges share their rows.
 */
function tapeGauge(cls: string, caption: string, nums: [string, number][], ticks: number, limit: number | null): { root: HTMLElement; value: TextSlot; valueEl: HTMLElement; fill: RevealSlot } {
  const value = new TextSlot('');
  const layer = el('i');
  const win = el('div', 'win', [layer]);
  const tube = el('div', 'tube', [el('div', 'track'), win, el('div', 'ticks', [], { style: `--n:${ticks}` })]);
  if (limit !== null) tube.append(el('div', 'limit', [], { style: `bottom:calc(${(limit * 100).toFixed(3)}% - 1px)` }));
  const numsEl = el('div', 'nums', nums.map(([t, f]) => el('span', '', [t], { style: `bottom:${(f * 100).toFixed(3)}%` })));
  const valueEl = el('span', 'gv', [value.node]);
  const root = el('div', `gauge ${cls}`, [valueEl, el('div', 'scale', [numsEl, tube]), el('span', 'gl', [caption])]);
  return { root, value, valueEl, fill: new RevealSlot(win, layer) };
}

/**
 * Splits key-help groups over `n` columns so that the tallest column is as short as possible (a header counts
 * 1.6 lines; ties go to the most even split). Each column keeps the groups in their order. Exhaustive over the
 * assignments (a binding table has a handful of groups).
 */
export function balanceColumns(heights: readonly number[], n: number): number[][] {
  let best: number[] | null = null;
  let bestKey = [Infinity, Infinity];
  const assign = new Array<number>(heights.length).fill(0);
  const total = Math.pow(n, heights.length);
  for (let code = 0; code < total; code++) {
    let c = code;
    const sums = new Array<number>(n).fill(0);
    for (let i = 0; i < heights.length; i++) {
      const col = c % n;
      assign[i] = col;
      c = Math.floor(c / n);
      sums[col] = sums[col]! + heights[i]!;
    }
    const key = [Math.max(...sums), sums.reduce((a, s) => a + s * s, 0)];
    if (key[0]! < bestKey[0]! - 1e-9 || (Math.abs(key[0]! - bestKey[0]!) < 1e-9 && key[1]! < bestKey[1]! - 1e-9)) {
      bestKey = key;
      best = assign.slice();
    }
  }
  // Columns in the order of their first group, so the first group of the table opens the first column.
  const cols: number[][] = Array.from({ length: n }, () => []);
  const order: number[] = [];
  for (const col of best ?? heights.map(() => 0)) if (!order.includes(col)) order.push(col);
  (best ?? heights.map(() => 0)).forEach((col, i) => cols[order.indexOf(col)]!.push(i));
  return cols;
}

interface StageSlot {
  /** A one-line row of the later-stages list (delta-v without its "Δv" prefix). */
  compact: boolean;
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
  const railsLabel = new TextSlot('');
  // MET with the warp factor (and its kind) at the right, UT, then the warp control and its limit.
  const clock = el('div', 'panel clock', [
    el('div', 'metrow', [el('span', 'met', [met.node]), el('span', 'wf', [el('span', 'rails', [railsLabel.node]), el('b', 'factor', [warpFactor.node])])]),
    el('div', 'ut', [ut.node]),
    el('div', 'warp', [
      // Step arrows are drawn chevrons at the label's cap height (a font's angle quote is a 3 px speck at 720p).
      hudButton([svgIcon(WARP_STEP_DOWN, { className: 'step' })], 'warpdown', 'Slower time warp (,)', () => dispatch('warpDown')),
      chevSvg,
      hudButton([svgIcon(WARP_STEP_UP, { className: 'step' })], 'warpup', 'Faster time warp (.)', () => dispatch('warpUp')),
    ]),
    warpLimitEl,
  ]);

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
      // Vertical speed after its trend icon, horizontal speed after a horizontal arrow (fixed-width cells).
      el('div', 'vs', [el('span', 'sp', [vsIcon.el, el('b', '', [vsValue.node])], { title: 'Vertical speed' }), el('span', 'sp', [svgIcon(HORIZONTAL_ICON, { className: 'hsi' }), el('b', '', [hsValue.node])], { title: 'Horizontal speed' })]),
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
  // One labelled switch, off by default: every flight key works uncaptured; on, the page is fullscreen with the
  // keyboard lock (browser shortcuts such as Ctrl+W reach the game, Left Ctrl lowers the throttle too).
  let captureOn = false;
  const kbState = new TextSlot('OFF');
  const kbCapture = hudButton(
    [el('span', 'sw', [el('i')]), el('span', 'kbl', ['Keyboard capture']), el('span', 'kbs', [kbState.node])],
    'pill kbcap',
    '',
    () => (captureOn ? opts.releaseKeyboardCapture?.() : opts.requestKeyboardCapture?.()),
  );
  kbCapture.setAttribute('role', 'switch');
  const kbChecked = new AttrSlot(kbCapture, 'aria-checked');
  const kbTitle = new AttrSlot(kbCapture, 'title');
  const kbOn = classFlag(kbCapture, 'on');
  const kbNoLock = classFlag(kbCapture, 'nolock');
  const kbCaptureShow = hiddenFlag(kbCapture);
  const setCapture = (locked: boolean, fullscreen: boolean): void => {
    captureOn = fullscreen;
    kbOn.set(fullscreen);
    kbNoLock.set(fullscreen && !locked);
    kbChecked.set(String(fullscreen));
    kbState.set(!fullscreen ? 'OFF' : locked ? 'ON' : 'NO LOCK');
    kbTitle.set(
      !fullscreen
        ? 'Keyboard capture is off: the browser keeps its shortcuts (Ctrl+W, Ctrl+T...) and every flight key works. Click for fullscreen with keyboard lock; click again or press Esc to leave.'
        : locked
          ? 'Fullscreen with keyboard lock: browser shortcuts such as Ctrl+W reach the game, and Left Ctrl also lowers the throttle. Click or press Esc to leave.'
          : 'Fullscreen, but the browser did not grant the keyboard lock: its shortcuts stay active. Click or press Esc to leave.',
    );
  };
  setCapture(false, false);
  kbCaptureShow.set(opts.showCaptureControl ?? true);
  let helpOpen = false;
  const helpBtn = hudButton(['?'], 'helpbtn', 'Key help (`)', () => toggleKeyHelp());
  const tr = el('div', 'tr', [kbCapture, helpBtn], { 'data-show': 'external interior map' });

  // ----------------------------------------------------------------------------------- left column
  const orbit = { ap: new TextSlot(), apT: new TextSlot(), pe: new TextSlot(), peT: new TextSlot(), inc: new TextSlot(), per: new TextSlot() };
  const apsis = (label: string, value: TextSlot, time: TextSlot): { root: HTMLDivElement; valueEl: HTMLSpanElement; subEl: HTMLSpanElement } => {
    const valueEl = el('span', 'val', [value.node]);
    const subEl = el('span', 'sub', [time.node]);
    return { root: el('div', 'apsis', [el('span', 'lbl', [label]), valueEl, subEl]), valueEl, subEl };
  };
  const peRow = apsis('Periapsis', orbit.pe, orbit.peT);
  const peTone = new ToneSlot(peRow.valueEl);
  const orbitBody = new TextSlot('');
  // A suborbital path is said once, in the title (amber); its inclination and period are not shown (a path that
  // meets the surface has no period to fly).
  const subTag = el('span', 'tag t-caution', ['suborbital']);
  const subTagShow = hiddenFlag(subTag);
  const incRow = row('Inclination', orbit.inc);
  const perRow = row('Period', orbit.per);
  const closedRows = el('div', '', [incRow.root, perRow.root]);
  const closedRowsShow = hiddenFlag(closedRows);
  const orbitAtmSlot = el('div', 'atmslot');
  const orbitPanel = el('div', 'panel orbit', [
    el('div', 'ptitle', [el('span', '', ['Orbit']), el('span', 'pright', [subTag, el('span', 'pname', [orbitBody.node])])]),
    apsis('Apoapsis', orbit.ap, orbit.apT).root,
    peRow.root,
    closedRows,
    orbitAtmSlot,
  ]);
  const orbitShow = hiddenFlag(orbitPanel);
  // A periapsis below the surface has no time to it and a long value: both apsis rows then put their time after
  // the label and their value at the panel's edge, so Ap and Pe keep one right-aligned value column.
  const apsisWide = classFlag(orbitPanel, 'wide');

  // Atmospheric flight rows: in their own panel during an ascent, folded into the entry panel while it shows.
  const atm = { q: new TextSlot(), mach: new TextSlot(), aoa: new TextSlot() };
  // Three cells on one strip (label over value): dynamic pressure, Mach number, angle of attack.
  const cell = (label: string, value: TextSlot, title: string): HTMLElement => el('div', 'cell', [el('span', 'lbl', [label]), el('span', 'val', [value.node])], { title });
  const atmRows = el('div', 'atmrows', [cell('Dyn. Q', atm.q, 'Dynamic pressure'), cell('Mach', atm.mach, 'Mach number'), cell('AoA', atm.aoa, 'Angle of attack')]);
  const atmRowsShow = hiddenFlag(atmRows);
  const atmPanel = el('div', 'panel atm', [el('div', 'ptitle', [el('span', '', ['Atmosphere'])])], { 'data-show': 'external' });
  atmPanel.append(atmRows);
  const atmShow = hiddenFlag(atmPanel);

  const entry = { flux: new TextSlot(), lift: new TextSlot(), chute: new TextSlot() };
  const ablRow = barRow('Heat shield');
  const ablShow = hiddenFlag(ablRow.root);
  const tempRow = barRow('Skin temp.');
  const liftRow = el('div', 'row', [el('span', 'lbl', ['Lift vector']), el('span', 'lift', [entry.lift.node])]);
  const liftShow = hiddenFlag(liftRow);
  const chuteLight = el('span', 'light', [entry.chute.node]);
  const chuteTone = new ToneSlot(chuteLight);
  // Named for the chutes the light is about (the next chute stage: the mains once the drogues are out).
  const chuteLabel = new TextSlot('Chute deploy');
  const chuteRow = el('div', 'row', [el('span', 'lbl', [chuteLabel.node]), chuteLight]);
  const chuteTitle = new AttrSlot(chuteRow, 'title');
  const chuteShow = hiddenFlag(chuteRow);
  const fluxRow = row('Heat flux', entry.flux);
  const fluxShow = hiddenFlag(fluxRow.root);
  const entryAtmSlot = el('div', 'atmslot');
  const entrySep = el('div', 'sep');
  const entrySepShow = hiddenFlag(entrySep);
  const entryPanel = el('div', 'panel entry', [el('div', 'ptitle', [el('span', '', ['Entry'])]), entryAtmSlot, entrySep, fluxRow.root, ablRow.root, tempRow.root, liftRow, chuteRow], { 'data-show': 'external' });
  const entryShow = hiddenFlag(entryPanel);
  /**
   * Where the atmosphere rows live: in the entry panel while it shows, else under the orbit rows while the orbit
   * panel shows (an ascent), else in their own panel: one plate fewer on the left edge.
   */
  let atmHome = '';
  const placeAtm = (home: 'entry' | 'orbit' | 'own'): void => {
    if (home === atmHome) return;
    atmHome = home;
    (home === 'entry' ? entryAtmSlot : home === 'orbit' ? orbitAtmSlot : atmPanel).append(atmRows);
    entrySepShow.set(home === 'entry');
    atmRows.classList.toggle('sepd', home === 'orbit');
  };

  // Landing target / recovery zone: one line (name, distance, bearing) until its rows matter, then the rows.
  const ltName = new TextSlot('');
  const ltKind = new TextSlot('Landing target');
  const ltLine = new TextSlot('');
  const ltRows: { label: TextSlot; value: TextSlot; root: HTMLDivElement; show: Flag; pred: Flag }[] = [];
  const ltRowsEl = el('div', 'rows');
  for (let i = 0; i < LT_ROWS; i++) {
    const v = new TextSlot();
    const r = row('', v);
    ltRows.push({ label: r.label, value: v, root: r.root, show: hiddenFlag(r.root), pred: classFlag(r.root, 'pred') });
    ltRowsEl.append(r.root);
  }
  const ltRowsShow = hiddenFlag(ltRowsEl);
  const ltLineEl = el('div', 'ltline', [ltLine.node]);
  const ltLineShow = hiddenFlag(ltLineEl);
  // Recovery-zone status: a light row at value size (green inside, amber outside once it matters).
  const zoneText = new TextSlot('');
  const zoneSub = new TextSlot('');
  const zoneEl = el('div', 'zone', [el('span', 'light', [zoneText.node]), el('span', 'sub', [zoneSub.node])]);
  const zoneTone = new ToneSlot(zoneEl);
  const zoneShow = hiddenFlag(zoneEl);
  // The target's name sits in the title row beside a short kind tab ('Target' / 'Recovery'), so the one-line form
  // is two rows: the title, and distance with bearing.
  const ltPanel = el('div', 'panel lt', [el('div', 'ptitle', [el('span', '', [ltKind.node]), el('span', 'pname', [ltName.node])]), ltLineEl, ltRowsEl, zoneEl], {
    'data-show': 'external map interior',
  });
  const ltShow = hiddenFlag(ltPanel);
  let ltCurrentRows: [string, string][] | null = null;

  const pad = { target: new TextSlot(), relInc: new TextSlot(), cross: new TextSlot(), az: new TextSlot() };
  const padTargets = el('span', 'targets');
  const relIncRow = row('Rel. inclination', pad.relInc);
  const crossRow = row('Plane crossing', pad.cross);
  const azRow = row('Launch azimuth', pad.az);
  const relIncShow = hiddenFlag(relIncRow.root);
  const crossShow = hiddenFlag(crossRow.root);
  const azShow = hiddenFlag(azRow.root);
  const padNameEl = el('span', 'pname', [pad.target.node]);
  const padNameShow = hiddenFlag(padNameEl);
  // Without a target the panel says what the buttons are for (it would otherwise be a title and a button).
  const padHint = el('div', 'padhint', ['Pick a target body for its launch window']);
  const padHintShow = hiddenFlag(padHint);
  // Title row: "LAUNCH" and the target: the body buttons (the chosen one lit) or, without them, its name.
  const padPanel = el('div', 'panel pad', [el('div', 'ptitle', [el('span', '', ['Launch']), padTargets, padNameEl]), padHint, relIncRow.root, crossRow.root, azRow.root], { 'data-show': 'external' });
  const padShow = hiddenFlag(padPanel);
  const targetButtons = new Map<string, { btn: HTMLButtonElement; on: Flag; show: Flag }>();
  const commands = opts.commands;
  if (commands) {
    for (const b of Object.values(defs.bodies)) {
      // The root body has no orbit to compare planes with: it is never a launch target.
      if (b.gravityRole !== 'attractor' || b.parent === null) continue;
      const btn = hudButton([el('span', 'pfx', ['Target']), b.name], '', `Set ${b.name} as target`, () => {
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
  // The status edge of each flight panel (left, in the colour of its state; hudStyles.ts).
  const clockSt = new AttrSlot(clock, 'data-st');
  const orbitSt = new AttrSlot(orbitPanel, 'data-st');
  const ltSt = new AttrSlot(ltPanel, 'data-st');
  const entrySt = new AttrSlot(entryPanel, 'data-st');

  // ---------------------------------------------------------------------------------- right column
  // Stage stack, top to bottom: the later stages as one list of one-line rows (highest number on top), the next
  // stage as a full tile and, at the bottom, the stage that is burning now. A stack taller than the column is
  // clipped at the top (flex-end), never at the next or the active stage.
  const stagesEl = el('div', 'stages');
  const stagesMore = new TextSlot('');
  // The stack's header strip: its title and the total delta-v (or what is left when nothing can burn).
  const stagesMoreEl = el('div', 'more', [el('span', '', ['Stages']), el('span', 'tot', [stagesMore.node])]);
  const stagesMoreAlone = classFlag(stagesMoreEl, 'alone');
  const resGroupsEl = el('div', 'groups');
  const resPanel = el('div', 'panel res', [el('div', 'ptitle', [el('span', '', ['Resources'])]), resGroupsEl], { 'data-show': 'external' });
  const resShow = hiddenFlag(resPanel);
  const rcol = el('div', 'rcol', [el('div', 'stagewrap', [stagesMoreEl, stagesEl], { 'data-show': 'external interior' }), resPanel]);
  let stageKey = '';
  let stageSlots = new Map<number, StageSlot>();
  let resKey = '';
  let resSlots: { fill: FillSlot; pct: TextSlot; low: Flag; title: AttrSlot }[] = [];

  // ---------------------------------------------------------------------------------- bottom cluster
  const sasBtn = hudButton(['SAS'], 'sasbtn', 'SAS on / off (T)', () => dispatch('toggleSas'));
  const rcsBtn = hudButton(['RCS'], '', 'RCS on / off (R)', () => dispatch('toggleRcs'));
  const gearBtn = hudButton(['GEAR'], '', 'Landing gear (G)', () => dispatch('toggleLegs'));
  const lightsBtn = hudButton(['LIGHTS'], '', 'Lights (U)', () => dispatch('toggleLights'));
  const fineBtn = hudButton(['FINE'], '', 'Fine control (Caps Lock)', () => dispatch('toggleFineControl'));
  const toggles = el('div', 'toggles', [sasBtn, rcsBtn, gearBtn, lightsBtn, fineBtn, hudButton(['ABORT'], 'abort', `Abort (${keyFor('abort') ?? 'Backspace'})`, () => dispatch('abort'))]);
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
    // The icon fills the button (the marker shapes differ by small strokes); the key is in the tooltip and the
    // key help, as on KSP's mode buttons.
    const b = hudButton([svgIcon(icon, { color: MARKER_COLORS[mode === 'stability' ? 'stability' : mode] })], '', `Hold ${SAS_NAMES[mode]} (${key})`, () => dispatch(`sas:${mode}`));
    modes.append(b);
    modeButtons.set(mode, { on: classFlag(b, 'on'), enabled: new Flag((on) => b.setAttribute('aria-disabled', on ? 'false' : 'true')) });
  });
  const sasCaption = new TextSlot('');
  const sasPanel = el('div', 'panel sas bl', [toggles, modes, el('div', 'modecap', [sasCaption.node])], { 'data-show': 'external map' });

  // The ball's read-outs are windows of black glass set into the instrument: speed (in the navball's frame) and
  // heading on the bezel's top arc, pitch at 9 o'clock and roll at 3 o'clock. Fixed widths: a value never
  // changes a window's size.
  const speedMode = new TextSlot('Surface');
  const speedValue = new TextSlot('');
  const hdg = new TextSlot('000°');
  const speedPanel = el(
    'div',
    'panel speed',
    [el('span', 'spd', [el('span', 'mode', [speedMode.node]), el('b', 'sv', [speedValue.node])]), el('span', 'hd', [el('span', 'lbl', ['Hdg']), el('b', '', [hdg.node])], { title: 'Heading of the nose' })],
    { [INTERACTIVE_ATTR]: '', title: 'Speed in the navball frame. Click: surface / orbit navball (Tab)' },
  );
  speedPanel.addEventListener('click', () => dispatch('toggleNavballMode'));
  const ballCanvas = el('canvas', 'ballgl');
  const bezelCanvas = el('canvas', 'bezel');
  const pitchText = new TextSlot('');
  const rollText = new TextSlot('');
  const pitchWin = el('div', 'prw pitch', [el('span', 'lbl', ['Pitch']), el('b', '', [pitchText.node])], { 'data-show': 'external map' });
  const rollWin = el('div', 'prw roll', [el('span', 'lbl', ['Roll']), el('b', '', [rollText.node])], { 'data-show': 'external map' });
  const ball = el('div', 'ball', [ballCanvas, bezelCanvas]);
  const nbwrap = el('div', 'nbwrap bc', [speedPanel, ball], { 'data-show': 'external map' });

  // Captions short enough to stand apart under 2.2u tubes ("THR" as on a throttle quadrant); the tooltips name them.
  const thr = tapeGauge('thr', 'THR', [['0', 0], ['50', 0.5], ['100', 1]], 10, null);
  thr.root.title = 'Throttle lever, 0 to 100 % (the key help lists its keys)';
  const gG = tapeGauge('g', 'G LOAD', [['0', 0], ['4', 4 / G_SCALE.full], ['8', 8 / G_SCALE.full], ['12', 1]], G_SCALE.full, G_SCALE.limit / G_SCALE.full);
  const gTextTone = new ToneSlot(gG.valueEl);
  gG.root.title = `G load: green to ${G_SCALE.caution} g, amber to the ${G_SCALE.limit} g limit (above it the crew's g-dose builds up)`;
  // The crew's g-dose: a third tape beside the g tube (its share of the fatal limit: amber, red from DOSE_WARNING),
  // always there (a dim 0 % without a dose), so nothing in the panel moves when a flight phase brings the first dose.
  const dose = tapeGauge('dose', 'DOSE', [], 3, null);
  dose.root.title = "Crew g-dose: g-seconds above the crew's tolerance, as a share of the fatal limit (it recovers below the amber zone)";
  const doseTone = new ToneSlot(dose.valueEl);
  const doseNil = classFlag(dose.root, 'nil');
  const gauges = el('div', 'panel gauges br', [thr.root, gG.root, dose.root], { 'data-show': 'external map' });

  const node = { dv: new TextSlot(), burn: new TextSlot(), start: new TextSlot() };
  // Title row: 'Maneuver' and the countdown to the burn's start (amber in its last 10 s); then delta-v and burn time.
  const nodeStartEl = el('span', 'pname nstart', [node.start.node], { title: 'Time to the start of the burn' });
  const nodePanel = el('div', 'panel node', [el('div', 'ptitle', [el('span', '', ['Maneuver']), nodeStartEl]), row('Δv remaining', node.dv).root, row('Burn time', node.burn).root], {
    'data-show': 'external map',
  });
  const nodeShow = hiddenFlag(nodePanel);
  const nodeImminent = classFlag(nodePanel, 'imminent');
  const nodeDvTone = new ToneSlot(nodePanel.querySelector('.row .val')!);

  // The bottom cluster is one instrument: a gunmetal housing that carries the SAS controls, the navball with its
  // read-out windows and the tape gauges, symmetric about the ball (which stays on the screen's centre line); the
  // maneuver readout stands on the housing to the right of the ball.
  const housing = el('div', 'housing', [], { 'data-show': 'external map' });
  const bottom = el('div', 'bottom', [housing, sasPanel, pitchWin, nbwrap, rollWin, gauges, nodePanel]);

  // ---------------------------------------------------------------------------------------- centre
  // Mission failed: a modal outcome over the dimmed, inert flight panels (the clock stays), with the next steps the
  // app shell offers (HudOptions.failureActions).
  const failReason = new TextSlot('');
  const failActions = (opts.failureActions ?? []).map((a) => hudButton([el('b', '', [a.label]), ...(a.key ? [keyCap(a.key)] : [])], 'failact', a.title ?? a.label, () => a.run()));
  const failed = el('div', 'failed', [
    el('h2', '', ['MISSION FAILED']),
    el('p', '', [failReason.node]),
    ...(failActions.length > 0 ? [el('div', 'actions', failActions)] : [el('div', 'note', ['Flight controls are off'])]),
  ]);
  const failedShow = hiddenFlag(failed);
  const failedClass = classFlag(root, 'failed-state');

  // --------------------------------------------------------------------------------------- key help
  const groups = new Map<string, HudKeyHelpEntry[]>();
  for (const e of opts.keyHelp) {
    const list = groups.get(e.group) ?? [];
    list.push(e);
    groups.set(e.group, list);
  }
  const groupEls: HTMLElement[] = [];
  const groupHeights: number[] = [];
  for (const [g, entries] of groups) {
    const group = el('div', 'group', [el('h3', '', [g])]);
    for (const e of entries) {
      const keys = el('span', 'keys', [...e.keys.map((k) => keyCap(k)), ...e.lockedKeys.map((k) => keyCap(k, 'kbd locked', 'Only with Keyboard capture on (the switch at the top right)'))]);
      group.append(el('div', 'item', [el('span', '', [e.text]), keys]));
    }
    groupEls.push(group);
    groupHeights.push(entries.length + 1.6);
  }
  const cols = el(
    'div',
    'cols',
    balanceColumns(groupHeights, 3).map((ids) => el('div', 'col', ids.map((i) => groupEls[i]!))),
  );
  const help = el(
    'div',
    'help',
    [
      el('div', 'sheet', [
        el('div', 'head', [
          el('div', '', [el('h2', '', ['Flight controls']), el('div', 'note', ['Every key works without capture; keys with an amber outline also need Keyboard capture on (the switch at the top right: fullscreen with keyboard lock, Esc leaves it).'])]),
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
  let bezelPx = 0;
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const box = e.devicePixelContentBoxSize?.[0];
      const px = box ? Math.round(box.inlineSize) : Math.round(e.contentRect.width * devicePixelRatio);
      const size = Math.max(1, Math.min(2048, px));
      if (e.target === ballCanvas) {
        ballPx = size;
        ballCanvas.width = size;
        ballCanvas.height = size;
      } else {
        // The bezel canvas is larger than the ball's box (its soft shadow fades out inside the canvas).
        bezelPx = size;
        bezelCanvas.width = size;
        bezelCanvas.height = size;
      }
    }
    // A hidden ball (interior view) reports a zero box: nothing to draw.
    if (bezelCtx && ballPx >= 16 && bezelPx >= ballPx) drawNavballBezel(bezelCtx, bezelPx, HUD_BALL_RADIUS_FRACTION * (ballPx / bezelPx));
  });
  ro.observe(ballCanvas);
  ro.observe(bezelCanvas);
  // The ball is drawn larger than the window and the bezel's lip covers its outer rim (HUD_BALL_LIP).
  const ballOpts = { radiusFraction: HUD_BALL_RADIUS_FRACTION / HUD_BALL_LIP, lip: HUD_BALL_LIP, instrument: true };

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
  const notify = (message: string, tone: 'caution' | 'info' = 'caution'): Toast => {
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
      return existing;
    }
    const countSlot = new TextSlot('');
    const t: Toast = { text: message, count: 1, life: TOAST_SECONDS, frame: frameNo, el: el('div', `toast ${tone === 'info' ? 'info' : ''}`.trim(), [message, el('span', 'count', [countSlot.node])]), countSlot, fading: false };
    toasts.push(t);
    toastsEl.append(t.el);
    while (toasts.length > MAX_TOASTS) toasts.shift()!.el.remove();
    return t;
  };
  const dropToast = (t: Toast): void => {
    const i = toasts.indexOf(t);
    if (i < 0) return;
    toasts.splice(i, 1);
    t.el.remove();
  };
  /**
   * A sphere-of-influence change and the milestone a scenario hangs on it come together: one toast. The
   * milestone's (it names the mission step) replaces the change's, and a change after its milestone adds none.
   */
  const soiToasts = new Map<string, { toast: Toast; milestone: boolean }>();
  const liveSoiToast = (bodyId: string): { toast: Toast; milestone: boolean } | null => {
    const e = soiToasts.get(bodyId);
    return e && toasts.includes(e.toast) ? e : null;
  };

  /** Warp index of the previous snapshot (null before the first update). */
  let warpSeen: number | null = null;

  const eventToast = (e: SimEvent, s: SimSnapshot): void => {
    switch (e.type) {
      case 'milestone': {
        const soiBody = milestoneSoiBody(e.milestone.id, s, defs);
        const prior = soiBody !== null ? liveSoiToast(soiBody) : null;
        if (prior && !prior.milestone) dropToast(prior.toast);
        const t = notify(milestoneTitle(e.milestone.id, s, defs), 'info');
        if (soiBody !== null) soiToasts.set(soiBody, { toast: t, milestone: true });
        break;
      }
      case 'soiChange': {
        if (liveSoiToast(e.toBodyId)?.milestone || liveSoiToast(e.fromBodyId)?.milestone) break;
        const t = notify(`Entered the ${defs.bodies[e.toBodyId]?.name ?? e.toBodyId} sphere of influence`, 'info');
        soiToasts.set(e.toBodyId, { toast: t, milestone: false });
        soiToasts.set(e.fromBodyId, { toast: t, milestone: false });
        break;
      }
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

  /**
   * A full tile: the icon plate, then line 1 with the stage number, the name and the key cap (next stage) or the
   * ACTIVE tag (the stage burning now), line 2 with delta-v, TWR and burn time (an engine-less next stage: what
   * firing it does; a locked one: the lock and its reason), and for the active stage a thin propellant strip (an
   * unfired stage is always full).
   */
  function fullTile(t: StageTileView, role: 'next' | 'active', locked: boolean): { tile: HTMLElement; slot: StageSlot } {
    const dv = new TextSlot('');
    let meta: TextSlot | null = null;
    let fill: FillSlot | null = null;
    let barTone: Flag | null = null;
    // The next tile names what firing it does (the stage's label: "M-3 separation"); the active tile names what is
    // burning (the stage group of its engines: "Meridian M-3"), with the event that lit it in its tooltip.
    const title = role === 'active' ? (t.burnName ?? t.label) : t.label;
    const head: HTMLElement[] = [el('span', 'sn', [t.number]), el('div', 'name', [title])];
    if (role === 'next' && !locked) head.push(el('span', 'hint', [keyCap(keyFor('stage') ?? 'Space')]));
    let line2: HTMLElement;
    if (locked) {
      line2 = el('div', 'l2 lockline', [el('b', '', ['LOCKED']), el('span', '', ['staging interlock'])]);
    } else {
      meta = new TextSlot('');
      line2 = el('div', 'l2', [...(t.hasEngines ? [el('span', 'dv', [dv.node])] : []), el('span', 'meta', [meta.node])]);
    }
    const mainParts: HTMLElement[] = [el('div', 'l1', head), line2];
    if (t.propellant !== null && role === 'active') {
      const b = bar('prop');
      fill = b.fill;
      barTone = classFlag(b.root, 'caution');
      mainParts.push(b.root);
    }
    // The burning stage shows an engine (what runs), whatever event icon its stage carries.
    const icon = locked ? LOCK_ICON : STAGE_ICONS[stageIconFor(role === 'active' && t.hasEngines ? 'engine' : t.icon)];
    const tile = el('div', `tile ${role}`, [el('div', 'ico', [svgIcon(icon)]), el('div', 'main', mainParts)]);
    if (role === 'active') tile.title = `Active stage (its engines run or are armed), lit by stage ${t.number}: ${t.label}. Δv in vacuum${t.deltaVNow ? `; ${t.deltaVNow} at the current air pressure` : ''}`;
    if (role === 'next') {
      if (locked) tile.classList.add('locked');
      tile.setAttribute(INTERACTIVE_ATTR, '');
      tile.title = locked ? 'Staging interlock: the sim holds the next stage for a moment' : `Fire this stage (${keyFor('stage') ?? 'Space'})`;
      tile.addEventListener('pointerdown', (e) => e.preventDefault());
      tile.addEventListener('click', () => {
        if (!tile.classList.contains('locked')) dispatch('stage');
      });
    }
    return { tile, slot: { compact: false, dv, meta, fill, barTone } };
  }

  function updateStages(s: SimSnapshot): void {
    const st = describeStages(s, defs);
    const remaining = st.tiles.filter((t) => !t.fired);
    const next = remaining.find((t) => t.next) ?? null;
    const later = remaining.filter((t) => t !== next);
    const active = st.active >= 0 ? st.tiles[st.active]! : null;
    const tileKey = (t: StageTileView): string => `${t.index}:${t.label}:${t.burnName}:${t.icon}:${t.actionKinds.join(',')}:${t.hasEngines ? 1 : 0}:${t.propellant !== null ? 1 : 0}`;
    const key = `${later.map(tileKey).join('|')}#${next ? tileKey(next) : '-'}#${active ? tileKey(active) : '-'}#${st.lockout ? 1 : 0}`;
    if (key !== stageKey) {
      stageKey = key;
      stagesEl.replaceChildren();
      stageSlots = new Map();
      if (later.length > 0) {
        // One list, highest stage on top: number, icon, name and (engine stages) delta-v on one line each.
        const list = el('div', 'later');
        for (const t of [...later].reverse()) {
          const dv = new TextSlot('');
          list.append(el('div', 'tile compact', [el('div', 'sn', [t.number]), el('div', 'ico', [svgIcon(STAGE_ICONS[stageIconFor(t.icon)])]), el('div', 'name', [t.label]), el('div', 'dv', [dv.node])]));
          stageSlots.set(t.index, { compact: true, dv, meta: null, fill: null, barTone: null });
        }
        stagesEl.append(list);
      }
      for (const [t, role] of [
        [next, 'next'],
        [active, 'active'],
      ] as const) {
        if (!t) continue;
        const { tile, slot } = fullTile(t, role, role === 'next' && st.lockout);
        stagesEl.append(tile);
        stageSlots.set(t.index, slot);
      }
    }
    for (const t of [...later, ...(next ? [next] : []), ...(active ? [active] : [])]) {
      const slot = stageSlots.get(t.index);
      if (!slot) continue;
      slot.dv.set(t.hasEngines ? (slot.compact ? t.deltaV : `Δv ${t.deltaV}`) : '');
      // Far from any body the acceleration (its unit says what it is) stands in for the TWR.
      slot.meta?.set(t.hasEngines ? `${t.thrustLabel === 'TWR' ? 'TWR ' : ''}${t.thrustValue}  ${t.burnTime}` : t.actions);
      if (slot.fill && t.propellant !== null) {
        slot.fill.set(t.propellant);
        slot.barTone?.set(t.propellant < 0.1);
      }
    }
    // The total only while something can still burn: with only chutes or separations left it would read "Δv 0".
    const canBurn = active !== null || remaining.some((t) => t.hasEngines);
    // Every delta-v of the stack is in vacuum (the stages fire high up); the header says so and adds them up.
    stagesMore.set(canBurn ? `Δv ${st.deltaVTotal} vac` : remaining.length === 0 ? 'all fired' : `${remaining.length} left`);
    stagesMoreAlone.set(later.length === 0);
  }

  function updateResources(s: SimSnapshot): void {
    const sum = summarizeResources(describeResources(s, defs));
    resShow.set(sum.inUse.length + sum.full.length > 0);
    const key = `${sum.inUse.map((g) => g.id).join('|')}#${sum.full.join('|')}`;
    if (key !== resKey) {
      resKey = key;
      resGroupsEl.replaceChildren();
      resSlots = [];
      // One line per group in use (its resource that runs out first: the group's name and share, the bar under
      // them across the panel, so a long name reads in full), the full groups folded into one line: their names
      // while they fit on it, else their count (the names in its tooltip).
      for (const g of sum.inUse) {
        const pb = bar();
        const pct = new TextSlot(g.amount);
        const line = el('div', 'rrow', [el('span', 'rn', [g.label]), el('span', 'rp', [pct.node]), pb.root]);
        resGroupsEl.append(line);
        resSlots.push({ fill: pb.fill, pct, low: classFlag(pb.root, 'caution'), title: new AttrSlot(line, 'title') });
      }
      if (sum.full.length > 0) {
        const names = sum.full.join(' · ');
        const listed = names.length <= FULL_LINE_CHARS;
        const what = listed ? names : `${sum.full.length} stage groups`;
        resGroupsEl.append(el('div', sum.inUse.length > 0 ? 'full' : 'full only', [el('b', '', [sum.inUse.length > 0 ? 'Full' : 'All full']), ` ${what}`], listed ? {} : { title: names }));
      }
    }
    sum.inUse.forEach((g, i) => {
      const slot = resSlots[i];
      if (!slot) return;
      slot.fill.set(g.fraction);
      slot.pct.set(g.amount);
      slot.low.set(g.fraction < 0.1);
      slot.title.set(g.detail);
    });
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
    // Heating in an entry (isEntering): an ascent heats up as well but keeps its orbit panel.
    const heating = isEntering(s, defs);
    const airborne = !landed && inAtmosphere(s, defs);
    // A thermal limit drawing near shows its rows whatever the phase (an ascent too).
    const ablWarn = r.ablatorFraction !== null && ablatorTone(r.ablatorFraction) === 'warning';
    const thermalWarn = !landed && (ablWarn || r.maxTempFraction > SKIN_CAUTION);

    // Panel visibility. The orbit leaves during an entry or while falling through the air on a suborbital path.
    const showOrbit = !landed && (kind === 'map' || (kind === 'external' && phase.show && !heating));
    // Air data in air only: the sim's Mach number keeps a nominal speed of sound in vacuum (describeAirData).
    const inAir = airborne && (r.dynamicPressure > 1 || r.mach > 0.02);
    // The chute light matters while the next chute stage could be fired: coming down through the air.
    const chuteRelevant = r.chuteEnvelope !== null && airborne && r.verticalSpeed < 0;
    // The lift vector is flown while the entry heats up (the hypersonic part); under chutes it means nothing.
    const liftRelevant = r.liftVectorUp !== null && heating;
    const showEntry = heating || chuteRelevant || liftRelevant || thermalWarn;
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
    const ltExpanded = landingTargetExpanded(s, defs);
    orbitShow.set(showOrbit);
    placeAtm(showEntry ? 'entry' : showOrbit ? 'orbit' : 'own');
    atmShow.set(inAir && !showEntry && !showOrbit);
    atmRowsShow.set(inAir || showEntry);
    entryShow.set(showEntry);
    fluxShow.set(heating);
    // The heat shield matters while it heats up, or once it is in its last margin.
    ablShow.set(r.ablatorFraction !== null && (heating || ablWarn));
    liftShow.set(liftRelevant);
    chuteShow.set(chuteRelevant);
    ltShow.set(r.landingTarget !== null);
    ltRowsShow.set(ltExpanded);
    ltLineShow.set(!ltExpanded);
    if (r.landingTarget === null) ltCurrentRows = null;
    padShow.set(showPad);
    padTargetsShow.set(targetButtonsShown > 0);
    padNameShow.set(targetButtonsShown === 0);
    padHintShow.set(targetButtonsShown > 0 && r.targetBodyId === null);
    relIncShow.set(r.targetRelativeInclination !== null);
    crossShow.set(r.launchWindow !== null);
    azShow.set(r.launchWindow !== null);
    for (const [id, b] of targetButtons) b.on.set(r.targetBodyId === id);
    nodeShow.set(nb !== null);
    nodeImminent.set(tBurn !== null && tBurn >= 0 && tBurn < 10);
    noticeShow.set(s.terrain.pending && r.altitudeRadar < RADAR_ALTITUDE_SWITCH);
    failedShow.set(s.mission.failed);
    failedClass.set(s.mission.failed);
    // The g-dose line reads a dim 0 % until a dose builds up (it is always there: the tubes never move).
    doseNil.set(r.gDose <= 0);

    // Status edges: the clock amber while warp is capped, the orbit amber / red with its periapsis, the entry panel
    // amber while heating and red past a redline.
    clockSt.set(w.maxIndex < WARP_LEVELS.length - 1 && w.limitedBy ? 'caution' : '');
    orbitSt.set(phase.periapsisTone === 'normal' ? '' : phase.periapsisTone);
    entrySt.set((r.ablatorFraction !== null && ablatorTone(r.ablatorFraction) === 'warning') || r.maxTempFraction > 0.85 ? 'warning' : heating ? 'caution' : '');

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
    const st = s.staging;
    const activeStage = describeActiveStage(s);
    const sig = `${kind}|${altMode}|${altSrc}|${landed}|${s.navball.mode}|${r.sasEnabled}|${r.sasMode}|${w.index}|${w.maxIndex}|${w.onRails}|${w.limitedBy}|${v?.bodyId}|${showOrbit}|${phase.periapsisTone}|${phase.suborbital}|${r.periapsisAltitude < 0}|${inAir}|${showEntry}|${heating}|${r.ablatorFraction !== null}|${r.gDose > 0}|${liftRelevant && r.liftVectorUp}|${r.chuteEnvelope}|${lt?.targetId}|${lt?.predicted?.kind}|${ltExpanded}|${hasGroundTrack(r.horizontalSpeed, r.verticalSpeed)}|${showPad}|${r.targetBodyId}|${r.launchWindow !== null}|${nb === null ? '-' : tBurn === null ? 'n' : tBurn < 0 ? 'b' : 'w'}|${nb?.insufficientDeltaV}|${st.nextStage}|${st.lockout}|${st.stages.length}|${activeStage}|${s.mission.failed}`;
    textClock += dt;
    const due = textClock >= TEXT_PERIOD - 1e-4;
    if (forceText || due || sig !== lastSig) {
      textClock = due ? Math.min(Math.max(0, textClock - TEXT_PERIOD), TEXT_PERIOD) : 0;
      forceText = false;
      lastSig = sig;
      textUpdates++;
      updateText(s, kind, { showOrbit, inAir: inAir || showEntry, showEntry, showPad, ltExpanded });
    }
  }

  /** Index of the stage that owns the running engines (describeStages().active), cheaply, for the signature. */
  function describeActiveStage(s: SimSnapshot): number {
    const st = s.staging;
    for (let i = Math.min(st.nextStage, st.stages.length) - 1; i >= 0; i--) {
      const info = st.stages[i]!;
      if (info.fired && info.propellantFraction !== null) return i;
    }
    return -1;
  }

  /** Every text readout (and the slow bars) of the visible panels. */
  function updateText(s: SimSnapshot, kind: ViewKind, show: { showOrbit: boolean; inAir: boolean; showEntry: boolean; showPad: boolean; ltExpanded: boolean }): void {
    const r = s.readouts;
    const v = activeVesselOf(s);
    const bodyDef = v ? defs.bodies[v.bodyId] : undefined;
    const f = describeFlight(s, altMode);

    // Clock and warp.
    met.set(formatMet(r.met));
    ut.set(formatUt(s.ut));
    const w = describeWarp(s, WARP_LEVELS);
    warpFactor.set(w.factor);
    railsLabel.set(w.index > 0 ? (w.onRails ? 'rails' : 'physics') : '');
    warpLimit.set(w.limit ?? '');
    warpLimitShow.set(w.limit !== null);

    // Altitude: the reference is named (radar, or sea level where there is an ocean, the datum elsewhere); standing
    // on a surface the title says so in place of the AUTO tag.
    const vs = activeVesselOf(s)?.situation;
    const resting = vs === 'prelaunch' ? 'on pad' : vs === 'landed' ? 'landed' : vs === 'splashed' ? 'splashed' : null;
    altLabel.set(`Altitude · ${f.altitudeSource === 'radar' ? 'radar' : altitudeDatumName(s, defs)}${resting ? ` · ${resting}` : altMode === 'auto' ? ' · auto' : ''}`);
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
      const below = s.readouts.periapsisAltitude < 0;
      orbit.peT.set(below ? '' : o.periapsisTime);
      apsisWide.set(below);
      peTone.set(phase.periapsisTone === 'normal' ? '' : phase.periapsisTone);
      subTagShow.set(phase.suborbital);
      closedRowsShow.set(!below);
      orbit.inc.set(o.inclination);
      orbit.per.set(o.period);
    }

    // Atmospheric flight.
    if (show.inAir) {
      const air = describeAirData(s, defs);
      atm.q.set(air.q);
      atm.mach.set(air.mach);
      atm.aoa.set(air.aoa);
    }

    // Entry: heat shield, skin temperature, lift vector, chute envelope. Each bar is coloured as a whole by the
    // zone its reading is in (the heat shield red only below its redline).
    if (show.showEntry) {
      entry.flux.set(formatHeatFlux(r.heatFlux));
      if (r.ablatorFraction !== null) {
        ablRow.value.set(formatPercent(r.ablatorFraction));
        ablRow.fill.set(r.ablatorFraction);
        ablRow.tone.set(ablatorTone(r.ablatorFraction));
      }
      tempRow.value.set(formatPercent(r.maxTempFraction));
      tempRow.fill.set(r.maxTempFraction);
      tempRow.tone.set(r.maxTempFraction > 0.85 ? 'warning' : r.maxTempFraction > SKIN_CAUTION ? 'caution' : 'good');
      entry.lift.set(r.liftVectorUp ? 'LIFT UP' : 'LIFT DOWN');
      const chute = describeChuteEnvelope(s, defs);
      if (chute) {
        chuteLabel.set(chute.label);
        entry.chute.set(chute.light);
        chuteTone.set(chute.tone);
        chuteTitle.set(chute.detail);
      }
    }

    // Landing target.
    const lt = describeLandingTarget(s);
    if (lt) {
      ltName.set(lt.name);
      ltKind.set(lt.kindLabel === 'Recovery zone' ? 'Recovery' : 'Target');
      const rows = landingTargetRows(lt);
      if (show.ltExpanded) {
        ltRows.forEach((slot, i) => {
          const rr = rows[i];
          slot.show.set(rr !== undefined);
          if (!rr) return;
          slot.label.set(rr[0]);
          slot.value.set(rr[1]);
          slot.pred.set(isPredictionRow(rr[0]));
        });
        ltCurrentRows = rows;
      } else {
        // One line: distance and bearing (the first two rows of the full readout).
        ltLine.set(`${lt.distance} · ${lt.bearing}`);
        ltCurrentRows = rows.slice(0, 2);
      }
      // Recovery zone: lit only once something says where the vessel comes down (an impact prediction, or the
      // sub-point when landed or under chutes); an entry-interface prediction alone lights nothing (zoneStatus).
      const zone = show.ltExpanded ? zoneStatus(s, defs) : null;
      zoneShow.set(zone !== null);
      ltSt.set(zone ? (zone.inside ? 'good' : 'caution') : '');
      if (zone) {
        zoneText.set(zone.inside ? 'INSIDE ZONE' : 'OUTSIDE ZONE');
        zoneSub.set(lt.zoneRadius !== null ? `r ${lt.zoneRadius}` : '');
        zoneTone.set(zone.inside ? 'good' : 'caution');
        zoneEl.title = zone.basis === 'impact' ? 'From the predicted impact point' : 'From the point under the vessel';
      }
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
    {
      const f = r.gDoseLimit > 0 ? Math.min(1, Math.max(0, r.gDose) / r.gDoseLimit) : 0;
      dose.fill.set(f);
      dose.value.set(formatPercent(f));
      doseTone.set(f >= DOSE_WARNING ? 'warning' : f > 0 ? 'caution' : '');
    }

    // Node burn.
    const nbv = describeNodeBurn(s);
    if (nbv) {
      node.dv.set(nbv.deltaV);
      node.burn.set(nbv.burnTime);
      node.start.set(nbv.started ? `burning · ${nbv.startIn}` : nbv.startIn);
      nodeDvTone.set(nbv.insufficient ? 'warning' : 'accent');
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
    setKeyboardLocked(locked, fullscreen = locked) {
      setCapture(locked, fullscreen);
    },
    setCaptureControlVisible(v) {
      kbCaptureShow.set(v);
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
