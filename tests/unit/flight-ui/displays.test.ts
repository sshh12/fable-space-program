import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import {
  buildMfdPage,
  createMfdPainter,
  describeFlight,
  describeLandingTarget,
  describeOrbit,
  describeResources,
  describeStages,
  describeWarp,
  formatApsis,
  formatBearing,
  formatCountdown,
  formatDuration,
  formatLength,
  formatMet,
  formatNumber,
  formatSignedRange,
  formatUt,
  formatVerticalSpeed,
  altitudeDatumName,
  G_SCALE,
  gTone,
  landingScope,
  orbitPhase,
  verticalTrend,
  landingTargetRows,
  MARKER_COLORS,
  MFD_PAGES,
  NBSP,
  RADAR_ALTITUDE_SWITCH,
} from '@/ui';
import { WARP_LEVELS } from '@/core/contracts/defs';
import { labVehicleParts, tagLabVehicle, withLabVehicle } from '../../../labs/flight-ui/labVehicle';
import { UI_COLORS } from '@/core/ui/theme';
import { balanceColumns } from '@/ui/hud/hud';
import { ablatorGauge, drawBarGauge, type Frame } from '@/ui/mfd/mfdPainter';
import { landingTargetExpanded, stageActionText, summarizeResources } from '@/ui/model';

let defs: DefLibrary;
beforeAll(async () => {
  defs = withLabVehicle(await loadDefs(fsDefSource()));
});

const snap = (scene: FakeScene): SimSnapshot => {
  const sim = createFakeSim(defs, { scene, parts: labVehicleParts(defs) });
  for (let i = 0; i < 30; i++) sim.advance(1 / 60);
  return tagLabVehicle(sim.snapshot());
};

const n = (s: string): string => s.replaceAll(NBSP, ' ');

describe('formatters', () => {
  it('formats lengths with SI prefixes and grouping', () => {
    expect(n(formatLength(12.34))).toBe('12.3 m');
    expect(n(formatLength(8765.4))).toBe('8 765 m');
    expect(n(formatLength(12_345))).toBe('12.35 km');
    expect(n(formatLength(12_345, 'altitude'))).toBe('12 345 m');
    expect(n(formatLength(2_298_300))).toBe('2 298 km');
    expect(n(formatLength(998_765))).toBe('998.8 km');
    expect(n(formatLength(2_298_300, 'apsis'))).toBe('2 298.3 km');
    expect(n(formatLength(384_400_000))).toBe('384.4 Mm');
    expect(n(formatLength(-6_360_200))).toBe('−6 360 km');
    expect(n(formatLength(-6_360_200, 'apsis'))).toBe('−6 360.2 km');
    expect(n(formatLength(2e9))).toBe('200.0 Mm'.replace('200.0 Mm', '2 000.0 Mm'));
    expect(n(formatLength(2e10))).toBe('20.000 Gm');
  });

  it('formats durations, countdowns, MET and UT', () => {
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(n(formatDuration(3 * 86400 + 4 * 3600 + 5 * 60 + 6))).toBe('3d 04:05');
    expect(n(formatCountdown(600))).toBe('T− 10:00');
    expect(n(formatCountdown(-12))).toBe('T+ 0:12');
    expect(n(formatMet(3725))).toBe('T+ 01:02:05');
    expect(formatUt(0)).toBe('2000-01-01 12:00:00 UTC');
    expect(formatUt(86400 + 3661)).toBe('2000-01-02 13:01:01 UTC');
  });

  it('formats apsides in km on both sides of 100 km, and vertical speed with a direction arrow', () => {
    // The 100 km lunar parking orbit: never "100.0 km" next to "100 000 m", nor "100.0" next to "99.96".
    expect(n(formatApsis(100_040))).toBe('100.0 km');
    expect(n(formatApsis(99_960))).toBe('100.0 km');
    expect(n(formatApsis(99_640))).toBe('99.6 km');
    expect(n(formatApsis(15_200))).toBe('15.2 km');
    expect(n(formatApsis(360))).toBe('0.4 km');
    expect(n(formatApsis(-1_736_400))).toBe('−1 736.4 km');
    expect(n(formatApsis(384_400_000))).toBe('384.4 Mm');
    // The current altitude keeps metres up to 50 km (ascent, landing), and reads the 100 km orbit in km.
    expect(n(formatLength(49_960, 'altitude'))).toBe('49 960 m');
    expect(n(formatLength(60_000, 'altitude'))).toBe('60.0 km');
    expect(n(formatLength(99_960, 'altitude'))).toBe('100.0 km');
    expect(n(formatLength(100_040, 'altitude'))).toBe('100.0 km');
    // A signed number; the direction is an icon (verticalTrend), never a font glyph such as a solid square.
    expect(n(formatVerticalSpeed(12.34))).toBe('+12.3 m/s');
    expect(n(formatVerticalSpeed(-4))).toBe('−4.0 m/s');
    expect(n(formatVerticalSpeed(0.01))).toBe('0.0 m/s');
    expect(n(formatVerticalSpeed(-0.01))).toBe('0.0 m/s');
    expect([verticalTrend(12.34), verticalTrend(-4), verticalTrend(0.01)]).toEqual(['up', 'down', 'level']);
    for (const v of [12.34, -4, 0, 0.01]) expect(formatVerticalSpeed(v)).not.toMatch(/[■-◿]/);
  });

  it('spells out signs of ranges and normalises bearings', () => {
    expect(n(formatSignedRange(12_300, 'ahead', 'behind'))).toBe('12.30 km ahead');
    expect(n(formatSignedRange(-450, 'right', 'left'))).toBe('450 m left');
    expect(formatSignedRange(0.2, 'ahead', 'behind')).toBe('on track');
    expect(formatBearing(-3)).toBe('357°');
    expect(formatBearing(45.4)).toBe('045°');
    expect(formatBearing(359.7)).toBe('000°');
    expect(n(formatNumber(-0.0001, 2))).toBe('0.00');
  });
});

