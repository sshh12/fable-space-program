/**
 * The menu's screens (ARCHITECTURE 23; frontend-ux 5). Each builds its DOM from the stores, the definitions and
 * the rules, and returns what the shell needs around it: the prompt bar's entries, the screen-specific menu
 * actions, the focus to start on, the camera's subject, and a `live` function for the text that changes (run at
 * most at the HUD's 10 Hz). No screen holds a number that is a rule, a pad count or a rate: they are read here.
 */
import type { LaunchSiteDef, VehicleDef } from '@/core/contracts/defs';
import type { LobbySummary, PadClass, ShipRecord, UniverseRules } from '@/core/contracts/net';
import type { SpawnRequest, SpawnSlot } from '@/core/contracts/session';
import type { VehicleCapabilities } from '@/core/contracts/vehicle';
import { presentableVehicleIds } from '@/core/access/presentable';
import { padLocationOf } from '@/core/defs/sites';
import { el, focusable } from './dom/kit';
import { needsIdentity } from './identity';
import { leaveOutcome } from './leaveOutcome';
import type { HubTab, ShellEvent, ShellState } from './machine';
import { classOutlook, cohortLeadSeconds, launchesPerHour, padRows, type PadRow, type VehicleFit } from './pads';
import { formatSpan, isNever, rulesView } from './rulesView';
import { formatSolarClock, solarViewAt } from './solar';
import { formatEstimate, ordinal, type SpawnFlow, type SpawnPhase } from './spawnFlow';
import type { ShellDeps, ShellSession } from './types';

/** A prompt of the prompt bar: the menu action, the words, and what a click on it does. */
export interface PromptEntry {
  action: string;
  text: string;
  run?: () => void;
}

export interface ScreenView {
  main: HTMLElement;
  aside?: HTMLElement;
  /** Wider content column (rules, credits, my ships). */
  wide?: boolean;
  prompts: PromptEntry[];
  /** Screen-specific menu actions (menu:secondary, menu:edit, menu:remove, menu:stages, ...). True when handled. */
  actions?: Partial<Record<string, () => boolean>>;
  focus?: string;
  subject: 'earth' | 'turntable' | 'site' | 'flight';
  /** Refresh the text that changes (clocks, waits): called at most at 10 Hz. */
  live?: () => void;
}

/** What the deploy flow has chosen so far. */
export interface Selection {
  vehicleId: string | null;
  siteId: string | null;
  padId: string | null;
  slot: SpawnSlot;
  craftName: string;
  startView: 'chase' | 'cockpit';
  /** The ship My Ships has selected. */
  shipId: string | null;
}

export interface ScreenCtx {
  deps: ShellDeps;
  state: ShellState;
  session: ShellSession;
  practice: boolean;
  spawn: SpawnFlow;
  sel: Selection;
  send(e: ShellEvent): void;
  rebuild(): void;
  commit(request: SpawnRequest): void;
  /** Transit status words from the host (gates), null when none: read live (the host changes them every frame). */
  transitStatus(): string | null;
  /** Seconds the transit has held at its gate (0 when it is not holding), read live. */
  holdingSeconds(): number;
}

const NBSP = ' ';
const upper = (s: string): string => s.toUpperCase();
/** Seconds of holding drift after which the transit offers the way back to the menu (frontend-ux 5.11). */
export const TRANSIT_BACK_AFTER_S = 20;

// ---------------------------------------------------------------------------------------------- helpers

function row(id: string, glyph: string, main: string, sub: string | null, right: HTMLElement | string | null, onActivate: () => void, disabled = false): HTMLButtonElement {
  const r = focusable(el('button', 'sh-row'), id, onActivate);
  if (disabled) r.setAttribute('aria-disabled', 'true');
  r.append(el('span', `sh-glyph ${glyph}`), el('span', 'sh-row-main', main, sub ? el('span', 'sh-row-sub', sub) : null), right ?? el('span', ''));
  return r;
}

function right(value: string, caption: string | null = null): HTMLElement {
  return el('span', 'sh-row-right', value, caption ? el('small', '', caption) : null);
}

function panel(cls = '', blur = 0.65): HTMLDivElement {
  const p = el('div', `sh-panel ${cls}`);
  p.dataset['scrim'] = String(blur);
  return p;
}

function readout(label: string, value: string, unit = ''): HTMLElement {
  return el('div', 'sh-readout', el('span', 'sh-label', label), el('span', 'sh-num', value), unit ? el('span', 'sh-unit', unit) : null);
}

function titleBlock(title: string, subtitle: string | null): HTMLElement {
  return el('div', 'sh-titles', el('h1', 'sh-title', title), subtitle ? el('p', 'sh-subtitle', subtitle) : null);
}

const sitesOf = (ctx: ScreenCtx): LaunchSiteDef[] => Object.values(ctx.deps.defs.sites).sort((a, b) => a.name.localeCompare(b.name));
const vehiclesOf = (ctx: ScreenCtx): VehicleDef[] => Object.values(ctx.deps.defs.vehicles).sort((a, b) => a.name.localeCompare(b.name));
const rulesOf = (ctx: ScreenCtx): UniverseRules => ctx.session.stores.rules.get();
/** The live tick the pad states are stated against: the lobby's (its pads' clock), else the snapshot's (a session without a lobby list). */
const liveTickOf = (ctx: ScreenCtx): number => ctx.session.stores.presence.get().lobbies[0]?.liveTick ?? ctx.deps.snapshot()?.time.liveTick ?? 0;

/** The analysis of a vehicle under the rules in force, its pad class (derived there) and what a pad must take. */
function classOfVehicle(ctx: ScreenCtx, v: VehicleDef): { cls: PadClass; caps: VehicleCapabilities; fit: VehicleFit } {
  const rules = rulesOf(ctx);
  const caps = ctx.deps.capabilities(v.id, rules);
  return { cls: caps.padClass, caps, fit: { massWet: caps.massWet, diameter: caps.diameter, rules } };
}

// ---------------------------------------------------------------------------------------------- title

