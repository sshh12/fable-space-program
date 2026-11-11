/**
 * Cockpit instrument state from the snapshot: what every lamp, switch, guard, selector, readout digit and
 * hand controller of the interior shows. Pure functions of (snapshot, defs, time) plus a small amount of
 * remembered state (the event timer's last staging, the master alarm latch), so they are unit-tested.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { formatMet } from '@/ui';
import { quat, v3, type Quat, type Vec3 } from '@/core/math';
import type { ControlMeta } from './cabin/context';
import type { InstrumentBinding, ReadoutDef } from './layout';

const SAS_MODES = ['stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'maneuver'] as const;
const NAVBALL_MODES = ['surface', 'orbit', 'target'] as const;

export function activeVessel(s: SimSnapshot): VesselSnapshot | undefined {
  return s.vessels.find((v) => v.id === s.activeVesselId);
}

/** State of a binding: on/off for lamps and switches, an index for selectors. */
export function bindingState(binding: InstrumentBinding, s: SimSnapshot, defs: DefLibrary): { on: boolean; index: number } {
  const r = s.readouts;
  const v = activeVessel(s);
  const modules = v ? v.parts.flatMap((p) => p.modules.map((m, i) => ({ m, def: defs.parts[p.def]?.modules[i] }))) : [];
  const chute = (mode: 'drogue' | 'main'): boolean => modules.some(({ m, def }) => m.type === 'parachute' && def?.type === 'parachute' && def.mode === mode && (m.state === 'reefed' || m.state === 'full'));
  const b = (on: boolean): { on: boolean; index: number } => ({ on, index: on ? 0 : 1 });
  switch (binding) {
    case 'sas':
      return b(r.sasEnabled);
    case 'rcs':
      return b(r.rcsEnabled);
    case 'fine':
      return b(r.fineControl);
    case 'gear':
      return b(r.legsDeployed === true);
    case 'lights':
      return b(r.lightsOn);
    case 'engineArmed':
      return b(modules.some(({ m }) => m.type === 'engine' && m.active));
    case 'engineFiring':
      return b(modules.some(({ m }) => m.type === 'engine' && m.active && m.thrust > 0));
    case 'chuteArmed':
      return b(r.chuteEnvelope === 'safe' || r.chuteEnvelope === 'risky');
    case 'drogueDeployed':
      return b(chute('drogue'));
    case 'mainDeployed':
      return b(chute('main'));
    case 'overheat':
      return b(r.maxTempFraction > 0.85);
    case 'gLimit':
      return b(r.gLoad > 8 || (r.gDoseLimit > 0 && r.gDose > 0.4 * r.gDoseLimit));
    case 'masterAlarm':
      return b(r.maxTempFraction > 0.85 || r.gLoad > 8 || (r.gDoseLimit > 0 && r.gDose > 0.4 * r.gDoseLimit) || s.mission.failed || !s.mission.crewAlive);
    case 'stagingLocked':
      return b(s.staging.lockout);
    case 'abortArmed':
      return b(modules.some(({ m }) => m.type === 'les' && !m.jettisoned));
    case 'liftUp':
      return b(r.liftVectorUp === true);
    case 'plasma':
      return b((v?.aero.plasmaIntensity ?? 0) > 0.2);
    case 'warp':
      return b(s.warp.index > 0);
    case 'terrainLoading':
      return b(s.terrain.pending);
    case 'heatShield':
      return b(r.ablatorFraction !== null && r.ablatorFraction < 0.3);
    case 'lowRcs':
      return b(r.rcsFraction !== null && r.rcsFraction < 0.15);
    case 'landed':
      return b(v?.situation === 'landed' || v?.situation === 'splashed');
    case 'navballMode':
      return { on: true, index: Math.max(0, NAVBALL_MODES.indexOf(s.navball.mode as (typeof NAVBALL_MODES)[number])) };
    case 'sasMode':
      return { on: r.sasEnabled, index: Math.max(0, SAS_MODES.indexOf(r.sasMode as (typeof SAS_MODES)[number])) };
    case 'none':
      return { on: true, index: 0 };
  }
}