describe('display models', () => {
  it('describes the lunar landing target of the FakeSim lunar scenes', () => {
    for (const scene of ['lunarOrbit', 'lunarSurface'] as const) {
      const s = snap(scene);
      const lt = s.readouts.landingTarget!;
      const view = describeLandingTarget(s)!;
      expect(view.name).toBe('Tranquility Base');
      expect(view.kindLabel).toBe('Landing target');
      expect(view.distance).toBe(formatLength(lt.distance));
      // Landed on the target the bearing is "on target", not a compass bearing to a point under the vessel.
      expect(view.bearing).toBe(lt.distance < 0.5 ? 'on target' : formatBearing(lt.bearingDeg));
      expect(view.predicted).toBeNull();
      const rows = landingTargetRows(view);
      // Rows without data collapse: stationary on the surface there is neither a ground track nor a prediction.
      expect(rows.map((r) => r[0])).toEqual(scene === 'lunarOrbit' ? ['Distance', 'Bearing', 'Down-range', 'Cross-range', 'Predicted arrival'] : ['Distance', 'Bearing', 'Track · arrival']);
      if (scene === 'lunarOrbit') {
        expect(view.downRange).toMatch(/ (ahead|behind)$/);
        expect(view.crossRange).toMatch(/ (left|right)$/);
      } else {
        expect(view.downRange).toBe('no ground track');
      }
    }
  });

  it('labels a predicted impact and a predicted entry point', () => {
    const s = snap('lunarOrbit');
    const lt = s.readouts.landingTarget!;
    const withImpact = { ...s, readouts: { ...s.readouts, landingTarget: { ...lt, predicted: { kind: 'impact' as const, ut: s.ut + 100, latitude: 0, longitude: 0, missDistance: 1234, missBearingDeg: 90 } } } };
    const v = describeLandingTarget(withImpact)!;
    expect(landingTargetRows(v)[4]).toEqual(['Impact miss', `1${NBSP}234${NBSP}m · 090°`]);
    const withEntry = { ...s, readouts: { ...s.readouts, landingTarget: { ...lt, predicted: { kind: 'entry' as const, ut: s.ut + 100, latitude: 0, longitude: 0, missDistance: 12, missBearingDeg: 271 } } } };
    expect(landingTargetRows(describeLandingTarget(withEntry)!)[4]![0]).toBe('Entry point miss');
  });

  it('shows Ap and Pe of the lunar parking orbit in one unit on the HUD and the MFD', () => {
    const s = snap('lunarOrbit');
    const o = describeOrbit(s);
    expect(n(o.apoapsis)).toMatch(/ km$/);
    expect(n(o.periapsis)).toMatch(/ km$/);
    const rows = buildMfdPage('orbit', s, defs).rows;
    expect(rows.find((r) => r.label === 'Apoapsis')!.value).toBe(o.apoapsis);
    expect(rows.find((r) => r.label === 'Periapsis')!.value).toBe(o.periapsis);
  });

  it('uses one flight-data model on the HUD and the MFD (heading, radar switch, vertical speed)', () => {
    const base = snap('ascent');
    const at = (radar: number, vs: number): SimSnapshot => ({ ...base, readouts: { ...base.readouts, altitudeRadar: radar, verticalSpeed: vs } });
    for (const [radar, expectSource] of [
      [RADAR_ALTITUDE_SWITCH - 1, 'radar'],
      [RADAR_ALTITUDE_SWITCH + 1, 'asl'],
      [4000, 'asl'],
    ] as const) {
      const s = at(radar, -12.34);
      const f = describeFlight(s);
      expect(f.altitudeSource).toBe(expectSource);
      const rows = buildMfdPage('flight', s, defs).rows;
      expect(rows[0]).toMatchObject({ label: expectSource === 'radar' ? 'Radar alt' : 'Altitude', value: f.altitude });
      expect(rows.find((r) => r.label === 'Vertical')!.value).toBe(f.verticalSpeed);
      expect(n(f.verticalSpeed)).toBe('−12.3 m/s');
      expect(f.verticalTrend).toBe('down');
      expect(rows.find((r) => r.label === 'Heading')!.value).toBe(formatBearing(s.navball.headingDeg));
      expect(rows.find((r) => r.label === 'Heading')!.value).toBe(f.heading);
    }
    // On the ground the automatic altimeter reads sea level (the HUD rule), whatever the radar altitude.
    const pad = snap('pad');
    expect(describeFlight(pad).altitudeSource).toBe('asl');
    expect(buildMfdPage('flight', pad, defs).rows[0]!.label).toBe('Altitude');
    // The landing page reads radar altitude and the same vertical / horizontal speed strings.
    const landing = buildMfdPage('landing', at(850, 3.21), defs).rows;
    expect(landing[0]).toMatchObject({ label: 'Radar alt', value: describeFlight(at(850, 3.21), 'radar').altitude });
    expect(n(landing[1]!.value)).toBe('+3.2 m/s');
    expect(landing[1]!.icon).toBe('up');
  });

  it('MFD landing and entry pages carry exactly the landing-target rows of the HUD panel', () => {
    for (const scene of ['lunarOrbit', 'lunarSurface', 'reentry'] as const) {
      const s = snap(scene);
      const rows = landingTargetRows(describeLandingTarget(s)!);
      for (const page of ['landing', 'entry'] as const) {
        const m = buildMfdPage(page, s, defs);
        expect(m.section!.rows.map((r) => [r.label, r.value])).toEqual(rows);
      }
    }
  });

  it('builds every MFD page for every scene', () => {
    for (const scene of ['pad', 'ascent', 'lowOrbit', 'translunar', 'lunarOrbit', 'lunarSurface', 'reentry', 'chutes'] as const) {
      const s = snap(scene);
      for (const page of MFD_PAGES) {
        const m = buildMfdPage(page, s, defs);
        expect(m.rows.length).toBeGreaterThan(0);
        for (const r of [...m.rows, ...(m.section?.rows ?? [])]) expect(r.value).not.toMatch(/NaN|undefined/);
      }
    }
  });

  it('aggregates resources per stage group in vehicle order', () => {
    const sim = createFakeSim(defs, { scene: 'lowOrbit', parts: labVehicleParts(defs, { upper: 0.25 }, ['upper', 'lander', 'capsule']) });
    const groups = describeResources(tagLabVehicle(sim.snapshot()), defs);
    expect(groups.map((g) => g.label)).toEqual(['M-2 upper stage', 'Lander', 'Capsule']);
    expect(groups[0]!.bars.map((b) => b.name)).toEqual(['RP-1', 'Liquid oxygen']);
    expect(groups[0]!.bars[0]!.fraction).toBeCloseTo(0.25, 9);
    // Without a vehicle definition, everything is one group under the vessel name.
    const untagged = describeResources(sim.snapshot(), defs);
    expect(untagged.map((g) => g.label)).toEqual(['Fake vessel']);
  });

  describe('landing scope (MFD landing page)', () => {
    /** Canvas 2D stand-in that records every call and property write (Node has no canvas). */
    function recordingCtx(): { ctx: OffscreenCanvasRenderingContext2D; calls: { op: string; args: unknown[] }[] } {
      const calls: { op: string; args: unknown[] }[] = [];
      const props: Record<string | symbol, unknown> = {};
      const ctx = new Proxy(props, {
        get(t, prop) {
          if (prop in t) return t[prop];
          if (prop === 'measureText') return (s: string) => ({ width: s.length * 10 });
          return (...args: unknown[]) => void calls.push({ op: String(prop), args });
        },
        set(t, prop, value) {
          t[prop] = value;
          calls.push({ op: `set:${String(prop)}`, args: [value] });
          return true;
        },
      });
      return { ctx: ctx as unknown as OffscreenCanvasRenderingContext2D, calls };
    }

    /** Centres and colours of every icon drawIcon drew (save, translate, scale(k), ..., strokeStyle = colour). */
    function icons(calls: { op: string; args: unknown[] }[]): { x: number; y: number; color: string }[] {
      const out: { x: number; y: number; color: string }[] = [];
      calls.forEach((c, i) => {
        if (c.op !== 'translate' || calls[i + 1]?.op !== 'scale') return;
        const k = calls[i + 1]!.args[0] as number;
        const color = calls.slice(i + 2).find((x) => x.op === 'set:strokeStyle' && x.args[0] !== 'rgba(6,10,16,0.85)')!.args[0] as string;
        out.push({ x: (c.args[0] as number) + 12 * k, y: (c.args[1] as number) + 12 * k, color });
      });
      return out;
    }

    /** Compass direction of the dashed ground-track line (the only dashed path of the page), or null. */
    function trackLine(calls: { op: string; args: unknown[] }[]): number | null {
      const i = calls.findIndex((c) => c.op === 'setLineDash');
      if (i < 0) return null;
      const from = calls.slice(i).find((c) => c.op === 'moveTo')!.args as number[];
      const to = calls.slice(i).find((c) => c.op === 'lineTo')!.args as number[];
      const deg = (Math.atan2(to[0]! - from[0]!, -(to[1]! - from[1]!)) * 180) / Math.PI;
      return (deg + 360) % 360;
    }

    function paintLanding(s: SimSnapshot): { vessel: { x: number; y: number }; target: { x: number; y: number }; texts: string[]; trackLineDeg: number | null } {
      const g = globalThis as unknown as { Path2D?: unknown };
      g.Path2D ??= class {};
      const { ctx, calls } = recordingCtx();
      createMfdPainter().paint(ctx, 1024, 768, 'landing', s, defs);
      const drawn = icons(calls);
      return {
        vessel: drawn.find((d) => d.color === '#ffa53a')!,
        target: drawn.find((d) => d.color === MARKER_COLORS.target)!,
        texts: calls.filter((c) => c.op === 'fillText').map((c) => c.args[0] as string),
        trackLineDeg: trackLine(calls),
      };
    }

    const withTarget = (horizontalSpeed: number, lt: { distance: number; bearingDeg: number; downRange: number; crossRange: number }): SimSnapshot => {
      const s = snap('lunarSurface');
      return { ...s, readouts: { ...s.readouts, horizontalSpeed, landingTarget: { ...s.readouts.landingTarget!, ...lt, predicted: null } } };
    };

    it('places a target 400 m away off the vessel symbol while hovering (no ground track)', () => {
      // Hovering: surface speed below 0.1 m/s, so the readout's down-range and cross-range are both 0.
      const s = withTarget(0.03, { distance: 400, bearingDeg: 30, downRange: 0, crossRange: 0 });
      const view = describeLandingTarget(s)!;
      expect(view.tracked).toBe(false);
      const g = landingScope(view);
      expect(Math.hypot(g.east, g.north)).toBeCloseTo(400, 9);
      expect(g.trackDeg).toBeNull();
      const { vessel, target, texts, trackLineDeg } = paintLanding(s);
      const dx = target.x - vessel.x;
      const dy = target.y - vessel.y;
      expect(Math.hypot(dx, dy)).toBeGreaterThan(40);
      // North-up: bearing 030 is up and to the right.
      expect((Math.atan2(dx, -dy) * 180) / Math.PI).toBeCloseTo(30, 6);
      expect(texts).toContain('N');
      expect(texts).toContain('NORTH UP · NO GROUND TRACK');
      expect(trackLineDeg).toBeNull();
    });

    it('stays north-up with a ground track, and draws the track where the down-range / cross-range rows put it', () => {
      // Target at bearing 200, 300 m ahead and 100 m left of the track: the track heads 200 + 18.4 = 218.4 deg.
      const s = withTarget(45, { distance: Math.hypot(300, 100), bearingDeg: 200, downRange: 300, crossRange: -100 });
      const view = describeLandingTarget(s)!;
      const g = landingScope(view);
      const expectedTrack = 200 - (Math.atan2(-100, 300) * 180) / Math.PI;
      expect(g.trackDeg).toBeCloseTo(expectedTrack, 9);
      // Rotating the target into the track frame gives back the readout's own numbers.
      const rel = ((200 - g.trackDeg!) * Math.PI) / 180;
      expect(view.raw.distance * Math.cos(rel)).toBeCloseTo(300, 9);
      expect(view.raw.distance * Math.sin(rel)).toBeCloseTo(-100, 9);
      const { vessel, target, texts, trackLineDeg } = paintLanding(s);
      const dx = target.x - vessel.x;
      const dy = target.y - vessel.y;
      expect((((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360)).toBeCloseTo(200, 6);
      expect(trackLineDeg).toBeCloseTo(expectedTrack, 6);
      expect(texts).toContain(`NORTH UP · TRACK ${formatBearing(expectedTrack)}`);
    });

    it('does not move the target when a slow drift crosses the 0.1 m/s ground-track threshold', () => {
      // The same geometry just below (no track: down/cross-range 0) and just above (track due east) the threshold.
      const d = 250;
      const brg = 120;
      const rel = ((brg - 90) * Math.PI) / 180;
      const below = paintLanding(withTarget(0.09, { distance: d, bearingDeg: brg, downRange: 0, crossRange: 0 }));
      const above = paintLanding(withTarget(0.11, { distance: d, bearingDeg: brg, downRange: d * Math.cos(rel), crossRange: d * Math.sin(rel) }));
      expect(Math.hypot(above.target.x - below.target.x, above.target.y - below.target.y)).toBeLessThan(1e-9);
      expect(below.trackLineDeg).toBeNull();
      expect(above.trackLineDeg).toBeCloseTo(90, 6);
    });

    it('draws a target at the vessel only when it really is there', () => {
      const { vessel, target } = paintLanding(withTarget(0, { distance: 0.2, bearingDeg: 0, downRange: 0, crossRange: 0 }));
      expect(Math.hypot(target.x - vessel.x, target.y - vessel.y)).toBeLessThan(1e-9);
    });
  });

  it('names the altitude reference by the body: sea level on Earth, the datum on the Moon', () => {
    expect(altitudeDatumName(snap('pad'), defs)).toBe('sea level');
    expect(altitudeDatumName(snap('lowOrbit'), defs)).toBe('sea level');
    for (const scene of ['lunarOrbit', 'lunarSurface'] as const) expect(altitudeDatumName(snap(scene), defs)).toBe('datum');
  });

  it('reads the orbit by flight phase: a suborbital ascent is amber, an entry or a descent under chutes hides it', () => {
    const asc = snap('ascent');
    const powered = { ...asc, readouts: { ...asc.readouts, throttle: 0.9, thrust: 8e6, periapsisAltitude: -6.3e6, verticalSpeed: 300 } };
    expect(orbitPhase(powered, defs)).toEqual({ show: true, suborbital: true, periapsisTone: 'caution' });
    const falling = { ...asc, readouts: { ...asc.readouts, throttle: 0, thrust: 0, periapsisAltitude: -6.3e6, verticalSpeed: -20, altitudeAsl: 3000 } };
    expect(orbitPhase(falling, defs).show).toBe(false);
    const lo = snap('lowOrbit');
    expect(orbitPhase(lo, defs)).toEqual({ show: true, suborbital: false, periapsisTone: 'normal' });
    // Coasting above the atmosphere with the periapsis below the surface: an impact (red).
    const impact = { ...lo, readouts: { ...lo.readouts, throttle: 0, thrust: 0, periapsisAltitude: -1e5 } };
    expect(orbitPhase(impact, defs).periapsisTone).toBe('warning');
  });

  it('tones g on one scale from the sim limits (HUD gauge and MFD pages)', () => {
    expect(G_SCALE).toEqual({ caution: 6, limit: 10, full: 12 });
    expect([gTone(1), gTone(4.5), gTone(6), gTone(9.9), gTone(10)]).toEqual(['normal', 'normal', 'caution', 'caution', 'warning']);
    const s = snap('reentry');
    const at = (g: number): string => buildMfdPage('flight', { ...s, readouts: { ...s.readouts, gLoad: g } }, defs).rows.find((r) => r.label === 'G load')!.tone!;
    expect([at(1), at(7), at(11)]).toEqual(['normal', 'caution', 'warning']);
  });

  it('collapses the orbit page to one status line while landed (no orbit to tabulate)', () => {
    const rows = buildMfdPage('orbit', snap('lunarSurface'), defs).rows;
    expect(rows.map((r) => r.label)).toEqual(['Body', 'Situation']);
    expect(rows[1]!.value).toBe('Landed · no orbit');
    expect(buildMfdPage('orbit', snap('lunarOrbit'), defs).rows.find((r) => r.label === 'Apoapsis')!.value).not.toBe('—');
  });

  it('paints every MFD page of every scene at 1024 x 768 and 512 x 384 with no text under 3 % of the height', () => {
    const g = globalThis as unknown as { Path2D?: unknown };
    g.Path2D ??= class {};
    for (const [w, h] of [
      [1024, 768],
      [512, 384],
    ] as const) {
      for (const scene of ['pad', 'ascent', 'lowOrbit', 'translunar', 'lunarOrbit', 'lunarSurface', 'reentry', 'chutes'] as const) {
        const s = snap(scene);
        for (const page of MFD_PAGES) {
          const texts: string[] = [];
          const sizes: number[] = [];
          const gradient = { addColorStop: () => undefined };
          const ctx = new Proxy({} as Record<string | symbol, unknown>, {
            get(t, prop) {
              if (prop in t) return t[prop];
              if (prop === 'measureText') return (x: string) => ({ width: x.length * h * 0.02 });
              if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
              if (prop === 'fillText') return (x: string) => void texts.push(x);
              return () => undefined;
            },
            set(t, prop, value) {
              t[prop] = value;
              if (prop === 'font') sizes.push(Number(/(\d+(?:\.\d+)?)px/.exec(String(value))![1]));
              return true;
            },
          }) as unknown as OffscreenCanvasRenderingContext2D;
          createMfdPainter().paint(ctx, w, h, page, s, defs);
          expect(texts.length, `${scene} ${page}`).toBeGreaterThan(5);
          for (const t of texts) expect(t, `${scene} ${page}`).not.toMatch(/NaN|undefined|Infinity/);
          expect(Math.min(...sizes), `${scene} ${page} ${w}x${h}`).toBeGreaterThanOrEqual(Math.floor(h * 0.03));
        }
      }
    }
  });

  it('describes stages and the warp limit', () => {
    const sim = createFakeSim(defs, { scene: 'ascent' });
    sim.commands.stage();
    const s = sim.snapshot();
    const st = describeStages(s);
    expect(st.tiles[0]!.fired).toBe(true);
    expect(st.tiles[1]!.next).toBe(true);
    const w = describeWarp(s, WARP_LEVELS);
    expect(w.limit).toMatch(/^Limited to ×4: /);
  });
});

describe('round-2 display rules', () => {
  const frame: Frame = { w: 1024, h: 768, top: 80, bottom: 700, pad: 23, min: 23 };

  /** Colour of every solid fill (globalAlpha 1) exactly as wide as the gauge's bar (30 px): the fill, not the redline. */
  function solidFills(paint: (ctx: OffscreenCanvasRenderingContext2D) => void): string[] {
    const t: Record<string | symbol, unknown> = { globalAlpha: 1 };
    const out: string[] = [];
    const ctx = new Proxy(t, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'measureText') return (x: string) => ({ width: x.length * 10 });
        if (prop === 'fillRect') return (_x: number, _y: number, w: number) => void (target.globalAlpha === 1 && w === 30 && out.push(String(target.fillStyle)));
        return () => undefined;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    }) as unknown as OffscreenCanvasRenderingContext2D;
    paint(ctx);
    return out;
  }

  it('fills the ablator gauge in one colour by the zone of its reading: no red at a nominal 80 %, red below the redline', () => {
    for (const [frac, red] of [
      [0.8, false],
      [0.31, false],
      [0.2, true],
    ] as const) {
      const fills = solidFills((ctx) => drawBarGauge(ctx, frame, 100, 100, 30, 300, ablatorGauge(frac)));
      expect(fills.includes(UI_COLORS.warning), `ablator ${frac}`).toBe(red);
      expect(fills.includes(UI_COLORS.good), `ablator ${frac}`).toBe(!red);
    }
    // A high-is-bad gauge (g load) still shows every zone it passes.
    const g = { ...ablatorGauge(0.9), lowIsBad: false, zones: [[0.5, UI_COLORS.good], [0.8, UI_COLORS.caution], [1, UI_COLORS.warning]] as [number, string][] };
    expect(solidFills((ctx) => drawBarGauge(ctx, frame, 100, 100, 30, 300, g))).toEqual(expect.arrayContaining([UI_COLORS.good, UI_COLORS.caution, UI_COLORS.warning]));
  });

  it('reports the stage that owns the running engines as active, with its live numbers', () => {
    const base = snap('ascent');
    const stages = base.staging.stages.map((x, i) => ({ ...x, fired: i === 0, propellantFraction: i === 0 ? 0.6 : x.propellantFraction, deltaVNow: i === 0 ? 1890 : x.deltaVNow }));
    const s = { ...base, staging: { ...base.staging, nextStage: 1, stages } };
    const st = describeStages(s);
    expect(st.active).toBe(0);
    expect(st.tiles[0]!.active).toBe(true);
    expect(n(st.tiles[0]!.deltaV)).toBe('1 890 m/s');
    // A fired stage the sim no longer reports (its engines shut down) is not active.
    const off = { ...s, staging: { ...s.staging, stages: stages.map((x, i) => (i === 0 ? { ...x, propellantFraction: null } : x)) } };
    expect(describeStages(off).active).toBe(-1);
    // The MFD staging strip takes its numbers from the active stage.
    const rows = buildMfdPage('staging', s, defs).rows;
    expect(rows.find((r) => r.label === 'Active stage')!.value).toBe(`1 · ${stages[0]!.label}`);
    expect(rows.find((r) => r.label === 'Stage Δv')!.value).toBe(st.tiles[0]!.deltaV);
  });

  it('names what an engine-less stage does instead of what it lacks', () => {
    expect(stageActionText(['decouple', 'deployParachute'])).toBe('separate · deploy chute');
    expect(stageActionText(['fireSeparationMotors', 'jettisonLES', 'jettisonFairing'])).toBe('sep. motors · jettison tower · jettison fairing');
    expect(stageActionText(['deployLegs', 'deployLegs'])).toBe('deploy gear');
    expect(stageActionText(['someFutureAction'])).toBe('');
  });

  it('folds the full resource groups into one line and shows the groups in use', () => {
    const groups = [
      { id: 'a', label: 'Booster', bars: [{ resourceId: 'x', name: 'X', fraction: 0.62, amount: '62 %' }] },
      { id: 'b', label: 'Upper', bars: [{ resourceId: 'x', name: 'X', fraction: 1, amount: '100 %' }] },
      { id: 'c', label: 'Capsule', bars: [{ resourceId: 'y', name: 'Y', fraction: 1, amount: '100 %' }] },
    ];
    expect(summarizeResources(groups)).toEqual({ inUse: [{ id: 'a', label: 'Booster', fraction: 0.62, amount: '62 %', detail: 'X 62 %' }], full: ['Upper', 'Capsule'] });
    // A group is one line: the resource that runs out first.
    const two = [{ ...groups[0]!, bars: [...groups[0]!.bars, { resourceId: 'z', name: 'Z', fraction: 0.55, amount: '55 %' }] }];
    expect(summarizeResources(two).inUse[0]).toMatchObject({ fraction: 0.55, amount: '55 %', detail: 'X 62 % · Z 55 %' });
    // All full (on the pad): one folded line.
    const full = groups.map((g) => ({ ...g, bars: g.bars.map((b) => ({ ...b, fraction: 1 })) }));
    expect(summarizeResources(full)).toEqual({ inUse: [], full: ['Booster', 'Upper', 'Capsule'] });
  });

  it('opens the landing-target rows only with a prediction, in an entry or while descending', () => {
    const orbit = snap('lunarOrbit');
    expect(landingTargetExpanded(orbit, defs)).toBe(false);
    expect(landingTargetExpanded(snap('lunarSurface'), defs)).toBe(false);
    const lt = orbit.readouts.landingTarget!;
    const predicted = { ...orbit, readouts: { ...orbit.readouts, landingTarget: { ...lt, predicted: { kind: 'impact' as const, ut: orbit.ut + 100, latitude: 0, longitude: 0, missDistance: 10, missBearingDeg: 0 } } } };
    expect(landingTargetExpanded(predicted, defs)).toBe(true);
    const descent = { ...orbit, readouts: { ...orbit.readouts, verticalSpeed: -12, periapsisAltitude: -40_000 } };
    expect(landingTargetExpanded(descent, defs)).toBe(true);
  });

  it('reads "on target" only when the vessel sits on the landing target', () => {
    const s = snap('lunarOrbit');
    const lt = s.readouts.landingTarget!;
    const at = (distance: number): string => describeLandingTarget({ ...s, readouts: { ...s.readouts, landingTarget: { ...lt, distance, bearingDeg: 87 } } })!.bearing;
    expect(at(0.3)).toBe('on target');
    expect(at(0.6)).toBe('087°');
    expect(at(400)).toBe('087°');
  });

  it('draws few resources as full-height tank gauges on the systems page, many as bars', () => {
    const g = globalThis as unknown as { Path2D?: unknown };
    g.Path2D ??= class {};
    const paintSystems = (s: SimSnapshot): { texts: string[]; tallest: number } => {
      const texts: string[] = [];
      let tallest = 0;
      const ctx = new Proxy({} as Record<string | symbol, unknown>, {
        get(t, prop) {
          if (prop in t) return t[prop];
          if (prop === 'measureText') return (x: string) => ({ width: x.length * 10 });
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
          if (prop === 'fillText') return (x: string) => void texts.push(x);
          // Every fill but the page background (the whole canvas).
          if (prop === 'fillRect') return (_x: number, _y: number, _w: number, hh: number) => void (hh < 768 && (tallest = Math.max(tallest, hh)));
          return () => undefined;
        },
        set(t, prop, value) {
          t[prop] = value;
          return true;
        },
      }) as unknown as OffscreenCanvasRenderingContext2D;
      createMfdPainter().paint(ctx, 1024, 768, 'systems', s, defs);
      return { texts, tallest };
    };
    // Entry: the capsule's ablator alone is one tank gauge filling the column's height.
    const sim = createFakeSim(defs, { scene: 'reentry', parts: labVehicleParts(defs, { capsule: 0.8 }, ['capsule']) });
    const capsule = paintSystems(tagLabVehicle(sim.snapshot()));
    expect(capsule.texts).toEqual(expect.arrayContaining(['CAPSULE', 'ABLATOR', `80${NBSP}%`]));
    // The tallest fill is the tank's track above the low zone (90 % of the tube).
    expect(capsule.tallest, 'tank track height').toBeGreaterThan(768 * 0.4);
    // The full stack on the pad (more than six resources): bars, no tall tank.
    const pad = paintSystems(snap('pad'));
    expect(pad.tallest).toBeLessThan(768 * 0.2);
  });

  it('balances the key-help columns by height', () => {
    // The default binding groups: Attitude 7, Throttle 6, SAS 9, Translation 6, Systems 3, Time 5, Views 12, Cockpit 3.
    const heights = [7, 6, 9, 6, 3, 5, 12, 3].map((x) => x + 1.6);
    const cols = balanceColumns(heights, 3);
    const sums = cols.map((c) => c.reduce((a, i) => a + heights[i]!, 0));
    expect(cols.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const c of cols) expect(c).toEqual([...c].sort((a, b) => a - b));
    expect(cols[0]![0]).toBe(0);
    expect(Math.max(...sums) - Math.min(...sums)).toBeLessThanOrEqual(3);
  });
});