export function titleScreen(ctx: ScreenCtx): ScreenView {
  const { deps } = ctx;
  const main = el('div', 'sh-title-screen');
  main.append(el('div', 'sh-wordmark', el('span', '', 'Fable'), el('span', 'sh-wm-2', 'Space Program')));
  const progress = el('div', 'sh-progress');
  const begin = el('div', 'sh-begin');
  begin.dataset['scrim'] = '0.7';
  const beginLabel = el('div', 'sh-label');
  begin.append(beginLabel);
  const status = panel('sh-title-status', 0.5);
  status.append(el('div', 'sh-label', 'Loading'), progress);
  const capture = focusable(el('button', 'sh-prompt'), 'capture', () => deps.intent({ kind: 'capture', on: !deps.captured() }));
  const live = (): void => {
    const boot = deps.boot();
    progress.replaceChildren(
      ...boot.steps.flatMap((s) => {
        const pct = s.finished ? 100 : s.total > 0 ? Math.min(99, Math.floor((100 * s.done) / s.total)) : 0;
        const bar = el('div', 'sh-bar', el('i', ''));
        (bar.firstChild as HTMLElement).style.transform = `scaleX(${pct / 100})`;
        return [el('span', '', s.label), el('span', 'sh-num', s.finished ? 'done' : s.total > 0 ? `${pct} %` : '…'), el('div', '', bar), el('span', '')];
      }),
    );
    status.hidden = boot.playReady;
    begin.hidden = !boot.playReady;
    beginLabel.textContent = boot.playReady ? 'Press any key to begin' : '';
    capture.replaceChildren(el('span', 'sh-key', 'F'), `Fullscreen and keyboard capture: ${deps.captured() ? 'on' : 'off'}`);
  };
  live();
  main.append(status);
  return {
    main,
    aside: begin,
    prompts: [{ action: 'menu:secondary', text: 'Fullscreen', run: () => deps.intent({ kind: 'capture', on: !deps.captured() }) }],
    actions: {
      'menu:secondary': () => {
        deps.intent({ kind: 'capture', on: !deps.captured() });
        return true;
      },
    },
    focus: 'capture',
    subject: 'earth',
    live,
  };
}

// ---------------------------------------------------------------------------------------------- hub: play

function lobbyRight(l: LobbySummary, fmt: ShellDeps['format']): HTMLElement {
  switch (l.status) {
    case 'open':
      return right(`${fmt.number(l.online)} / ${fmt.number(l.softCap)}`, `${fmt.number(l.flying)} flying`);
    case 'queued':
      return right(`Queued · ${l.position !== null ? ordinal(l.position) : '—'}`, l.etaSeconds !== null ? `wait ${formatEstimate(l.etaSeconds)}` : 'wait unknown');
    case 'maintenance':
      return right('Maintenance', 'back soon');
    case 'incompatible':
      return right('New version', 'reload to join');
  }
}

export function playScreen(ctx: ScreenCtx): ScreenView {
  const { deps } = ctx;
  const main = el('div', '');
  main.append(titleBlock('Play', null));
  const ships = deps.lobby.stores.ships.get();
  const offered = new Set(presentableVehicleIds(deps.defs));
  const idle = ships.filter((s) => s.sessionState === 'idle' && offered.has(s.vehicleId));
  const lobby = deps.lobby.stores.presence.get().lobbies[0] ?? null;
  const admitted = lobby === null || lobby.status === 'open';
  const cards = el('div', 'sh-cards');
  const card = (id: string, kicker: string, title: string, text: string, run: () => void, disabled: string | null): HTMLElement => {
    const c = focusable(el('button', 'sh-card'), id, disabled ? () => undefined : run);
    c.dataset['scrim'] = '0.7';
    if (disabled) c.setAttribute('aria-disabled', 'true');
    c.append(el('span', 'sh-card-kicker', kicker), el('span', 'sh-card-title', title), el('span', 'sh-card-text', disabled ?? text));
    return c;
  };
  cards.append(
    card('launch', 'Live universe', 'Launch', 'Pick a craft and a pad. Fly.', () => launchLive(ctx), admitted ? null : 'Waiting for a place in the lobby'),
    card('resume', `${idle.length} waiting`, 'Resume', idle[0] ? `${idle[0].name} · ${idle[0].situation}` : 'No ship to resume', () => ctx.send({ type: 'tab', tab: 'ships' }), idle.length > 0 ? null : 'No ship to resume'),
    card('practice', 'Offline', 'Practice', 'Your own pads, no network. Nothing is kept.', () => startPractice(ctx), deps.practice ? null : 'Not offered on this page'),
  );
  main.append(cards);
  const lobbies = deps.lobby.stores.presence.get().lobbies;
  const list = panel('', 0.6);
  list.append(el('div', 'sh-label', 'Lobbies'));
  const rows = el('div', 'sh-list');
  if (lobbies.length === 0) rows.append(el('p', 'sh-body sh-dim', 'No lobby is listed yet.'));
  for (const l of lobbies) rows.append(row(`lobby-${l.id}`, l.status === 'open' ? 'sh-free' : 'sh-busy', l.name, `${l.region}${l.rttMs !== null ? ` · ${l.rttMs} ms` : ''} · ${l.timeModelSummary}`, lobbyRight(l, deps.format), () => ctx.send({ type: 'overlay', overlay: 'lobby' })));
  list.append(rows);
  main.append(list);
  return { main, prompts: [{ action: 'menu:activate', text: 'Select' }, { action: 'menu:back', text: 'Back' }], focus: 'launch', subject: 'earth' };
}

/** Into the live universe: on the first Play the identity screen comes first (an account needs a callsign), then the deploy flow. */
function launchLive(ctx: ScreenCtx): void {
  if (needsIdentity(ctx.deps.identity)) ctx.send({ type: 'overlay', overlay: 'identity' });
  else ctx.send({ type: 'launch' });
}

function startPractice(ctx: ScreenCtx): void {
  ctx.send({ type: 'side', side: 'practice', on: true });
  ctx.send({ type: 'launch' });
}

