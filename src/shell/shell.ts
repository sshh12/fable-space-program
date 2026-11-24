/**
 * The shell (ARCHITECTURE 23): the state machine, the screens, the menu's keys, spatial focus, the history trap
 * and the panels' scrim, over the live canvas.
 *
 *   const shell = createShell(deps);            // the title appears at once and reports the boot progress
 *   every frame:  shell.update(realDt);         // text at most at 10 Hz; scrim rectangles while panels move
 *   host -> shell: transitStatus(text), handOver(), left(), openFlightMenu(), gatePassed(), booted()
 *   shell -> host: deps.intent(...)             // framing, the input context, the transit, leave, capture
 *
 * Keys. In the menu and transit contexts the shell reads `keydown` through the context tables it was given
 * (src/input/contexts.ts): Control, Alt or Meta chords are never the game's. In flight the keys are the flight
 * table's; the host calls `openFlightMenu()` on its `flightMenu` action. The browser's Back and the mouse's back
 * button are menu-back (a history entry is kept from the first key or pointer press, so Back does not leave the page).
 *
 * A closed menu costs nothing and moves no pixel: in flight the root is hidden, no element is over the canvas,
 * and the scrim rectangles are published empty once.
 */
import type { SpawnRequest } from '@/core/contracts/session';
import { activate, el, focusable, installShellStyles, nextInDirection, scrimRectsOf, type Direction, type ScrimRect } from './dom/kit';
import { createShellMachine, HUB_TABS, stateName, type ShellEvent, type ShellMachine, type ShellState } from './machine';
import * as S from './screens';
import { createSpawnFlow, type SpawnFlow } from './spawnFlow';
import type { ShellDeps, ShellSession } from './types';

/** The HUD's text refresh rate: live text on the menu changes at most this often (frontend-ux 4.11). */
const TEXT_HZ = 10;
/** Seconds after a screen change during which the scrim follows the panels every frame (the enter animation). */
const SCRIM_FOLLOW_S = 0.6;

export interface Shell {
  readonly machine: ShellMachine;
  readonly spawn: SpawnFlow;
  /** Run a menu or transit action as its key would (tests, on-screen prompts). True when something handled it. */
  action(action: string): boolean;
  update(realDt: number): void;
  booted(): void;
  gatePassed(): void;
  /** Words of the transit's status line (gates and holding drift), null to clear; `holding` = the camera is in its holding drift. */
  transitStatus(text: string | null, holding: boolean): void;
  /** The transit has handed over to the flight rig: control is enabled. */
  handOver(): void;
  /** The reverse transit is back at the menu. */
  left(): void;
  openFlightMenu(): void;
  /** The element id that has the focus (test hook). */
  focused(): string | null;
  /** State, focus, the scrim rectangles last published (test hook: window.__shell). */
  hooks(): { state: string; main: string; side: readonly string[]; focus: string | null; scrimRects: number; spawn: string; practice: boolean; textRefreshes: number; screenChanges: number };
  dispose(): void;
}