/** Seven-segment masks (bits a..g = 0..6) for digits, minus and blank. */
const SEGMENTS: Record<string, number> = {
  '0': 0b0111111,
  '1': 0b0000110,
  '2': 0b1011011,
  '3': 0b1001111,
  '4': 0b1100110,
  '5': 0b1101101,
  '6': 0b1111101,
  '7': 0b0000111,
  '8': 0b1111111,
  '9': 0b1101111,
  '-': 0b1000000,
  ' ': 0,
};
/** Bit 7 lights the colon or decimal point that belongs to the digit. */
const SEPARATOR_BIT = 1 << 7;

/** Remembered state across frames: the event timer's start and the time at which the last stage fired. */
export interface InstrumentMemory {
  lastStageUt: number | null;
}

export function readoutText(ro: ReadoutDef, s: SimSnapshot, mem: InstrumentMemory): string {
  const r = s.readouts;
  const n = ro.digits;
  const pad = (x: string): string => (x.length >= n ? x.slice(-n) : ' '.repeat(n - x.length) + x);
  switch (ro.binding) {
    case 'met': {
      // The HUD's own formatter decides the fields: "T+ 012:03:04:05" style -> DDDHHMMSS.
      const t = Math.max(0, Math.floor(r.met));
      const d = Math.floor(t / 86400);
      const h = Math.floor((t % 86400) / 3600);
      const m = Math.floor((t % 3600) / 60);
      const sec = t % 60;
      return pad(`${String(d).padStart(3, '0')}${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}${String(sec).padStart(2, '0')}`);
    }
    case 'eventTimer': {
      // Counts down to the start of the next planned burn, else up from the last staging (or lift-off).
      const nb = r.nodeBurn;
      let t: number;
      let sign = '';
      if (nb && nb.timeToBurnStart !== null && nb.timeToBurnStart > 0) {
        t = nb.timeToBurnStart;
        sign = '-';
      } else t = mem.lastStageUt !== null ? s.ut - mem.lastStageUt : r.met;
      const total = Math.min(5999, Math.max(0, Math.floor(t)));
      const txt = `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
      return pad(sign && total < 600 ? `-${txt.slice(1)}` : txt);
    }
    case 'gLoad': {
      const g = Math.min(99.9, Math.max(0, r.gLoad));
      return pad(String(Math.round(g * 10)).padStart(2, '0'));
    }
    case 'deltaV':
      return pad(String(Math.min(9999, Math.max(0, Math.round(r.deltaVTotal)))));
    case 'altitudeKm':
      return pad(String(Math.min(9999, Math.max(0, Math.round(r.altitudeAsl / 1000)))));
    case 'speed':
      return pad(String(Math.min(99999, Math.max(0, Math.round(r.speedOrbital)))));
  }
}

/** Segment mask of digit `i` of a readout (separator bit for colons / points after the digit). */
export function digitMask(ro: ReadoutDef, text: string, i: number): number {
  const ch = text[i] ?? ' ';
  let m = SEGMENTS[ch] ?? 0;
  if ((ro.colons ?? []).includes(i) || (ro.points ?? []).includes(i)) m |= SEPARATOR_BIT;
  return m;
}

/** The MET string the HUD shows, for comparing the cockpit clock with it (same seconds). */
export function hudMet(s: SimSnapshot): string {
  return formatMet(s.readouts.met);
}

export interface ControlState {
  rot: Quat;
  offset: Vec3;
  /** Emitted luminance (cd/m^2) and whether the emitter is lit (1) or dark (0). */
  emit: [number, number, number];
  lit: number;
  mask: number;
}

const ident = (): ControlState => ({ rot: quat.identity(), offset: v3.zero(), emit: [0, 0, 0], lit: 0, mask: 0 });

/**
 * State of every control for a snapshot. `seatAxes` gives the hand controllers' frames (R, U, L of their
 * seat) so stick deflections follow the applied controls in the crew's own axes.
 */
export function controlStates(
  controls: readonly ControlMeta[],
  s: SimSnapshot,
  defs: DefLibrary,
  time: number,
  mem: InstrumentMemory,
  seatAxes: (seat: string) => { R: Vec3; U: Vec3; L: Vec3 },
  floodLuminance: (flood: number) => [number, number, number],
): ControlState[] {
  const c = s.appliedControls;
  const texts = new Map<ReadoutDef, string>();
  return controls.map((ctl): ControlState => {
    const st = ident();
    switch (ctl.kind) {
      case 'toggle':
      case 'guard': {
        const pos = ctl.binding === 'none' ? (ctl.fixed ?? 0) : bindingState(ctl.binding, s, defs).index;
        st.rot = quat.fromAxisAngle(ctl.axis, ctl.angles?.[pos] ?? 0);
        break;
      }
      case 'rotary': {
        const pos = ctl.binding === 'none' ? (ctl.fixed ?? 0) : bindingState(ctl.binding, s, defs).index;
        st.rot = quat.fromAxisAngle(ctl.axis, ctl.angles?.[Math.min(pos, (ctl.angles?.length ?? 1) - 1)] ?? 0);
        break;
      }
      case 'lamp': {
        const lamp = ctl.lamp!;
        const on = lamp.binding !== 'none' && bindingState(lamp.binding, s, defs).on;
        const flash = lamp.flashHz ? (Math.sin(time * 2 * Math.PI * lamp.flashHz) > -0.2 ? 1 : 0.15) : 1;
        const L = (lamp.luminance ?? 200) * (on ? flash : 0);
        st.emit = [lamp.color[0] * L, lamp.color[1] * L, lamp.color[2] * L];
        st.lit = on ? 1 : 0;
        break;
      }
      case 'digit': {
        const ro = ctl.readout!;
        let text = texts.get(ro);
        if (text === undefined) {
          text = readoutText(ro, s, mem);
          texts.set(ro, text);
        }
        st.mask = digitMask(ro, text, ctl.digit ?? 0);
        st.emit = [ro.color[0] * ro.luminance, ro.color[1] * ro.luminance, ro.color[2] * ro.luminance];
        st.lit = 1;
        break;
      }
      case 'rhc': {
        // Stick: pitch tilts it toward the feet / head, roll to the side, yaw twists it.
        const a = seatAxes(ctl.seat!);
        const tilt = 18 * (Math.PI / 180);
        const q = quat.mul(quat.fromAxisAngle(a.U, -c.roll * tilt), quat.mul(quat.fromAxisAngle(a.R, c.pitch * tilt), quat.fromAxisAngle(a.L, -c.yaw * 12 * (Math.PI / 180))));
        st.rot = q;
        break;
      }
      case 'thc': {
        const a = seatAxes(ctl.seat!);
        const k = 0.008;
        // VES x = starboard (R), y = nose (toward the apex, the seat's L mostly), z = dorsal (U mostly).
        st.offset = v3.add(v3.add(v3.scale(a.R, c.translate.x * k), v3.scale(a.L, c.translate.y * k)), v3.scale(a.U, c.translate.z * k));
        break;
      }
      case 'throttle': {
        st.rot = quat.fromAxisAngle(ctl.axis, -c.throttle * 55 * (Math.PI / 180));
        break;
      }
      case 'flood': {
        const on = s.readouts.lightsOn;
        st.emit = on ? floodLuminance(ctl.flood ?? 0) : [0, 0, 0];
        st.lit = on ? 1 : 0;
        break;
      }
      default:
        break;
    }
    return st;
  });
}

/** Track staging events for the event timer (call once per presented snapshot). */
export function updateMemory(mem: InstrumentMemory, s: SimSnapshot): void {
  for (const e of s.events) if (e.type === 'stageFired' && e.vesselId === s.activeVesselId) mem.lastStageUt = e.ut;
}