export function lobbyScreen(ctx: ScreenCtx): ScreenView {
  const { deps } = ctx;
  const l = deps.lobby.stores.presence.get().lobbies[0];
  const main = el('div', '');
  if (!l) {
    main.append(titleBlock('Lobby', 'No lobby is listed.'));
    return { main, prompts: [{ action: 'menu:back', text: 'Back' }], subject: 'earth' };
  }
  const rules = deps.lobby.stores.rules.get();
  main.append(titleBlock(l.name, `${l.region}${l.rttMs !== null ? ` · ${l.rttMs} ms` : ''} · rules ${l.rulesId} v${l.rulesVersion}`));
  const p = panel('', 0.6);
  const grid = el('div', 'sh-readouts');
  grid.append(readout('Status', upper(l.status)), readout('Online', `${deps.format.number(l.online)} / ${deps.format.number(l.softCap)}`), readout('Flying', deps.format.number(l.flying)), readout('Ships kept', deps.format.number(l.shipsSaved)), readout('Stations', deps.format.number(l.stations)), readout('Ships last', isNever(rules.expiry.craftRetention) ? 'for ever' : formatSpan(rules.expiry.craftRetention)));
  p.append(grid, el('p', 'sh-body sh-dim', l.timeModelSummary));
  main.append(p);
  const join = focusable(el('button', 'sh-card'), 'join', () => launchLive(ctx));
  join.dataset['scrim'] = '0.7';
  join.append(el('span', 'sh-card-title', l.status === 'open' ? 'Join and launch' : 'Waiting for a place'), el('span', 'sh-card-text', l.status === 'queued' && l.position !== null ? `You are ${ordinal(l.position)} in the admission queue · ${l.etaSeconds !== null ? formatEstimate(l.etaSeconds) : 'wait unknown'}` : 'Pick a craft and a pad.'));
  if (l.status !== 'open') join.setAttribute('aria-disabled', 'true');
  main.append(join);
  return { main, prompts: [{ action: 'menu:activate', text: 'Join' }, { action: 'menu:secondary', text: 'Full rules', run: () => ctx.send({ type: 'tab', tab: 'universe' }) }, { action: 'menu:back', text: 'Back' }], actions: { 'menu:secondary': () => (ctx.send({ type: 'tab', tab: 'universe' }), true) }, focus: 'join', subject: 'earth' };
}

// ---------------------------------------------------------------------------------------------- vehicles

/** The menu words of a vehicle (`visuals/vehicles/<id>`: presentation data, free to change), when the library has them. */
interface VehicleMenuText {
  title: string;
  tagline: string;
  description: string;
  role: string;
  difficulty: string;
}
const menuTextOf = (ctx: ScreenCtx, vehicleId: string): VehicleMenuText | null => (ctx.deps.defs.sections[`visuals/vehicles/${vehicleId}`] as VehicleMenuText | undefined) ?? null;

function vehicleDetail(ctx: ScreenCtx, v: VehicleDef): HTMLElement {
  const { deps } = ctx;
  const fmt = deps.format;
  const { cls, caps } = classOfVehicle(ctx, v);
  const text = menuTextOf(ctx, v.id);
  const p = panel('sh-strong', 0.7);
  p.dataset['testid'] = 'vehicle-detail';
  p.append(el('div', 'sh-label sh-accent', text ? `${text.role} · ${text.difficulty}` : 'Selected craft'), el('div', 'sh-detail-title', text?.title ?? v.name));
  if (text) p.append(el('p', 'sh-body', text.tagline), el('p', 'sh-body sh-dim', text.description));
  const grid = el('div', 'sh-readouts');
  grid.append(
    readout('Δv vacuum', fmt.deltaV(caps.deltaVTotal)),
    readout('TWR at the pad', caps.stages[0] ? caps.stages[0].twrSeaLevel.toFixed(2) : '—'),
    readout('Lift-off mass', fmt.mass(caps.massWet)),
    readout('Stages', fmt.number(caps.stages.length)),
    readout('Crew', caps.crewCapacity > 0 ? fmt.number(caps.crewCapacity) : 'uncrewed'),
    readout('First person', caps.firstPerson === 'cockpit' ? 'cabin' : 'sensor camera'),
  );
  p.append(grid);
  p.append(el('p', 'sh-body sh-dim', `${upper(cls)} pad class · ${fmt.mass(caps.massWet)} · ${caps.diameter.toFixed(2)} m across`));
  if (caps.reach.length > 0) {
    const ladder = el('div', 'sh-ladder');
    for (const r of caps.reach) {
      const body = deps.defs.bodies[r.bodyId]?.name ?? r.bodyId;
      ladder.append(el('span', r.margin >= 0 ? 'sh-ok' : 'sh-dim', `${r.margin >= 0 ? '✓' : '✗'} ${body} ${r.kind}${r.needsRefuel ? ' (refuelled)' : ''}`));
    }
    p.append(el('div', 'sh-label', 'Can reach (estimate)'), ladder);
  }
  return p;
}

/**
 * The fleet, the Hangar's and the deploy flow's: the vehicles that can be SHOWN (every part has a visual:
 * `presentableVehicleIds`, the lead's decision of 2026-11-24) are offered, first; the others are listed as not
 * yet available and cannot be chosen, shown on the turntable or launched.
 */
