/**
 * The flight HUD (src/core/contracts/ui.ts `Hud`): DOM + Canvas over the WebGPU canvas, with pointer events
 * only on interactive parts (marked `data-hud-interactive`, which the input system reads as
 * PointerState.overUi). It renders only from the SimSnapshot and the presented CameraState, and acts only by
 * dispatching ButtonActions (the same path as the keys) or, for target selection on the pad, PlayerCommands.
 *
 * Layout by camera.kind (unknown modes behave as their kind):
 *   external  everything;
 *   interior  clock, warp, notifications, stage stack and the system strip (the cockpit instruments show the rest);
 *   map       clock, warp, altitude, orbit, landing target, node burn, navball with SAS (no stage stack).
 *
 * The navball: every update renders the shared 512 x 512 texture (NavballRenderer.view, published as
 * 'ui.navball' for the cockpit) and, while the navball is on screen, the same ball at native resolution into
 * the HUD's own WebGPU canvas. The app must not render the navball separately.
 */
import type { ButtonAction, PlayerCommands, SasMode } from '@/core/contracts/controls';
import { SAS_MODES } from '@/core/contracts/controls';
import { WARP_LEVELS, MAX_PHYSICS_WARP_INDEX, type DefLibrary } from '@/core/contracts/defs';
import type { CameraState, ViewKind } from '@/core/contracts/render';
import type { SimEvent, SimSnapshot } from '@/core/contracts/sim';
import type { Hud } from '@/core/contracts/ui';
import type { GpuHandle } from '@/core/gpu/device';
import {
  formatAltitude,
  formatBearing,
  formatDeg,
  formatG,
  formatHeatFlux,
  formatMach,
  formatMet,
  formatPercent,
  formatPressure,
  formatRadAsDeg,
  formatSpeed,
  formatUt,
} from '../format';
import { LOCK_ICON, MARKER_COLORS, MARKER_ICONS, STAGE_ICONS, stageIconFor, svgIcon, UNLOCK_ICON } from '../icons';
import { activeVesselOf, describeLandingTarget, describeNodeBurn, describeOrbit, describePad, describeResources, describeStages, describeWarp, landingTargetRows } from '../model';
import type { NavballRendererImpl } from '../navball/navballRenderer';
import { bar, classFlag, el, FillSlot, Flag, hiddenFlag, hudButton, INTERACTIVE_ATTR, TextSlot, ToneSlot } from './dom';
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
  /** CPU time of the last update and its running mean, ms. */
  readonly lastUpdateMs: number;
  readonly meanUpdateMs: number;
  /** Label/value rows currently shown by the landing-target panel (null when hidden). */
  landingTargetRows(): [string, string][] | null;
  /** Current notifications (oldest first). */
  notifications(): string[];
}

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
  /** Altimeter source: auto = radar within 2 km of the ground in flight, sea level otherwise. */
  let altMode: 'auto' | 'asl' | 'radar' = 'auto';

  // ------------------------------------------------------------------------------------ top left: clock
  const met = new TextSlot('T+ 00:00:00');
  const ut = new TextSlot('');
  const warpFactor = new TextSlot('×1');
  const warpLimit = new TextSlot('');
  const chevrons: HTMLElement[] = [];
  for (let i = 1; i < WARP_LEVELS.length; i++) chevrons.push(el('i', i <= MAX_PHYSICS_WARP_INDEX ? 'phys' : ''));
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
      el('div', 'chev', chevrons),
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
  const altPanel = el('div', 'panel alt', [el('div', 'ptitle', [el('span', '', [altLabel.node])]), el('span', 'val big', [altValue.node]), el('div', 'vs', [vsValue.node])], {
    [INTERACTIVE_ATTR]: '',
    title: 'Click: automatic / sea level / radar altitude',
  });
  altPanel.style.display = 'block';
  altPanel.querySelector('.ptitle')!.setAttribute('style', 'justify-content:center');
  altPanel.addEventListener('click', () => {
    altMode = altMode === 'auto' ? 'asl' : altMode === 'asl' ? 'radar' : 'auto';
  });
  const toastsEl = el('div', 'toasts');
  const tc = el('div', 'tc', [el('div', '', [altPanel], { 'data-show': 'external map' }), toastsEl]);

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
  const apsis = (label: string, value: TextSlot, time: TextSlot): { root: HTMLDivElement; valueEl: HTMLSpanElement } => {
    const valueEl = el('span', 'val', [value.node]);
    return { root: el('div', 'apsis', [el('span', 'lbl', [label]), valueEl, el('span', 'sub', [time.node])]), valueEl };
  };
  const peRow = apsis('Periapsis', orbit.pe, orbit.peT);
  const peTone = new ToneSlot(peRow.valueEl);
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

  const atm = { q: new TextSlot(), mach: new TextSlot(), aoa: new TextSlot() };
  const atmPanel = el('div', 'panel atm', [el('div', 'ptitle', [el('span', '', ['Atmosphere'])]), row('Dyn. pressure', atm.q).root, row('Mach', atm.mach).root, row('Angle of attack', atm.aoa).root], { 'data-show': 'external' });
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
  const entryPanel = el('div', 'panel entry', [el('div', 'ptitle', [el('span', '', ['Entry'])]), fluxRow.root, ablBlock, row('Skin temperature', entry.temp).root, tempBar.root, liftRow, chuteRow], { 'data-show': 'external' });
  const entryShow = hiddenFlag(entryPanel);

  const ltName = new TextSlot('');
  const ltKind = new TextSlot('Landing target');
  const ltInside = el('span', 'inside', ['INSIDE ZONE']);
  const ltInsideShow = hiddenFlag(ltInside);
  const ltRows: { label: TextSlot; value: TextSlot; root: HTMLDivElement }[] = [];
  const ltRowsEl = el('div', 'rows');
  for (let i = 0; i < 5; i++) {
    const v = new TextSlot();
    const r = row('', v);
    ltRows.push({ label: r.label, value: v, root: r.root });
    if (i === 4) r.root.classList.add('pred');
    ltRowsEl.append(r.root);
  }
  const ltPanel = el('div', 'panel lt', [el('div', 'ptitle', [el('span', '', [ltKind.node]), ltInside]), el('div', 'row', [el('span', 'pname', [ltName.node])]), ltRowsEl], {
    'data-show': 'external map interior',
  });
  ltPanel.querySelector('.row')!.setAttribute('style', 'justify-content:flex-start;margin-bottom:0.25em');
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
  const stagesEl = el('div', 'stages');
  const stagesMore = new TextSlot('');
  const stagesMoreEl = el('div', 'more', [stagesMore.node]);
  const resGroupsEl = el('div', 'groups');
  const resPanel = el('div', 'panel res', [el('div', 'ptitle', [el('span', '', ['Resources'])]), resGroupsEl], { 'data-show': 'external' });
  const resShow = hiddenFlag(resPanel);
  const rcol = el('div', 'rcol', [el('div', 'stagewrap', [stagesMoreEl, stagesEl], { 'data-show': 'external interior' }), resPanel]);
  let stageKey = '';
  let stageSlots: { dv: TextSlot; meta: TextSlot; fill: FillSlot | null; barTone: Flag | null; tile: HTMLElement }[] = [];
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
  const sasPanel = el('div', 'panel sas', [toggles, modes, el('div', 'modecap', [sasCaption.node])], { 'data-show': 'external map' });

  const speedMode = new TextSlot('Surface');
  const speedValue = new TextSlot('');
  const speedPanel = el('div', 'panel speed', [el('div', 'ptitle', [el('span', 'mode', [speedMode.node]), el('span', '', ['speed'])]), el('span', 'val big', [speedValue.node])], {
    [INTERACTIVE_ATTR]: '',
    title: 'Click: surface / orbit navball (Tab)',
  });
  speedPanel.querySelector('.ptitle')!.setAttribute('style', 'justify-content:center');
  speedPanel.addEventListener('click', () => dispatch('toggleNavballMode'));
  const ballCanvas = el('canvas');
  const hdg = new TextSlot('000°');
  const pitchText = new TextSlot('');
  const rollText = new TextSlot('');
  const ball = el('div', 'ball', [
    ballCanvas,
    el('div', 'bezel'),
    el('div', 'hdg', [hdg.node]),
    el('div', 'pr pitch', [el('span', 'lbl', ['Pitch']), pitchText.node]),
    el('div', 'pr roll', [el('span', 'lbl', ['Roll']), rollText.node]),
  ]);
  const nbwrap = el('div', 'nbwrap', [speedPanel, ball]);

  const thrText = new TextSlot('0 %');
  const thrFillEl = el('i');
  const thrFill = new FillSlot(thrFillEl, 'y');
  const gText = new TextSlot('');
  const gFillEl = el('i');
  const gFill = new FillSlot(gFillEl, 'y');
  const doseBar = bar('caution');
  const doseShow = hiddenFlag(doseBar.root);
  const gauges = el('div', 'panel gauges', [
    el('div', 'gauge thr', [el('span', 'gv', [thrText.node]), el('div', 'tube', [thrFillEl, el('div', 'ticks')]), el('span', 'gl', ['THROTTLE'])]),
    el('div', 'gauge g', [el('span', 'gv', [gText.node]), el('div', 'tube', [gFillEl, el('div', 'ticks')]), el('div', 'dose', [doseBar.root]), el('span', 'gl', ['G LOAD'])]),
  ]);

  const node = { dv: new TextSlot(), burn: new TextSlot(), start: new TextSlot() };
  const nodePanel = el('div', 'panel node', [el('div', 'ptitle', [el('span', '', ['Maneuver'])]), row('Δv remaining', node.dv).root, row('Burn time', node.burn).root, row('Burn start', node.start).root], {
    'data-show': 'external map',
  });
  const nodeShow = hiddenFlag(nodePanel);
  const nodeImminent = classFlag(nodePanel, 'imminent');
  const nodeDvTone = new ToneSlot(nodePanel.querySelector('.row .val')!);
  const rightStack = el('div', '', [nodePanel, el('div', '', [gauges], { 'data-show': 'external' })]);
  rightStack.setAttribute('style', 'display:flex;flex-direction:column;gap:calc(var(--u) * 1);align-items:flex-start');

  const bottom = el('div', 'bottom', [sasPanel, el('div', '', [nbwrap], { 'data-show': 'external map' }), rightStack]);

  // ---------------------------------------------------------------------------------------- centre
  const notice = el('div', 'notice', [el('div', 'pill', [el('span', 'spin'), el('span', '', ['Loading terrain…'])])]);
  const noticeShow = hiddenFlag(notice);
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
      const keys = el('span', 'keys', [...e.keys.map((k) => el('span', 'kbd', [k])), ...e.lockedKeys.map((k) => el('span', 'kbd locked', [k], { title: 'Only while the keyboard is captured (fullscreen)' }))]);
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

  root.append(tc, tr, lcol, rcol, bottom, notice, failed, help);

  // ---------------------------------------------------------------------------------- navball canvas
  const ctx = ballCanvas.getContext('webgpu');
  if (!ctx) throw new Error('HUD: cannot create a WebGPU context for the navball canvas');
  ctx.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: 'premultiplied' });
  let ballPx = 0;
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const box = e.devicePixelContentBoxSize?.[0];
      const px = box ? Math.round(box.inlineSize) : Math.round(e.contentRect.width * devicePixelRatio);
      ballPx = Math.max(1, Math.min(2048, px));
      ballCanvas.width = ballPx;
      ballCanvas.height = ballPx;
    }
  });
  ro.observe(ballCanvas);

  // ------------------------------------------------------------------------------------- toasts
  interface Toast {
    text: string;
    count: number;
    life: number;
    el: HTMLDivElement;
    countSlot: TextSlot;
    fading: boolean;
  }
  const toasts: Toast[] = [];
  const notify = (message: string, tone: 'caution' | 'info' = 'caution'): void => {
    const existing = toasts.find((t) => t.text === message);
    if (existing) {
      existing.count++;
      existing.life = TOAST_SECONDS;
      existing.countSlot.set(`×${existing.count}`);
      if (existing.fading) {
        existing.fading = false;
        existing.el.classList.remove('fade');
      }
      return;
    }
    const countSlot = new TextSlot('');
    const t: Toast = { text: message, count: 1, life: TOAST_SECONDS, el: el('div', `toast ${tone === 'info' ? 'info' : ''}`.trim(), [message, el('span', 'count', [countSlot.node])]), countSlot, fading: false };
    toasts.push(t);
    toastsEl.append(t.el);
    while (toasts.length > MAX_TOASTS) toasts.shift()!.el.remove();
  };

  const eventToast = (e: SimEvent, s: SimSnapshot): void => {
    switch (e.type) {
      case 'warpChanged':
        if (e.reason) notify(e.reason);
        break;
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

  let lastSnapshot: SimSnapshot | null = null;
  let lastMs = 0;
  let meanMs = 0;
  let samples = 0;
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
  }

  function updateStages(s: SimSnapshot): void {
    const st = describeStages(s);
    const remaining = st.tiles.filter((t) => !t.fired);
    const shown = remaining.slice(0, 6).reverse();
    const key = `${shown.map((t) => `${t.index}:${t.label}:${t.icon}:${t.actionKinds.join(',')}:${t.next ? 1 : 0}:${t.hasEngines ? 1 : 0}`).join('|')}#${st.lockout ? 1 : 0}`;
    if (key !== stageKey) {
      stageKey = key;
      stagesEl.replaceChildren();
      stageSlots = [];
      for (const t of shown) {
        const dv = new TextSlot(t.deltaV);
        const meta = new TextSlot('');
        const icon = el('div', 'ico', [svgIcon(STAGE_ICONS[stageIconFor(t.icon)]), el('span', 'num', [t.number])]);
        const acts = el('span', 'acts', t.actionKinds.slice(0, 4).map((k) => svgIcon(STAGE_ICONS[stageIconFor(k)])));
        const lower = el('div', 'meta', [meta.node]);
        let fill: FillSlot | null = null;
        let barTone: Flag | null = null;
        const line2: HTMLElement[] = [lower, acts];
        if (t.propellant !== null) {
          const b = bar();
          fill = b.fill;
          barTone = classFlag(b.root, 'caution');
          line2.push(b.root);
        }
        const main = el('div', 'main', [el('div', 'l1', [el('div', 'name', [t.label]), el('div', 'dv', [dv.node])]), el('div', 'l2', line2)]);
        const tile = el('div', 'tile', [icon, main]);
        if (t.next) {
          tile.classList.add('next');
          if (st.lockout) tile.classList.add('locked');
          const hint = el('span', 'hint', st.lockout ? ['Locked'] : [el('span', 'kbd', [keyFor('stage') ?? 'Space'])]);
          lower.prepend(hint, ' ');
          tile.setAttribute(INTERACTIVE_ATTR, '');
          tile.title = st.lockout ? 'Staging is locked for a moment after the last stage' : 'Fire this stage (Space)';
          tile.addEventListener('pointerdown', (e) => e.preventDefault());
          tile.addEventListener('click', () => {
            if (!tile.classList.contains('locked')) dispatch('stage');
          });
        }
        stagesEl.append(tile);
        stageSlots.push({ dv, meta, fill, barTone, tile });
      }
    }
    shown.forEach((t, i) => {
      const slot = stageSlots[i];
      if (!slot) return;
      slot.dv.set(t.hasEngines ? `Δv ${t.deltaV}` : '');
      slot.meta.set(t.hasEngines ? `TWR ${t.twr} · ${t.burnTime}` : '');
      if (slot.fill && t.propellant !== null) {
        slot.fill.set(t.propellant);
        slot.barTone?.set(t.propellant < 0.1);
      }
    });
    const hiddenCount = remaining.length - shown.length;
    stagesMore.set(remaining.length === 0 ? 'No stages left' : hiddenCount > 0 ? `+${hiddenCount} more stages · Δv ${st.deltaVTotal}` : `Δv ${st.deltaVTotal} total`);
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
    if (showBall && ballPx > 1) navball.renderTo(encoder, s.navball, ctx!.getCurrentTexture().createView(), gpu.canvasFormat, ballPx);
    gpu.device.queue.submit([encoder.finish()]);
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
    mount(container) {
      container.append(root);
    },
    setVisible(v) {
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
      lastSnapshot = s;
      const kind = camera.kind;
      setKind(kind);
      const showBall = visible && (kind === 'external' || kind === 'map');
      renderNavball(s, showBall);
      for (const e of s.events) eventToast(e, s);
      updateToasts(Math.max(0, realDt));
      if (!visible) {
        record(t0);
        return;
      }
      const r = s.readouts;
      const v = activeVesselOf(s);
      const landed = v !== null && (v.situation === 'prelaunch' || v.situation === 'landed' || v.situation === 'splashed');
      const bodyDef = v ? defs.bodies[v.bodyId] : undefined;

      // Clock and warp.
      met.set(formatMet(r.met));
      ut.set(formatUt(s.ut));
      const w = describeWarp(s, WARP_LEVELS);
      warpFactor.set(w.factor);
      railsLabel.set(w.index > 0 ? (w.onRails ? 'rails warp' : 'physics warp') : '');
      for (let i = 0; i < chevrons.length; i++) {
        chevOn[i]!.set(i + 1 <= w.index);
        chevCap[i]!.set(i + 1 > w.maxIndex);
      }
      warpLimit.set(w.limit ?? '');
      warpLimitShow.set(w.limit !== null);

      // Altitude.
      const useRadar = altMode === 'radar' || (altMode === 'auto' && !landed && r.altitudeRadar < 2000);
      altLabel.set(`Altitude · ${useRadar ? 'radar' : 'sea level'}${altMode === 'auto' ? ' · auto' : ''}`);
      altValue.set(formatAltitude(useRadar ? r.altitudeRadar : r.altitudeAsl));
      const vs = r.verticalSpeed;
      vsValue.set(`${vs >= 0.05 ? '▲' : vs <= -0.05 ? '▼' : '■'} ${formatSpeed(Math.abs(vs))}  ·  horiz. ${formatSpeed(r.horizontalSpeed)}`);

      // Orbit.
      const showOrbit = !landed && (kind === 'external' || kind === 'map');
      orbitShow.set(showOrbit);
      if (showOrbit) {
        const o = describeOrbit(s);
        orbitBody.set(bodyDef?.name ?? '');
        orbit.ap.set(o.apoapsis);
        orbit.apT.set(o.apoapsisTime);
        orbit.pe.set(o.periapsis);
        orbit.peT.set(o.periapsisTime);
        peTone.set(r.periapsisAltitude < 0 ? 'warning' : bodyDef?.atmosphere && r.periapsisAltitude < bodyDef.atmosphere.simTop ? 'caution' : '');
        orbit.inc.set(o.inclination);
        orbit.per.set(o.period);
      }

      // Atmospheric flight.
      const inAir = r.dynamicPressure > 1 || (r.mach > 0.02 && !landed);
      atmShow.set(inAir && !landed);
      if (inAir) {
        atm.q.set(formatPressure(r.dynamicPressure));
        atm.mach.set(formatMach(r.mach));
        atm.aoa.set(formatRadAsDeg(r.angleOfAttack));
      }

      // Entry: heat shield, skin temperature, lift vector, chute envelope.
      const heating = r.heatFlux > 1000;
      const showEntry = heating || r.chuteEnvelope !== null || r.liftVectorUp !== null;
      entryShow.set(showEntry);
      if (showEntry) {
        fluxShow.set(heating);
        entry.flux.set(formatHeatFlux(r.heatFlux));
        ablShow.set(r.ablatorFraction !== null);
        if (r.ablatorFraction !== null) {
          entry.abl.set(formatPercent(r.ablatorFraction));
          ablBar.fill.set(r.ablatorFraction);
        }
        entry.temp.set(formatPercent(r.maxTempFraction));
        tempBar.fill.set(r.maxTempFraction);
        liftShow.set(r.liftVectorUp !== null);
        entry.lift.set(r.liftVectorUp ? 'LIFT UP' : 'LIFT DOWN');
        chuteShow.set(r.chuteEnvelope !== null);
        if (r.chuteEnvelope) {
          entry.chute.set(r.chuteEnvelope.toUpperCase());
          chuteTone.set(r.chuteEnvelope === 'safe' ? 'good' : r.chuteEnvelope === 'risky' ? 'caution' : 'warning');
        }
      }

      // Landing target.
      const lt = describeLandingTarget(s);
      ltShow.set(lt !== null);
      if (lt) {
        ltName.set(lt.name);
        ltKind.set(lt.kindLabel);
        ltInsideShow.set(lt.insideZone);
        const rows = landingTargetRows(lt);
        rows.forEach(([label, value], i) => {
          const slot = ltRows[i];
          if (!slot) return;
          slot.label.set(label);
          slot.value.set(value);
        });
        ltCurrentRows = rows;
      } else ltCurrentRows = null;

      // Pad: target and launch opportunity.
      const p = describePad(s, defs);
      padShow.set(p !== null && (p.target !== 'No target' || targetButtons.size > 0));
      if (p) {
        pad.target.set(p.target);
        padTargetsShow.set(targetButtons.size > 0);
        for (const [id, b] of targetButtons) {
          b.on.set(r.targetBodyId === id);
          // The body the vessel sits on cannot be its target.
          b.show.set(id !== v?.bodyId);
        }
        relIncShow.set(p.relativeInclination !== null);
        pad.relInc.set(p.relativeInclination ?? '');
        crossShow.set(p.planeCrossing !== null);
        pad.cross.set(p.planeCrossing ?? '');
        azShow.set(p.launchAzimuth !== null);
        pad.az.set(p.launchAzimuth ?? '');
      }

      // Stage stack and resources.
      if (kind !== 'map') updateStages(s);
      if (kind === 'external') updateResources(s);

      // SAS, systems, navball readouts.
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
      sasCaption.set(r.sasEnabled ? `Hold · ${SAS_NAMES[r.sasMode]}` : 'SAS off');
      sasCaptionOn.set(r.sasEnabled);
      speedMode.set(s.navball.mode === 'surface' ? 'Surface' : 'Orbit');
      speedValue.set(formatSpeed(s.navball.mode === 'surface' ? r.speedSurface : r.speedOrbital));
      hdg.set(formatBearing(s.navball.headingDeg));
      pitchText.set(formatDeg(s.navball.pitchDeg));
      rollText.set(formatDeg(s.navball.rollDeg));

      // Gauges.
      thrText.set(formatPercent(r.throttle));
      thrFill.set(r.throttle);
      gText.set(formatG(r.gLoad));
      gFill.set(r.gLoad / 10);
      doseShow.set(r.gDose > 0);
      if (r.gDose > 0) doseBar.fill.set(r.gDoseLimit > 0 ? r.gDose / r.gDoseLimit : 0);

      // Node burn.
      const nb = describeNodeBurn(s);
      nodeShow.set(nb !== null);
      if (nb) {
        node.dv.set(nb.deltaV);
        node.burn.set(nb.burnTime);
        node.start.set(nb.started ? `burning · ${nb.startIn}` : nb.startIn);
        nodeImminent.set(nb.imminent);
        nodeDvTone.set(nb.insufficient ? 'warning' : 'accent');
      }

      // Centre notices.
      noticeShow.set(s.terrain.pending && r.altitudeRadar < 2000);
      failedShow.set(s.mission.failed);
      if (s.mission.failed) failReason.set(s.mission.failureReason ?? 'The mission cannot continue.');
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