export function createShell(deps: ShellDeps): Shell {
  installShellStyles();
  const machine = createShellMachine();
  let uiScale = deps.uiScale ?? 1;
  let reduced = deps.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const root = el('div', 'sh-root');
  root.dataset['shell'] = '';
  const applyLook = (): void => {
    root.style.setProperty('--sh-scale', String(uiScale));
    root.dataset['motion'] = reduced ? 'reduced' : 'full';
  };
  applyLook();
  const safe = el('div', 'sh-safe');
  const top = el('div', 'sh-top');
  const mainCol = el('div', 'sh-main');
  const aside = el('div', 'sh-aside');
  const status = el('div', 'sh-status');
  const prompts = el('div', 'sh-prompts');
  const banner = el('div', 'sh-banner');
  safe.append(top, mainCol, aside, status, prompts);
  root.append(el('div', 'sh-vignette'), safe, banner, el('div', 'sh-small-window', 'Make the window larger to play'));
  deps.root.append(root);

  const practiceOn = (): boolean => machine.state().side.includes('practice');
  const session = (): ShellSession => (practiceOn() && deps.practice ? deps.practice : deps.lobby);
  let spawn = createSpawnFlow(session().universe, session().stores);
  let spawnSession = session();
  const sel: S.Selection = { vehicleId: null, siteId: null, padId: null, slot: { kind: 'live' }, craftName: '', startView: 'chase', shipId: null };
  let transitText: string | null = null;
  let holding = 0;
  let isHolding = false;
  let view: S.ScreenView | null = null;
  let focusId: string | null = null;
  const focusMemory = new Map<string, string>();
  let dirty = true;
  let textClock = 0;
  /** Test hooks: text refreshes on the text clock (rebuilds and live text), and screen changes (drawn at once). */
  let textRefreshes = 0;
  let screenChanges = 0;
  let scrimFollow = 0;
  let lastScrim = '';
  let lastScrimCount = 0;
  let overlayPanel: 'controls' | 'rules' | 'settings' | null = null;

  // A change of screen is drawn at once (the next key acts on what the player sees: a key pressed in the frame
  // after a change must not reach the screen before it); store changes and live text wait for the text clock.
  let shown = '';
  const send = (e: ShellEvent): void => {
    if (!machine.send(e)) return;
    dirty = true;
    if (stateName(machine.state()) !== shown) render();
  };

  const ensureSpawnSession = (): void => {
    const s = session();
    if (s === spawnSession) return;
    spawn.dispose();
    spawnSession = s;
    spawn = createSpawnFlow(s.universe, s.stores);
    watchSpawn();
  };

  const commit = (request: SpawnRequest): void => {
    ensureSpawnSession();
    send({ type: 'commit' });
    deps.intent({ kind: 'transit', request, practice: practiceOn() });
    void spawn.spawn(request);
  };

  let offSpawn = (): void => undefined;
  const watchSpawn = (): void => {
    offSpawn();
    offSpawn = spawn.subscribe((p) => {
      const st = machine.state();
      if (p.kind === 'queued' && st.main === 'transit') {
        deps.intent({ kind: 'riseBack', reason: null });
        send({ type: 'waitForPad' });
      } else if (p.kind === 'seated') {
        if (st.main === 'deploy') {
          deps.intent({ kind: 'transit', request: p.request, practice: practiceOn() });
          send({ type: 'depart' });
        }
        deps.intent({ kind: 'spawnAcknowledged', vesselId: p.vesselId });
      } else if (p.kind === 'refused' && st.main === 'transit') {
        deps.intent({ kind: 'riseBack', reason: p.reason });
        send({ type: 'spawnFailed' });
      }
      dirty = true;
    });
  };
  watchSpawn();

  // Store changes rebuild the screen (at most at the text rate); the live text refreshes on its own clock.
  const storeOffs: (() => void)[] = [];
  const watchStores = (s: ShellSession): void => {
    for (const store of [s.stores.pads, s.stores.ships, s.stores.presence, s.stores.rules, s.stores.link, s.stores.launchQueue, s.stores.feed]) storeOffs.push(store.subscribe(() => (dirty = true)));
  };
  watchStores(deps.lobby);
  if (deps.practice) watchStores(deps.practice);

  const ctx = (): S.ScreenCtx => ({
    deps,
    state: machine.state(),
    session: session(),
    practice: practiceOn(),
    spawn,
    sel,
    send,
    rebuild: () => (dirty = true),
    commit,
    transitStatus: transitText,
    holdingSeconds: holding,
  });

  const screenFor = (st: ShellState): S.ScreenView | null => {
    const c = ctx();
    switch (st.main) {
      case 'boot':
      case 'gate':
      case 'title':
        return S.titleScreen(c);
      case 'hub':
        if (st.overlay === 'controls') return S.controlsScreen(c);
        if (st.overlay === 'lobby') return S.lobbyScreen(c);
        switch (st.tab) {
          case 'play':
            return S.playScreen(c);
          case 'hangar':
            return S.vehicleScreen(c, false);
          case 'ships':
            return S.shipsScreen(c);
          case 'universe':
            return S.universeScreen(c);
          case 'settings':
            return settings(c);
          case 'credits':
            return S.creditsScreen(c);
        }
        break;
      case 'deploy':
        return st.step === 'vehicle' ? S.vehicleScreen(c, true) : st.step === 'pad' ? S.padScreen(c) : S.briefingScreen(c);
      case 'transit':
        return S.transitScreen(c);
      case 'flightMenu':
        if (overlayPanel === 'controls') return S.controlsScreen(c);
        if (overlayPanel === 'rules') return S.universeScreen(c);
        if (overlayPanel === 'settings') return settings(c);
        return S.flightMenuScreen(c, (what) => {
          overlayPanel = what;
          dirty = true;
        });
      case 'flight':
      case 'leaving':
        return null;
    }
    return null;
  };

  const settings = (c: S.ScreenCtx): S.ScreenView =>
    S.settingsScreen(
      c,
      (s) => {
        uiScale = s;
        applyLook();
        dirty = true;
      },
      (r) => {
        reduced = r;
        applyLook();
        dirty = true;
      },
      uiScale,
      reduced,
    );

  const keyOf = (table: 'menu' | 'transit', action: string): string | null => deps.keys[table].find((k) => k.action === action)?.code ?? null;

  const renderTop = (st: ShellState): void => {
    top.replaceChildren();
    if (st.main !== 'hub' && st.main !== 'deploy') return;
    const tabs = el('div', 'sh-tabs');
    tabs.setAttribute('role', 'tablist');
    const q = keyOf('menu', 'menu:prevTab');
    const e = keyOf('menu', 'menu:nextTab');
    if (q) tabs.append(el('span', 'sh-key', deps.keys.label(q)));
    for (const tab of HUB_TABS) {
      const b = focusable(el('button', 'sh-tab', S.TAB_WORDS[tab]), `tab-${tab}`, () => send({ type: 'tab', tab }));
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(st.main === 'hub' && st.tab === tab));
      if (st.main === 'deploy') b.setAttribute('aria-disabled', 'true');
      tabs.append(b);
    }
    if (e) tabs.append(el('span', 'sh-key', deps.keys.label(e)));
    const right = el('div', 'sh-top-right');
    right.dataset['live'] = 'top';
    top.append(tabs, right);
  };

  const liveTop = (): void => {
    const right = top.querySelector<HTMLElement>('[data-live="top"]');
    if (!right) return;
    const s = session().stores;
    const link = s.link.get();
    const sum = s.presence.get().summary;
    const dot = link.state === 'online' || link.state === 'local' ? '' : link.state === 'reconnecting' || link.state === 'queued' || link.state === 'connecting' ? 'sh-warn-bg' : 'sh-alert-bg';
    const callsign = deps.identity?.callsign();
    right.replaceChildren(
      ...(callsign ? [el('b', '', callsign)] : []),
      el('span', '', el('i', `sh-dot ${dot}`), practiceOn() ? 'Practice · offline' : link.rttMs !== null ? `Link ${link.rttMs} ms` : link.state),
      ...(practiceOn() ? [] : [el('span', '', el('b', 'sh-num', deps.format.number(sum.online)), ' online')]),
    );
  };

  const renderPrompts = (v: S.ScreenView, st: ShellState): void => {
    const table = st.main === 'transit' ? 'transit' : 'menu';
    const plate = el('div', 'sh-prompts-plate');
    plate.dataset['scrim'] = '0.4';
    for (const p of v.prompts.slice(0, 5)) {
      const code = keyOf(table, p.action);
      if (!code) continue;
      const b = el('button', 'sh-prompt', el('span', 'sh-key', deps.keys.label(code)), p.text);
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (p.run) p.run();
        else runAction(p.action);
      });
      plate.append(b);
    }
    prompts.replaceChildren(plate);
  };

  const renderStatus = (st: ShellState): void => {
    if (st.main === 'title' || st.main === 'boot' || st.main === 'gate') {
      const feed = deps.lobby.stores.feed.get();
      const item = feed.length > 0 ? feed[Math.floor(Date.now() / 6000) % feed.length]! : null;
      status.replaceChildren(item ? el('span', 'sh-ticker', item.text) : '');
      return;
    }
    const lobby = deps.lobby.stores.presence.get().lobbies[0];
    status.replaceChildren(practiceOn() ? 'Practice · offline · local rules' : lobby ? `${lobby.name} · rules ${lobby.rulesId} v${lobby.rulesVersion}` : '');
  };

  const renderBanner = (): void => {
    const link = deps.lobby.stores.link.get();
    const lobby = deps.lobby.stores.presence.get().lobbies[0];
    const st = machine.state();
    banner.replaceChildren();
    if (practiceOn()) return;
    const card = (label: string, text: string, ...actions: HTMLElement[]): void => {
      const p = el('div', 'sh-panel sh-strong');
      p.dataset['scrim'] = '0.7';
      p.dataset['testid'] = 'link-banner';
      p.append(el('div', 'sh-label', label), el('p', 'sh-body', text), ...actions);
      banner.append(p);
    };
    const practiceButton = (): HTMLElement => {
      const b = focusable(el('button', 'sh-prompt'), 'banner-practice', () => {
        send({ type: 'side', side: 'practice', on: true });
        if (machine.state().main === 'hub') send({ type: 'launch' });
      });
      b.append(el('span', 'sh-key', '↵'), 'Practice offline');
      return b;
    };
    const inMenu = st.main === 'hub' || st.main === 'deploy' || st.main === 'title';
    switch (link.state) {
      case 'reconnecting':
        card('Connection lost · reconnecting', `${link.reason ?? 'The server is not answering.'}${link.graceRemaining !== null ? ` Your session is held for ${Math.ceil(link.graceRemaining)} s.` : ''}`, ...(inMenu && deps.practice ? [practiceButton()] : []));
        break;
      case 'offline':
        card('The universe is unreachable', link.reason ?? 'The server cannot be reached.', ...(inMenu && deps.practice ? [practiceButton()] : []));
        break;
      case 'takenOver':
        card('Flown from another session', 'This account is now flown from another tab or device. A launch request waiting here has lost its place.');
        break;
      case 'maintenance':
        card('Maintenance', link.reason ?? 'The universe is down for maintenance; your ships are saved.');
        break;
      case 'incompatible':
        card('A new version is ready', 'Reload the page to join the universe.');
        break;
      default:
        break;
    }
    if (link.state === 'queued' || lobby?.status === 'queued') {
      const pos = link.queuePosition ?? lobby?.position ?? null;
      const eta = link.queueEtaSeconds ?? lobby?.etaSeconds ?? null;
      card('Queued for the lobby', `The lobby is full. You are ${pos !== null ? `${pos.toLocaleString('en-US')}${pos === 1 ? 'st' : ''} in line` : 'in line'}${eta !== null ? `, about ${Math.max(1, Math.round(eta / 60))} min` : ''} (an estimate). Browse the Hangar and Settings meanwhile.`);
    }
  };

  const freeArea = (): { x0: number; y0: number; x1: number; y1: number } => {
    const r = safe.getBoundingClientRect();
    const cols = mainCol.getBoundingClientRect();
    return { x0: Math.max(cols.right, r.left + (r.width * 5) / 12), y0: r.top, x1: r.right, y1: r.bottom };
  };

  const render = (): void => {
    dirty = false;
    textClock = 0;
    const st = machine.state();
    const name = stateName(st);
    shown = name;
    ensureSpawnSession();
    if (focusId) focusMemory.set(lastName, focusId);
    const v = screenFor(st);
    view = v;
    const changed = name !== lastName;
    if (changed) screenChanges++;
    root.hidden = v === null;
    deps.intent({ kind: 'context', context: st.main === 'flight' || st.main === 'leaving' ? 'flight' : st.main === 'transit' ? 'transit' : 'menu' });
    if (!v) {
      mainCol.replaceChildren();
      aside.replaceChildren();
      prompts.replaceChildren();
      banner.replaceChildren();
      lastName = name;
      publishScrim(true);
      return;
    }
    renderTop(st);
    mainCol.className = `sh-main${v.wide ? ' sh-wide' : ''}`;
    const screen = el('div', `sh-screen`);
    screen.append(v.main);
    if (changed) v.main.classList.add('sh-enter');
    mainCol.replaceChildren(screen);
    aside.replaceChildren(...(v.aside ? [v.aside] : []));
    renderPrompts(v, st);
    renderStatus(st);
    renderBanner();
    liveTop();
    v.live?.();
    const remembered = changed ? focusMemory.get(name) : focusId;
    setFocus(remembered && root.querySelector(`[data-focus="${remembered}"]`) ? remembered : (v.focus ?? firstFocusable()));
    if (changed) {
      scrimFollow = SCRIM_FOLLOW_S;
      deps.intent({ kind: 'frame', screen: name, subject: v.subject, vehicleId: sel.vehicleId, siteId: sel.siteId, free: freeArea() });
    }
    lastName = name;
    publishScrim(false);
  };
  let lastName = '';

  const firstFocusable = (): string | null => root.querySelector<HTMLElement>('.sh-main [data-focus], .sh-banner [data-focus]')?.dataset['focus'] ?? null;

  const setFocus = (id: string | null): void => {
    for (const e of Array.from(root.querySelectorAll('.is-focus'))) e.classList.remove('is-focus');
    focusId = id;
    if (!id) return;
    const e = root.querySelector<HTMLElement>(`[data-focus="${id}"]`);
    if (!e) return;
    e.classList.add('is-focus');
    if (document.activeElement !== e) e.focus({ preventScroll: true });
  };

  const focusables = (): { id: string; rect: DOMRect }[] =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-focus]'))
      .filter((e) => e.getAttribute('aria-disabled') !== 'true' && e.offsetParent !== null)
      .map((e) => ({ id: e.dataset['focus']!, rect: e.getBoundingClientRect() }));

  const move = (dir: Direction): boolean => {
    const all = focusables();
    const cur = all.find((c) => c.id === focusId);
    if (!cur) {
      setFocus(all[0]?.id ?? null);
      return true;
    }
    const next = nextInDirection(cur.rect, all.filter((c) => c.id !== cur.id), dir);
    if (next) setFocus(next);
    return true;
  };

  const runAction = (action: string): boolean => {
    const st = machine.state();
    if (st.main === 'transit') {
      if (action === 'transit:skip') {
        deps.intent({ kind: 'riseBack', reason: 'skip' });
        return true;
      }
      if (action === 'transit:back' && holding > 20) {
        void spawn.leaveQueue();
        deps.intent({ kind: 'riseBack', reason: 'The player went back while the server had not answered.' });
        send({ type: 'spawnFailed' });
        return true;
      }
      return false;
    }
    if (st.main === 'title' || st.main === 'gate' || st.main === 'boot') {
      if (action === 'menu:secondary') return view?.actions?.['menu:secondary']?.() ?? false;
      if (st.main === 'title' && deps.boot().playReady) {
        send({ type: 'begin' });
        return true;
      }
      return false;
    }
    const custom = view?.actions?.[action];
    if (custom && custom()) return true;
    switch (action) {
      case 'menu:up':
        return move('up');
      case 'menu:down':
        return move('down');
      case 'menu:left':
        return move('left');
      case 'menu:right':
        return move('right');
      case 'menu:activate': {
        const e = focusId ? root.querySelector<HTMLElement>(`[data-focus="${focusId}"]`) : null;
        if (!e || e.getAttribute('aria-disabled') === 'true') return false;
        activate(e);
        return true;
      }
      case 'menu:back':
        if (st.main === 'flightMenu' && overlayPanel !== null) {
          overlayPanel = null;
          dirty = true;
          return true;
        }
        if (st.main === 'hub' && st.tab === 'play' && st.overlay === null && practiceOn()) {
          send({ type: 'side', side: 'practice', on: false });
          return true;
        }
        if (st.main === 'deploy' && st.step === 'vehicle' && practiceOn()) send({ type: 'side', side: 'practice', on: false });
        if (st.main === 'deploy' && st.step === 'pad') spawn.acknowledge();
        send({ type: 'back' });
        return true;
      case 'menu:prevTab':
      case 'menu:nextTab': {
        if (st.main !== 'hub') return false;
        const i = HUB_TABS.indexOf(st.tab);
        const n = HUB_TABS.length;
        send({ type: 'tab', tab: HUB_TABS[(i + (action === 'menu:nextTab' ? 1 : n - 1)) % n]! });
        return true;
      }
      default:
        return false;
    }
  };

  // ------------------------------------------------------------------------------------------ DOM events
  const onKeyDown = (e: KeyboardEvent): void => {
    const st = machine.state();
    if (st.main === 'flight' || st.main === 'leaving') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // A key acts on the screen as it stands: a rebuild the text clock has not drawn yet is drawn first.
    if (dirty) render();
    const editing = e.target instanceof HTMLInputElement;
    const table = st.main === 'transit' ? deps.keys.transit : deps.keys.menu;
    if (st.main === 'title' && !e.repeat && deps.boot().playReady && e.code !== keyOf('menu', 'menu:secondary')) {
      e.preventDefault();
      send({ type: 'begin' });
      return;
    }
    const action = table.find((k) => k.code === e.code)?.action ?? null;
    if (!action) return;
    // In a text field only the keys that leave it act: Enter (activate the screen's default), Esc and the arrows up/down.
    if (editing && !['menu:activate', 'menu:back', 'menu:up', 'menu:down'].includes(action)) return;
    if (editing && action === 'menu:back' && e.code !== 'Escape') return;
    if (e.repeat && action !== 'menu:up' && action !== 'menu:down' && action !== 'menu:left' && action !== 'menu:right') {
      e.preventDefault();
      return;
    }
    if (editing && action === 'menu:activate') {
      e.preventDefault();
      setFocus(view?.focus ?? focusId);
      runAction('menu:activate');
      return;
    }
    if (runAction(action)) e.preventDefault();
  };
  const onPointerOver = (e: PointerEvent): void => {
    const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-focus]');
    if (t && root.contains(t) && t.dataset['focus'] !== focusId && t.getAttribute('aria-disabled') !== 'true') setFocus(t.dataset['focus']!);
  };
  const onRootClick = (e: MouseEvent): void => {
    const st = machine.state();
    if (st.main === 'title' && deps.boot().playReady && !(e.target as HTMLElement).closest('[data-focus]')) send({ type: 'begin' });
  };
  const onDocClick = (e: MouseEvent): void => {
    // A click on the scene (not on a panel) begins from the title too.
    if (machine.state().main === 'title' && deps.boot().playReady && !root.contains(e.target as Node)) send({ type: 'begin' });
  };
  // History trap: one entry is kept above the page's; Back (and the mouse's back button) is menu-back.
  // Chrome skips, on Back, a history entry that was pushed without a user gesture (its history intervention), so
  // the trap's entry is pushed (and re-pushed after each Back) on the next key press or pointer press.
  let trapArmed = false;
  const armTrap = (): void => {
    if (trapArmed) return;
    trapArmed = true;
    history.pushState({ shell: true }, '');
  };
  const onPopState = (): void => {
    trapArmed = false;
    const st = machine.state();
    if (st.main === 'flight') send({ type: 'openFlightMenu' });
    else runAction('menu:back');
  };
  const onMouseUp = (e: MouseEvent): void => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      if (e.button === 3) onPopState();
    }
  };
  window.addEventListener('keydown', armTrap, { capture: true });
  window.addEventListener('pointerdown', armTrap, { capture: true });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('popstate', onPopState);
  window.addEventListener('mouseup', onMouseUp);
  document.addEventListener('click', onDocClick);
  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('click', onRootClick);

  const canvasRect = (): DOMRect => deps.canvas.getBoundingClientRect();
  const publishScrim = (closed: boolean): void => {
    const rects: ScrimRect[] = closed ? [] : scrimRectsOf(root, canvasRect(), window.devicePixelRatio || 1, 1);
    const key = rects.map((r) => `${Math.round(r.x0)},${Math.round(r.y0)},${Math.round(r.x1)},${Math.round(r.y1)}`).join(';');
    if (key === lastScrim) return;
    lastScrim = key;
    lastScrimCount = rects.length;
    deps.publishScrim(rects);
  };
  const onResize = (): void => {
    dirty = true;
  };
  window.addEventListener('resize', onResize);

  return {
    machine,
    get spawn() {
      return spawn;
    },
    action: runAction,
    update(realDt) {
      if (isHolding) holding += realDt;
      textClock += realDt;
      if (dirty && textClock >= 1 / TEXT_HZ) {
        textClock = 0;
        textRefreshes++;
        render();
        return;
      }
      if (textClock >= 1 / TEXT_HZ && view) {
        textClock = 0;
        textRefreshes++;
        view.live?.();
        liveTop();
        renderStatus(machine.state());
      }
      if (scrimFollow > 0 && view) {
        scrimFollow -= realDt;
        publishScrim(false);
      }
    },
    booted: () => send({ type: 'booted' }),
    gatePassed: () => send({ type: 'gatePassed' }),
    transitStatus(text, h) {
      transitText = text;
      isHolding = h;
      if (!h) holding = 0;
    },
    handOver() {
      transitText = null;
      isHolding = false;
      holding = 0;
      spawn.acknowledge();
      send({ type: 'seated' });
      render();
    },
    left() {
      overlayPanel = null;
      send({ type: 'left' });
      render();
    },
    openFlightMenu() {
      overlayPanel = null;
      send({ type: 'openFlightMenu' });
      render();
    },
    focused: () => focusId,
    hooks: () => {
      const st = machine.state();
      return { state: stateName(st), main: st.main, side: st.side, focus: focusId, scrimRects: lastScrimCount, spawn: spawn.phase().kind, practice: practiceOn(), textRefreshes, screenChanges };
    },
    dispose() {
      window.removeEventListener('keydown', armTrap, { capture: true });
      window.removeEventListener('pointerdown', armTrap, { capture: true });
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('click', onDocClick);
      offSpawn();
      spawn.dispose();
      for (const off of storeOffs) off();
      deps.publishScrim([]);
      root.remove();
    },
  };
}