export function vehicleScreen(ctx: ScreenCtx, inDeploy: boolean): ScreenView {
  const { deps } = ctx;
  const main = el('div', '');
  main.append(titleBlock(inDeploy ? 'Choose a craft' : 'Hangar', inDeploy ? (ctx.practice ? 'Practice · offline' : null) : 'The fleet'));
  const offered = new Set(presentableVehicleIds(deps.defs));
  const all = vehiclesOf(ctx);
  const vehicles = [...all.filter((v) => offered.has(v.id)), ...all.filter((v) => !offered.has(v.id))];
  if (!ctx.sel.vehicleId || !offered.has(ctx.sel.vehicleId)) ctx.sel.vehicleId = vehicles.find((v) => offered.has(v.id))?.id ?? null;
  const list = panel('', 0.65);
  const rows = el('div', 'sh-list sh-scroll');
  for (const v of vehicles) {
    const { cls } = classOfVehicle(ctx, v);
    const shown = offered.has(v.id);
    const r = row(
      `vehicle-${v.id}`,
      v.id === ctx.sel.vehicleId ? 'sh-chevron' : '',
      menuTextOf(ctx, v.id)?.title ?? v.name,
      shown ? `${v.crew.length > 0 ? `${v.crew.length} crew` : 'uncrewed'} · ${v.stages.length} stages` : 'Not yet available · its models are still being built',
      right(upper(cls), 'pad class'),
      () => {
        if (!shown) return;
        ctx.sel.vehicleId = v.id;
        if (inDeploy) ctx.send({ type: 'step', step: 'pad' });
        else ctx.rebuild();
      },
      !shown,
    );
    if (shown)
      r.addEventListener('focus', () => {
        if (ctx.sel.vehicleId !== v.id) {
          ctx.sel.vehicleId = v.id;
          ctx.rebuild();
        }
      });
    rows.append(r);
  }
  list.append(rows);
  main.append(list);
  const v = vehicles.find((x) => x.id === ctx.sel.vehicleId);
  const turn = (t: number, z: number): (() => boolean) => () => (v ? (deps.intent({ kind: 'turntable', turn: t, zoom: z }), true) : false);
  return {
    main,
    aside: v ? vehicleDetail(ctx, v) : undefined,
    prompts: [...(v ? [{ action: 'menu:rotateLeft', text: 'Turn' }, { action: 'menu:zoomIn', text: 'Zoom' }] : []), ...(inDeploy && v ? [{ action: 'menu:activate', text: 'Choose' }] : []), { action: 'menu:back', text: 'Back' }],
    actions: { 'menu:rotateLeft': turn(-1, 0), 'menu:rotateRight': turn(1, 0), 'menu:zoomIn': turn(0, 1), 'menu:zoomOut': turn(0, -1) },
    focus: ctx.sel.vehicleId ? `vehicle-${ctx.sel.vehicleId}` : undefined,
    subject: 'turntable',
  };
}

// ---------------------------------------------------------------------------------------------- pads

function padStateWords(r: PadRow, fmt: ShellDeps['format']): { glyph: string; value: string; caption: string } {
  if (!r.state) return { glyph: '', value: 'No state', caption: 'not published' };
  switch (r.state.state) {
    case 'free':
      return { glyph: 'sh-free', value: 'Free', caption: upper(r.class) };
    case 'reserved':
      return { glyph: 'sh-busy', value: 'Reserved', caption: r.liveWaitSeconds !== null ? `free in ${fmt.duration(r.liveWaitSeconds)}` : upper(r.class) };
    case 'occupied':
      return { glyph: 'sh-busy', value: `Occupied${r.state.callsign ? ` · ${r.state.callsign}` : ''}`, caption: r.liveWaitSeconds !== null ? `free in ${fmt.duration(r.liveWaitSeconds)}` : 'no slot in the horizon' };
    case 'safing':
      return { glyph: 'sh-busy', value: 'Safing', caption: r.liveWaitSeconds !== null ? `free in ${fmt.duration(r.liveWaitSeconds)}` : upper(r.class) };
    case 'closed':
      return { glyph: 'sh-closed', value: 'Closed', caption: 'keep-out not clear' };
  }
}

/** The launch queue panel: place, the wait as an estimate, the class, the way out (and a stale mark while reconnecting). */
export function queuePanel(ctx: ScreenCtx, phase: Extract<SpawnPhase, { kind: 'queued' }>): HTMLElement {
  const p = panel('sh-queue sh-strong', 0.7);
  p.dataset['testid'] = 'launch-queue';
  const e = phase.entry;
  p.append(
    el('div', 'sh-label', `Launch queue · ${upper(e.padClass)} pads`),
    el('div', 'sh-queue-place', `${ordinal(e.position)} in line`),
    el('p', 'sh-body', `Estimated wait ${formatEstimate(e.etaSeconds)}. An estimate from the pad timetable: it can grow as well as shrink.`),
  );
  if (phase.stale) p.append(el('p', 'sh-body sh-warn', 'Reconnecting: this place may have moved. You keep it if the connection comes back in time.'));
  const leave = focusable(el('button', 'sh-prompt'), 'leave-queue', () => void ctx.spawn.leaveQueue());
  leave.append(el('span', 'sh-key', 'R'), 'Leave the queue');
  p.append(leave);
  return p;
}

function refusalPanel(ctx: ScreenCtx, phase: Extract<SpawnPhase, { kind: 'refused' }>): HTMLElement {
  const p = panel('sh-queue sh-strong', 0.7);
  p.dataset['testid'] = 'spawn-refused';
  p.append(el('div', 'sh-label', phase.cause === 'left' ? 'You left the launch queue' : phase.cause === 'lost' ? 'Place in the queue lost' : 'Launch refused'), el('p', 'sh-body', phase.reason));
  if (phase.alternative && 'site' in phase.alternative) {
    const alt = phase.alternative;
    const site = ctx.deps.defs.sites[alt.site];
    const go = focusable(el('button', 'sh-prompt'), 'take-alternative', () => {
      ctx.sel.siteId = alt.site;
      ctx.sel.padId = alt.pad;
      ctx.sel.slot = alt.slot;
      ctx.spawn.acknowledge();
      ctx.send({ type: 'step', step: 'briefing' });
    });
    go.append(el('span', 'sh-key', 'F'), `Take ${site ? site.name : alt.site} · ${alt.pad} instead`);
    p.append(go);
  }
  return p;
}

