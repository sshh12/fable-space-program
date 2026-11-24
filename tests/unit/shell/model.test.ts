/**
 * The shell's pure models: the state machine (every state reachable, back from every screen), pads and waits
 * per class (counts from the site files, rates from the rules), the rules screen (default and staging render
 * different numbers with no code change), the solar view, the leave line and the leave guard.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, LaunchSiteDef, PadDef } from '@/core/contracts/defs';
import { DEFAULT_UNIVERSE_RULES, TICKS_PER_SECOND, type PadState } from '@/core/contracts/net';
import { quat } from '@/core/math/quat';
import { createShellMachine, DEPLOY_STEPS, HUB_TABS, INITIAL_SHELL_STATE, MAIN_STATES, stateName, transition, type ShellState } from '@/shell/machine';
import { classOutlook, launchesPerHour, padHosts, padRows, usableClasses } from '@/shell/pads';
import { formatSpan, rulesView } from '@/shell/rulesView';
import { solarViewAt } from '@/shell/solar';
import { formatNumber } from '@/ui/format';
import { loadLibrary } from '../../../tools/sim/realWorld';

const fmt = { number: formatNumber };

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

const go = (events: Parameters<typeof transition>[1][]): ShellState => {
  const m = createShellMachine();
  for (const e of events) expect(m.send(e), JSON.stringify(e)).toBe(true);
  return m.state();
};

describe('the state machine', () => {
  it('walks the whole deploy flow: boot, gate, title, hub, deploy (three steps), transit, flight, flight menu, leaving, hub', () => {
    const m = createShellMachine();
    const seq = [
      { type: 'booted' },
      { type: 'gatePassed' },
      { type: 'begin' },
      { type: 'launch' },
      { type: 'step', step: 'pad' },
      { type: 'step', step: 'briefing' },
      { type: 'commit' },
      { type: 'seated' },
      { type: 'openFlightMenu' },
      { type: 'leave' },
      { type: 'left' },
    ] as const;
    for (const e of seq) expect(m.send(e), e.type).toBe(true);
    expect(m.visited()).toEqual(['boot', 'gate', 'title', 'hub/play', 'deploy/vehicle', 'deploy/pad', 'deploy/briefing', 'transit', 'flight', 'flightMenu', 'leaving', 'hub/play']);
    const mains = new Set(m.visited().map((n) => n.split('/')[0]));
    for (const s of MAIN_STATES) expect(mains.has(s), s).toBe(true);
  });

  it('back from every screen goes one level up, and never leaves a flight', () => {
    const hub = go([{ type: 'booted' }, { type: 'gatePassed' }, { type: 'begin' }]);
    for (const tab of HUB_TABS.filter((t) => t !== 'play')) {
      const at = transition(hub, { type: 'tab', tab })!;
      expect(stateName(transition(at, { type: 'back' })!)).toBe('hub/play');
    }
    expect(stateName(transition(hub, { type: 'back' })!)).toBe('title');
    let deploy = transition(hub, { type: 'launch' })!;
    deploy = transition(deploy, { type: 'step', step: 'briefing' })!;
    const names: string[] = [];
    for (let s: ShellState | null = deploy; s; s = transition(s, { type: 'back' })) names.push(stateName(s));
    expect(names.slice(0, DEPLOY_STEPS.length + 2)).toEqual(['deploy/briefing', 'deploy/pad', 'deploy/vehicle', 'hub/play', 'title']);
    const flight = go([{ type: 'booted' }, { type: 'gatePassed' }, { type: 'begin' }, { type: 'launch' }, { type: 'step', step: 'briefing' }, { type: 'commit' }, { type: 'seated' }]);
    expect(stateName(transition(flight, { type: 'back' })!)).toBe('flightMenu');
    expect(stateName(transition(transition(flight, { type: 'back' })!, { type: 'back' })!)).toBe('flight');
  });

  it('side states overlay the main state; practice ends with the flight; a block takes no other event', () => {
    let s = go([{ type: 'booted' }, { type: 'gatePassed' }, { type: 'begin' }, { type: 'side', side: 'practice', on: true }, { type: 'side', side: 'reconnecting', on: true }]);
    expect(s.main).toBe('hub');
    expect(s.side).toEqual(['reconnecting', 'practice']);
    s = transition(s, { type: 'side', side: 'reconnecting', on: false })!;
    s = go([{ type: 'booted' }, { type: 'gatePassed' }, { type: 'begin' }, { type: 'side', side: 'practice', on: true }, { type: 'launch' }, { type: 'step', step: 'briefing' }, { type: 'commit' }, { type: 'seated' }, { type: 'openFlightMenu' }, { type: 'leave' }, { type: 'left' }]);
    expect(s.side).toEqual([]);
    const blocked = transition(INITIAL_SHELL_STATE, { type: 'side', side: 'blocked', on: true })!;
    expect(transition(blocked, { type: 'booted' })).toBeNull();
  });

  it('a refused launch rises back to the pad screen, a refused resume to My Ships', () => {
    const launch = go([{ type: 'booted' }, { type: 'gatePassed' }, { type: 'begin' }, { type: 'launch' }, { type: 'step', step: 'briefing' }, { type: 'commit' }]);
    expect(stateName(transition(launch, { type: 'spawnFailed' })!)).toBe('deploy/pad');
    const resume = go([{ type: 'booted' }, { type: 'gatePassed' }, { type: 'begin' }, { type: 'resume' }]);
    expect(stateName(transition(resume, { type: 'spawnFailed' })!)).toBe('hub/ships');
  });
});

// A complex of synthetic pads (counts and classes are the test's, not the release complex's): what the
// functions do with one pad, with eight and with twenty-five.
const pad = (id: string, cls: PadDef['class']): PadDef => ({ id, name: id.toUpperCase(), offsetEnu: [0, 0], azimuthDeg: 90, class: cls, flatRadius: 100, blendRadius: 200, mountHeight: 10, structures: [] });
const site = (id: string, pads: PadDef[]): LaunchSiteDef => ({ id, name: id, bodyId: 'earth', location: { latDeg: 19, lonDeg: -155, padElevation: 'terrain' }, pads, recoveryZones: [] });
const state = (s: LaunchSiteDef, p: PadDef, taken: boolean, freeInS: number | null, live = 0): PadState => ({
  siteId: s.id,
  padId: p.id,
  class: p.class,
  state: taken ? 'occupied' : 'free',
  accountId: null,
  callsign: null,
  vesselId: null,
  freeAtTick: taken && freeInS !== null ? live + freeInS * TICKS_PER_SECOND : null,
  nextLiveTick: freeInS === null ? null : live + freeInS * TICKS_PER_SECOND,
  nextCohortTick: null,
});

describe('pads and waits per class', () => {
  it('a pad hosts its class and anything smaller', () => {
    expect(padHosts('heavy', 'light')).toBe(true);
    expect(padHosts('light', 'heavy')).toBe(false);
    expect(usableClasses('medium')).toEqual(['medium', 'heavy']);
  });

  for (const n of [1, 8, 25]) {
    it(`counts the pads each class may use from the site files (${n} pads)`, () => {
      const classes: PadDef['class'][] = ['light', 'medium', 'heavy'];
      const pads = Array.from({ length: n }, (_, i) => pad(`p${i}`, classes[i % 3]!));
      const a = site('a', pads.slice(0, Math.ceil(n / 2)));
      const b = site('b', pads.slice(Math.ceil(n / 2)));
      const states = [...padsOfSite(a), ...padsOfSite(b)].map(([s, p]) => state(s, p, false, 0));
      const heavy = pads.filter((p) => p.class === 'heavy').length;
      const mediumUp = pads.filter((p) => p.class !== 'light').length;
      expect(classOutlook([a, b], states, 'heavy', 0, DEFAULT_UNIVERSE_RULES).padCount).toBe(heavy);
      expect(classOutlook([a, b], states, 'medium', 0, DEFAULT_UNIVERSE_RULES).padCount).toBe(mediumUp);
      expect(classOutlook([a, b], states, 'light', 0, DEFAULT_UNIVERSE_RULES).padCount).toBe(n);
      expect(padRows([a, b], states, 'light', 0)).toHaveLength(n);
    });
  }

  it('the wait is the shortest live wait of the class; the cohort is offered past the rules wait; a full horizon is said plainly', () => {
    const p1 = pad('h1', 'heavy');
    const p2 = pad('l1', 'light');
    const s1 = site('s', [p1, p2]);
    const rules = DEFAULT_UNIVERSE_RULES;
    const over = rules.time.cohortOfferWait * 2;
    const busy = [{ ...state(s1, p1, true, over), nextCohortTick: 99 * TICKS_PER_SECOND }, state(s1, p2, false, 0)];
    const heavy = classOutlook([s1], busy, 'heavy', 0, rules);
    expect(heavy.liveWaitSeconds).toBe(over);
    expect(heavy.offerCohort).toBe(true);
    expect(classOutlook([s1], busy, 'light', 0, rules).liveWaitSeconds).toBe(0);
    const full = [state(s1, p1, true, null), state(s1, p2, true, null)];
    expect(classOutlook([s1], full, 'heavy', 0, rules).horizonFull).toBe(true);
    const unknown = classOutlook([s1], [], 'heavy', 0, rules);
    expect(unknown.horizonFull).toBe(false);
    expect(unknown.liveWaitSeconds).toBeNull();
  });

  it('launches per hour are pads x 3600 / cycle, and unknown without a cycle', () => {
    expect(launchesPerHour(6, 150)).toBe(144);
    expect(launchesPerHour(6, null)).toBeNull();
  });
});

function padsOfSite(s: LaunchSiteDef): [LaunchSiteDef, PadDef][] {
  return s.pads.map((p) => [s, p]);
}

describe('the rules screen', () => {
  it('renders the default and the staging documents with different numbers and no code change', () => {
    const date = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    const a = rulesView(defs.rules!['default']!, fmt, date);
    const b = rulesView(defs.rules!['staging']!, fmt, date);
    const text = (v: typeof a): string[] => v.sections.flatMap((s) => s.lines.map((l) => `${l.field}|${l.text}`));
    const ta = text(a);
    const tb = text(b);
    expect(ta.length).toBe(tb.length);
    const differ = ta.filter((l, i) => l !== tb[i]).map((l) => l.split('|')[0]);
    expect(differ).toContain('expiry.craftRetention');
    expect(differ).toContain('expiry.debrisRetention');
    expect(ta.find((l) => l.startsWith('expiry.craftRetention'))).toContain(formatSpan(defs.rules!['default']!.expiry.craftRetention));
    expect(tb.find((l) => l.startsWith('expiry.craftRetention'))).toContain(formatSpan(defs.rules!['staging']!.expiry.craftRetention));
    const local = rulesView(defs.rules!['local']!, fmt, date);
    expect(text(local).find((l) => l.startsWith('expiry.craftRetention'))).toContain('kept for ever');
  });

  it('every number in the text is a field of the document: a changed field changes the line', () => {
    const base = DEFAULT_UNIVERSE_RULES;
    const changed = { ...base, pads: { ...base.pads, reservationHold: base.pads.reservationHold + 37 } };
    const line = (r: typeof base): string => rulesView(r, fmt, String).sections.find((s) => s.id === 'pads')!.lines.find((l) => l.field === 'pads.reservationHold')!.text;
    expect(line(changed)).not.toBe(line(base));
    expect(line(changed)).toContain(formatSpan(base.pads.reservationHold + 37));
  });

  it('formats spans in words', () => {
    expect(formatSpan(90)).toBe('90 s');
    expect(formatSpan(14 * 86400)).toBe('14 days');
    expect(formatSpan(Number.MAX_SAFE_INTEGER)).toBe('never');
  });
});

describe('the solar view of a site', () => {
  it('reads noon with the sun overhead, midnight below, dawn east and dusk west', () => {
    const body = { qFixedToRoot: quat.identity(), spinRoot: { x: 0, y: 0, z: 7.29e-5 }, sunDir: { x: 1, y: 0, z: 0 } };
    const noon = solarViewAt(body, 0, 0);
    expect(noon.localSolarHours).toBeCloseTo(12, 6);
    expect(noon.sunElevationDeg).toBeCloseTo(90, 6);
    expect(solarViewAt(body, 0, 180).localSolarHours).toBeCloseTo(0, 6);
    const east = solarViewAt(body, 0, 90);
    expect(east.localSolarHours).toBeCloseTo(18, 6);
    expect(east.phase).toBe('dusk');
    const west = solarViewAt(body, 0, -89);
    expect(west.localSolarHours).toBeCloseTo(6 + 1 / 15, 6);
    expect(west.phase).toBe('dawn');
  });
});