export function padScreen(ctx: ScreenCtx): ScreenView {
  const { deps } = ctx;
  const fmt = deps.format;
  const vehicle = deps.defs.vehicles[ctx.sel.vehicleId ?? ''];
  const main = el('div', '');
  main.append(titleBlock('Choose a pad', vehicle ? `${vehicle.name}${ctx.practice ? ' · Practice' : ''}` : null));
  if (!vehicle) return { main, prompts: [{ action: 'menu:back', text: 'Back' }], subject: 'site' };
  const { cls, fit } = classOfVehicle(ctx, vehicle);
  const rules = rulesOf(ctx);
  const states = ctx.session.stores.pads.get();
  const sites = sitesOf(ctx);
  const tick = liveTickOf(ctx);
  const outlook = classOutlook(sites, states, cls, tick, rules, fit);
  const perHour = launchesPerHour(outlook.padCount, deps.padCycleSeconds(rules));
  const head = panel('', 0.6);
  head.dataset['testid'] = 'class-outlook';
  const waitText = outlook.horizonFull
    ? 'No launch slot is free inside the cohort horizon for this class.'
    : outlook.liveWaitSeconds === null
      ? 'Pad states not published yet.'
      : outlook.liveWaitSeconds === 0
        ? 'A pad is free now.'
        : `Next live slot in ${fmt.duration(outlook.liveWaitSeconds)}.`;
  head.append(el('div', 'sh-label', `${upper(cls)} vehicle · ${fmt.number(outlook.padCount)} ${outlook.padCount === 1 ? 'pad' : 'pads'} can take it${perHour !== null ? ` · ${fmt.number(perHour)} launches an hour` : ''}`), el('p', 'sh-body', waitText));
  main.append(head);
  const phase = ctx.spawn.phase();
  if (phase.kind === 'queued') main.append(queuePanel(ctx, phase));
  if (phase.kind === 'refused') main.append(refusalPanel(ctx, phase));
  const list = panel('', 0.65);
  const rowsEl = el('div', 'sh-list sh-scroll');
  // The focus starts on the best pad for this vehicle: a free pad of its own class (a larger pad's slot is
  // another class's too), else any free pad that takes it, else the first that takes it.
  const firstUsable: { id: string | null; rank: number } = { id: null, rank: 3 };
  const solarNodes: { node: HTMLElement; site: LaunchSiteDef }[] = [];
  for (const site of sites) {
    const group = el('div', 'sh-group');
    group.append(el('b', '', site.name));
    const solar = el('span', '');
    group.append(solar);
    solarNodes.push({ node: solar, site });
    rowsEl.append(group);
    for (const r of padRows([site], states, cls, tick, fit)) {
      const w = padStateWords(r, fmt);
      const id = `pad-${site.id}-${r.padId}`;
      if (r.usable) {
        const free = r.state?.state === 'free';
        const rank = free && r.class === cls ? 0 : free ? 1 : 2;
        if (rank < firstUsable.rank) Object.assign(firstUsable, { id, rank });
      }
      rowsEl.append(
        row(id, w.glyph, `${r.name}`, r.usable ? `${upper(r.class)} pad` : `${upper(r.class)} pad · too small for this vehicle`, right(w.value, w.caption), () => {
          if (!r.usable) return;
          ctx.sel.siteId = site.id;
          ctx.sel.padId = r.padId;
          ctx.sel.slot = { kind: 'live' };
          ctx.send({ type: 'step', step: 'briefing' });
        }, !r.usable),
      );
    }
  }
  if (outlook.offerCohort && outlook.cohortTick !== null) {
    const lead = cohortLeadSeconds(outlook.cohortTick, tick);
    const cohortTick = outlook.cohortTick;
    rowsEl.append(
      row('slot-cohort', 'sh-free', 'Cohort slot', `Start ${formatSpan(lead)} ahead of the live clock, with the others of your bucket`, right(formatSpan(lead), 'ahead'), () => {
        const firstSite = sites.find((s) => padRows([s], states, cls, tick, fit).some((p) => p.usable));
        const pad = firstSite ? padRows([firstSite], states, cls, tick, fit).find((p) => p.usable) : undefined;
        if (!firstSite || !pad) return;
        ctx.sel.siteId = firstSite.id;
        ctx.sel.padId = pad.padId;
        ctx.sel.slot = { kind: 'cohort', tick: cohortTick };
        ctx.send({ type: 'step', step: 'briefing' });
      }),
    );
  }
  list.append(rowsEl);
  main.append(list);
  const live = (): void => {
    const s = deps.snapshot();
    for (const { node, site } of solarNodes) {
      const body = s?.bodies.find((b) => b.id === site.bodyId);
      if (!body) {
        node.textContent = '';
        continue;
      }
      const loc = padLocationOf(site);
      const v = solarViewAt(body, loc.latDeg, loc.lonDeg);
      node.textContent = ` · local ${formatSolarClock(v.localSolarHours)} · sun ${v.sunElevationDeg >= 0 ? '+' : '−'}${Math.abs(Math.round(v.sunElevationDeg))}° · ${v.phase}`;
    }
  };
  live();
  const prompts: PromptEntry[] = [{ action: 'menu:activate', text: 'Reserve' }, { action: 'menu:back', text: 'Back' }];
  if (phase.kind === 'queued') prompts.unshift({ action: 'menu:edit', text: 'Leave queue', run: () => void ctx.spawn.leaveQueue() });
  return {
    main,
    prompts,
    actions: {
      'menu:edit': () => (phase.kind === 'queued' ? (void ctx.spawn.leaveQueue(), true) : false),
      'menu:secondary': () => {
        if (phase.kind === 'refused' && phase.alternative && 'site' in phase.alternative) {
          (main.querySelector('[data-focus="take-alternative"]') as HTMLElement | null)?.click();
          return true;
        }
        return false;
      },
    },
    focus: ctx.sel.siteId && ctx.sel.padId ? `pad-${ctx.sel.siteId}-${ctx.sel.padId}` : (firstUsable.id ?? undefined),
    subject: 'site',
    live,
  };
}

// ---------------------------------------------------------------------------------------------- briefing

export function briefingScreen(ctx: ScreenCtx): ScreenView {
  const { deps, sel } = ctx;
  const vehicle = deps.defs.vehicles[sel.vehicleId ?? ''];
  const site = deps.defs.sites[sel.siteId ?? ''];
  const main = el('div', '');
  if (!vehicle || !site || !sel.padId) {
    main.append(titleBlock('Briefing', 'Choose a craft and a pad first.'));
    return { main, prompts: [{ action: 'menu:back', text: 'Back' }], subject: 'site' };
  }
  const pad = site.pads.find((p) => p.id === sel.padId)!;
  const rules = rulesOf(ctx);
  if (!sel.craftName) sel.craftName = vehicle.name.split(/[\s/]+/)[0] ?? vehicle.name;
  main.append(titleBlock('Briefing', `${vehicle.name} · ${site.name} · ${pad.name}${ctx.practice ? ' · Practice' : ''}`));
  const p = panel('', 0.65);
  const name = el('input', 'sh-field');
  name.value = sel.craftName;
  name.maxLength = 32;
  name.dataset['focus'] = 'craft-name';
  name.setAttribute('aria-label', 'Craft name');
  name.addEventListener('input', () => (sel.craftName = name.value));
  p.append(el('div', 'sh-label', 'Craft name'), name);
  if (vehicle.crew.length > 0) p.append(el('div', 'sh-label', 'Crew'), el('p', 'sh-body', vehicle.crew.map((c) => c.name).join(' · ')));
  const views = el('div', 'sh-ladder');
  for (const view of ['chase', 'cockpit'] as const) {
    const b = focusable(el('button', 'sh-tab'), `view-${view}`, () => {
      sel.startView = view;
      ctx.rebuild();
    });
    b.setAttribute('aria-selected', String(sel.startView === view));
    b.textContent = view === 'chase' ? 'Chase view' : vehicle.cockpit ? 'Cockpit' : 'Sensor camera';
    views.append(b);
  }
  p.append(el('div', 'sh-label', 'Start view'), views);
  const slotText = sel.slot.kind === 'live' ? 'Live clock, now' : sel.slot.kind === 'cohort' ? `Cohort clock, ${formatSpan(cohortLeadSeconds(sel.slot.tick, liveTickOf(ctx)))} ahead of the live clock` : 'A friend’s clock';
  p.append(el('div', 'sh-label', 'Slot'), el('p', 'sh-body', slotText));
  const ruleWords = ctx.practice
    ? 'Practice: your own pads and your own clock; nothing is kept when you leave.'
    : `The pad is held for you ${formatSpan(rules.pads.reservationHold)} · stay on it up to ${formatSpan(rules.pads.maxStay)} · ships kept ${isNever(rules.expiry.craftRetention) ? 'for ever' : formatSpan(rules.expiry.craftRetention)} after you last fly them · collisions are real`;
  p.append(el('div', 'sh-label', 'Rules that apply'), el('p', 'sh-body sh-dim', ruleWords));
  main.append(p);
  const phase = ctx.spawn.phase();
  if (phase.kind === 'queued') main.append(queuePanel(ctx, phase));
  if (phase.kind === 'refused') main.append(refusalPanel(ctx, phase));
  const launch = focusable(el('button', 'sh-card'), 'launch-commit', () => {
    if (phase.kind === 'queued' || phase.kind === 'requesting') return;
    ctx.commit({ vehicleId: vehicle.id, site: site.id, pad: pad.id, slot: sel.slot, name: sel.craftName.trim() || vehicle.name });
  });
  launch.dataset['scrim'] = '0.7';
  launch.append(el('span', 'sh-card-title', phase.kind === 'queued' ? 'Waiting for a pad' : 'Launch'), el('span', 'sh-card-text', phase.kind === 'queued' ? 'You launch as soon as your place comes up.' : `${pad.name} · ${upper(pad.class)} pad`));
  if (phase.kind === 'queued') launch.setAttribute('aria-disabled', 'true');
  launch.classList.add('sh-commit');
  const prompts: PromptEntry[] = [{ action: 'menu:activate', text: 'Launch' }, { action: 'menu:back', text: 'Back' }];
  if (phase.kind === 'queued') prompts.unshift({ action: 'menu:edit', text: 'Leave queue', run: () => void ctx.spawn.leaveQueue() });
  return { main, aside: launch, prompts, actions: { 'menu:edit': () => (phase.kind === 'queued' ? (void ctx.spawn.leaveQueue(), true) : false) }, focus: 'launch-commit', subject: 'site' };
}

// ---------------------------------------------------------------------------------------------- my ships

function where(s: ShipRecord, ctx: ScreenCtx): string {
  const body = ctx.deps.defs.bodies[s.bodyId]?.name ?? s.bodyId;
  if (s.orbit && s.situation === 'orbiting') return `Orbiting ${body} · ${ctx.deps.format.apsis(s.orbit.apoapsisAltitude)} × ${ctx.deps.format.apsis(s.orbit.periapsisAltitude)}`;
  return `${s.situation.charAt(0).toUpperCase()}${s.situation.slice(1)} · ${body}`;
}

export function shipsScreen(ctx: ScreenCtx): ScreenView {
  const { deps } = ctx;
  const ships = deps.lobby.stores.ships.get();
  const rules = deps.lobby.stores.rules.get();
  const now = deps.wallNow();
  const offered = new Set(presentableVehicleIds(deps.defs));
  const main = el('div', '');
  main.append(titleBlock('My ships', `${deps.format.number(ships.length)} of ${deps.format.number(rules.expiry.shipSlots)} slots`));
  const list = panel('', 0.6);
  const rowsEl = el('div', 'sh-list');
  if (ships.length === 0) rowsEl.append(el('p', 'sh-body sh-dim', 'No ships yet. A ship you fly is kept here.'));
  if (!ctx.sel.shipId || !ships.some((s) => s.vesselId === ctx.sel.shipId)) ctx.sel.shipId = ships[0]?.vesselId ?? null;
  for (const s of ships) {
    const left = s.expiry.atWallMs === null ? null : (s.expiry.atWallMs - now) / 1000;
    const soon = left !== null && left < 86400;
    const kept = left === null ? 'kept' : formatSpan(Math.max(0, left));
    const vehicle = deps.defs.vehicles[s.vehicleId]?.name ?? s.vehicleId;
    // A ship of a vehicle that cannot be shown yet (a part without a visual) is listed but not resumed from here.
    const shown = offered.has(s.vehicleId);
    const r = row(`ship-${s.vesselId}`, s.sessionState === 'idle' && shown ? 'sh-free' : 'sh-busy', s.name, `${vehicle} · ${where(s, ctx)}${shown ? '' : ' · its craft cannot be shown yet'}`, right(kept, soon ? 'expires soon' : 'kept for'), () => {
      if (s.sessionState !== 'idle' || !shown) return;
      ctx.sel.shipId = s.vesselId;
      deps.intent({ kind: 'resume', vesselId: s.vesselId });
      ctx.send({ type: 'resume' });
    }, s.sessionState !== 'idle' || !shown);
    if (soon) r.querySelector('.sh-row-right')?.classList.add('sh-warn');
    r.addEventListener('focus', () => {
      if (ctx.sel.shipId !== s.vesselId) {
        ctx.sel.shipId = s.vesselId;
        ctx.rebuild();
      }
    });
    rowsEl.append(r);
  }
  list.append(rowsEl);
  main.append(list);
  const sel = ships.find((s) => s.vesselId === ctx.sel.shipId);
  if (sel) {
    const d = panel('', 0.6);
    d.append(
      el('div', 'sh-label', sel.name),
      el('p', 'sh-body', `${sel.crew > 0 ? `${sel.crew} crew · ` : ''}Δv left ${deps.format.deltaV(sel.deltaVRemaining)} · ${deps.format.number(sel.nodesSaved)} maneuver nodes saved`),
      el('p', 'sh-body sh-dim', `${sel.expiry.reasonText}. ${isNever(rules.expiry.craftRetention) ? 'Ships are kept.' : `Ships are kept ${formatSpan(rules.expiry.craftRetention)} after you last fly them.`}${sel.sessionState === 'flownElsewhere' ? ' It is flown from another session now.' : ''}`),
      el('p', 'sh-body sh-dim', `Abandoning it makes it unowned: it is removed ${formatSpan(rules.expiry.unownedCraftRetention)} later.`),
    );
    main.append(d);
  }
  return {
    main,
    wide: true,
    prompts: [{ action: 'menu:activate', text: 'Resume' }, { action: 'menu:secondary', text: 'Track in map' }, { action: 'menu:edit', text: 'Rename' }, { action: 'menu:remove', text: 'Abandon' }, { action: 'menu:back', text: 'Back' }],
    actions: {
      'menu:secondary': () => (sel ? (deps.intent({ kind: 'trackShip', vesselId: sel.vesselId }), true) : false),
      'menu:edit': () => (sel ? (void deps.lobby.universe.rename(sel.craftId, sel.name), true) : false),
      'menu:remove': () => (sel ? (void deps.lobby.universe.abandon(sel.craftId), true) : false),
    },
    focus: ctx.sel.shipId ? `ship-${ctx.sel.shipId}` : undefined,
    subject: 'earth',
  };
}

// ---------------------------------------------------------------------------------------------- universe, credits, controls

export function universeScreen(ctx: ScreenCtx): ScreenView {
  const { deps } = ctx;
  const rules = deps.lobby.stores.rules.get();
  const view = rulesView(rules, deps.format, (ms) => new Date(ms).toISOString().slice(0, 10));
  const main = el('div', '');
  main.append(titleBlock('How this universe works', `${view.heading} · ${view.effective}`));
  const p = panel('', 0.7);
  p.dataset['testid'] = 'rules';
  const grid = el('div', 'sh-rules');
  for (const s of view.sections) {
    const sec = el('section', '');
    sec.dataset['section'] = s.id;
    sec.append(el('h3', '', s.title), ...s.lines.map((l) => {
      const para = el('p', '', l.text);
      if (l.field) para.dataset['field'] = l.field;
      return para;
    }));
    grid.append(sec);
  }
  p.append(grid);
  const report = deps.capacityReport();
  if (report) p.append(el('div', 'sh-label', 'Capacity (measured)'), el('p', 'sh-body', report));
  main.append(p);
  return { main, wide: true, prompts: [{ action: 'menu:prevTab', text: 'Tabs' }, { action: 'menu:back', text: 'Back' }], subject: 'earth' };
}

interface CreditEntry {
  id: string;
  category?: string;
  title: string;
  author: string;
  licence: string;
  attribution: string;
}

/** The entries of the credits section (`visuals/credits`), in file order. */
export function creditEntries(sections: Record<string, unknown>): CreditEntry[] {
  const section = sections['visuals/credits'] as { entries?: CreditEntry[] } | undefined;
  return section?.entries ?? [];
}

export function creditsScreen(ctx: ScreenCtx): ScreenView {
  const main = el('div', '');
  main.append(titleBlock('Credits', 'Data, sound and type this game is made with'));
  const p = panel('', 0.7);
  p.dataset['testid'] = 'credits';
  const cols = el('div', 'sh-credits');
  for (const c of creditEntries(ctx.deps.defs.sections)) {
    const e = el('div', 'sh-credit', el('b', '', c.title), el('span', '', c.attribution), el('i', '', `${c.category ? `${c.category} · ` : ''}${c.licence}`));
    e.dataset['credit'] = c.id;
    cols.append(e);
  }
  p.append(cols);
  main.append(p);
  return { main, wide: true, prompts: [{ action: 'menu:back', text: 'Back' }], subject: 'earth' };
}

export function controlsScreen(ctx: ScreenCtx): ScreenView {
  const { keys } = ctx.deps;
  const main = el('div', '');
  main.append(titleBlock('Controls', 'Keys work without fullscreen; none uses Ctrl, Alt or Meta'));
  const p = panel('', 0.7);
  const grid = el('div', 'sh-rules');
  const groups = new Map<string, HTMLElement>();
  for (const e of keys.flightHelp) {
    let g = groups.get(e.group);
    if (!g) {
      g = el('section', '', el('h3', '', e.group));
      groups.set(e.group, g);
      grid.append(g);
    }
    g.append(el('p', '', `${e.keys.join(' / ')} · ${e.text}`));
  }
  const menu = el('section', '', el('h3', '', 'Menu'));
  const seen = new Set<string>();
  for (const k of keys.menu) {
    if (seen.has(k.action)) continue;
    seen.add(k.action);
    const codes = keys.menu.filter((x) => x.action === k.action).map((x) => keys.label(x.code));
    menu.append(el('p', '', `${codes.join(' / ')} · ${k.action.replace('menu:', '')}`));
  }
  grid.append(menu);
  p.append(grid);
  main.append(p);
  return { main, wide: true, prompts: [{ action: 'menu:back', text: 'Back' }], subject: 'earth' };
}

export function settingsScreen(ctx: ScreenCtx, setScale: (s: number) => void, setReduced: (r: boolean) => void, scale: number, reduced: boolean): ScreenView {
  const { deps } = ctx;
  const main = el('div', '');
  main.append(titleBlock('Settings', null));
  const display = panel('', 0.6);
  const rows = el('div', 'sh-list');
  rows.append(
    row('set-capture', deps.captured() ? 'sh-free' : '', 'Fullscreen and keyboard capture', 'Opt-in: the game never takes the keyboard by itself', right(deps.captured() ? 'On' : 'Off'), () => deps.intent({ kind: 'capture', on: !deps.captured() })),
    row('set-scale', '', 'Interface scale', 'Applies to the menu', right(`${Math.round(scale * 100)} %`), () => setScale(scale >= 1.3 - 1e-9 ? 0.85 : Math.round((scale + 0.15) * 100) / 100)),
    row('set-motion', reduced ? 'sh-free' : '', 'Reduced motion', 'Fades instead of slides; the camera drift stops', right(reduced ? 'On' : 'Off'), () => setReduced(!reduced)),
  );
  display.append(el('div', 'sh-label', 'Display'), rows);
  main.append(display);
  const host = deps.settings;
  if (host) {
    const m = host.model();
    const g = panel('', 0.6);
    const gl = el('div', 'sh-list');
    gl.append(row('set-preset', '', 'Graphics preset', m.graphics.calibratedWallMs !== null ? 'Chosen by the calibration' : 'From the adapter class', right(upper(m.graphics.preset), m.graphics.predictedGpuMs !== null ? `${m.graphics.predictedGpuMs.toFixed(1)} ms` : null), () => host.runCalibration?.()));
    // The graphics rows are read-outs of the capability package's model (its own screen changes them): not focusable.
    for (const r of host.graphicsRows()) gl.append(el('div', 'sh-row sh-static', el('span', 'sh-glyph'), el('span', 'sh-row-main', r.label, el('span', 'sh-row-sub', r.detail)), right(r.value)));
    g.append(el('div', 'sh-label', 'Graphics'), gl);
    const a = panel('', 0.6);
    const al = el('div', 'sh-list');
    const vol = (label: string, value: number, set: (v: number) => void): HTMLElement => row(`set-a-${label}`, '', label, null, right(`${Math.round(value * 100)} %`), () => set(value >= 1 - 1e-9 ? 0 : Math.min(1, Math.round((value + 0.1) * 10) / 10)));
    al.append(vol('Master', m.audio.master, (v) => host.change({ audio: { master: v } })));
    for (const bus of ['music', 'ui'] as const) al.append(vol(bus === 'music' ? 'Music' : 'Interface', m.audio.buses[bus] ?? 1, (v) => host.change({ audio: { buses: { ...m.audio.buses, [bus]: v } } })));
    a.append(el('div', 'sh-label', 'Audio'), al);
    main.append(g, a);
  }
  return { main, prompts: [{ action: 'menu:activate', text: 'Change' }, { action: 'menu:back', text: 'Back' }], focus: 'set-capture', subject: 'earth' };
}

// ---------------------------------------------------------------------------------------------- transit and flight menu

export function transitScreen(ctx: ScreenCtx): ScreenView {
  const { deps, sel } = ctx;
  const site = deps.defs.sites[sel.siteId ?? ''];
  const pad = site?.pads.find((p) => p.id === sel.padId);
  const main = el('div', 'sh-transit');
  const box = el('div', 'sh-transit-box');
  const status = el('p', 'sh-body');
  box.append(el('div', 'sh-label', ctx.state.entry === 'resume' ? 'Resuming' : 'Launch'), el('div', 'sh-row-main', site && pad ? `${site.name} · ${pad.name}` : 'Your ship'), status);
  main.append(box);
  const live = (): void => {
    const phase = ctx.spawn.phase();
    const words = ctx.transitStatus() ?? (phase.kind === 'requesting' ? 'Waiting for the launch to be confirmed' : '');
    status.textContent = ctx.holdingSeconds() > TRANSIT_BACK_AFTER_S ? `${words} · still waiting for the server` : words;
  };
  live();
  const prompts: PromptEntry[] = [{ action: 'transit:skip', text: 'Skip' }];
  if (ctx.holdingSeconds() > TRANSIT_BACK_AFTER_S) prompts.push({ action: 'transit:back', text: 'Back to menu' });
  return { main, prompts, subject: 'flight', live };
}

export function flightMenuScreen(ctx: ScreenCtx, open: (what: 'controls' | 'rules' | 'settings') => void): ScreenView {
  const { deps } = ctx;
  const snap = deps.snapshot();
  const rules = rulesOf(ctx);
  const outcome = snap ? leaveOutcome(snap, rules, deps.format) : null;
  const main = el('div', '');
  main.append(titleBlock('Flight menu', ctx.practice ? 'Practice · your craft keeps flying' : 'Live · your craft keeps flying'));
  const p = panel('', 0.6);
  if (outcome) p.append(el('div', `sh-label ${outcome.tone === 'caution' ? 'sh-warn' : ''}`, outcome.status));
  const rowsEl = el('div', 'sh-list');
  rowsEl.append(
    row('fm-resume', 'sh-chevron', 'Resume', null, null, () => ctx.send({ type: 'closeFlightMenu' })),
    row('fm-settings', '', 'Settings', null, null, () => open('settings')),
    row('fm-controls', '', 'Controls', null, null, () => open('controls')),
    row('fm-rules', '', 'Universe rules', null, null, () => open('rules')),
    row('fm-leave', '', 'Leave flight', null, null, () => {
      deps.intent({ kind: 'leave' });
      ctx.send({ type: 'leave' });
    }),
  );
  p.append(rowsEl);
  main.append(p);
  if (outcome) {
    const l = panel('', 0.6);
    l.dataset['testid'] = 'leave-outcome';
    l.append(el('div', 'sh-label', 'If you leave now'), ...outcome.lines.map((t) => el('p', 'sh-body', t)));
    main.append(l);
  }
  return { main, prompts: [{ action: 'menu:activate', text: 'Select' }, { action: 'menu:back', text: 'Resume' }], focus: 'fm-resume', subject: 'flight' };
}

/** Tab words of the hub's top bar. */
export const TAB_WORDS: Record<HubTab, string> = { play: 'Play', hangar: 'Hangar', ships: 'My ships', universe: 'Universe', settings: 'Settings', credits: 'Credits' };
