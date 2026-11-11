/**
 * Cockpit instrument state from the snapshot: what every lamp, switch, guard, selector, readout digit and
 * hand controller of the interior shows. Pure functions of (snapshot, vessel, defs, time) plus a small
 * amount of remembered state (the event timer's last staging), so they are unit-tested.
 *
 * The instruments describe the vessel the interior is drawn for (`InstrumentSource.vessel`), which need not
 * be the active one. Vessel-local facts (engines, parachutes, escape tower, plasma, situation, g load, part
 * temperatures, the heat shield) come from that vessel's snapshot. Facts that only the snapshot's readouts
 * carry (SAS, RCS, gear, lights, the HUD's numbers) describe the ACTIVE vessel: for any other vessel those
 * lamps are dark, those switches at rest and those readouts blank.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import { quat, v3, type Quat, type Vec3 } from '@/core/math';
import type { ControlMeta } from './cabin/context';
import type { AlarmsDef, InstrumentBinding, ReadoutDef } from './layout';

const SAS_MODES = ['stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'maneuver'] as const;
const NAVBALL_MODES = ['surface', 'orbit', 'target'] as const;

/** What the instruments read: the snapshot, the vessel the interior belongs to, and whether it is the active one. */
export interface InstrumentSource {
  snapshot: SimSnapshot;
  vessel: VesselSnapshot;
  /** True when `vessel` is the active vessel: the snapshot's readouts (the HUD's values) describe it. */
  active: boolean;
}

export function instrumentSource(s: SimSnapshot, vessel: VesselSnapshot): InstrumentSource {
  return { snapshot: s, vessel, active: vessel.id === s.activeVesselId };
}

/** Hottest part of a vessel as a fraction of its temperature limit. */
export function maxTempFraction(v: VesselSnapshot): number {
  return v.parts.reduce((m, p) => (p.maxTemp > 0 ? Math.max(m, p.tempSkin / p.maxTemp) : m), 0);
}

/** State of a binding: on/off for lamps and switches, an index for selectors. */
export function bindingState(binding: InstrumentBinding, src: InstrumentSource, defs: DefLibrary, alarms: AlarmsDef): { on: boolean; index: number } {
  const s = src.snapshot;
  const v = src.vessel;
  // The readouts describe the active vessel only.
  const r = src.active ? s.readouts : null;
  const modules = v.parts.flatMap((p) => p.modules.map((m, i) => ({ m, def: defs.parts[p.def]?.modules[i] })));
  const chute = (mode: 'drogue' | 'main'): boolean => modules.some(({ m, def }) => m.type === 'parachute' && def?.type === 'parachute' && def.mode === mode && (m.state === 'reefed' || m.state === 'full'));
  const b = (on: boolean): { on: boolean; index: number } => ({ on, index: on ? 0 : 1 });
  // The HUD's values for the active vessel, the vessel's own parts otherwise.
  const overheat = (r ? r.maxTempFraction : maxTempFraction(v)) > alarms.overheatFraction;
  const gLimit = (r ? r.gLoad : v.gLoad) > alarms.gLimit || (r !== null && r.gDoseLimit > 0 && r.gDose > alarms.gDoseFraction * r.gDoseLimit);
  switch (binding) {
    case 'sas':
      return b(r?.sasEnabled === true);
    case 'rcs':
      return b(r?.rcsEnabled === true);
    case 'fine':
      return b(r?.fineControl === true);
    case 'gear':
      return b(r?.legsDeployed === true);
    case 'lights':
      return b(r?.lightsOn === true);
    case 'engineArmed':
      return b(modules.some(({ m }) => m.type === 'engine' && m.active));
    case 'engineFiring':
      return b(modules.some(({ m }) => m.type === 'engine' && m.active && m.thrust > 0));
    case 'chuteArmed':
      return b(r !== null && (r.chuteEnvelope === 'safe' || r.chuteEnvelope === 'risky'));
    case 'drogueDeployed':
      return b(chute('drogue'));
    case 'mainDeployed':
      return b(chute('main'));
    case 'overheat':
      return b(overheat);
    case 'gLimit':
      return b(gLimit);
    case 'masterAlarm':
      return b(overheat || gLimit || s.mission.failed || !s.mission.crewAlive);
    case 'stagingLocked':
      return b(src.active && s.staging.lockout);
    case 'abortArmed':
      return b(modules.some(({ m }) => m.type === 'les' && !m.jettisoned));
    case 'liftUp':
      return b(r?.liftVectorUp === true);
    case 'plasma':
      return b(v.aero.plasmaIntensity > alarms.plasmaBlackout);
    case 'warp':
      return b(s.warp.index > 0);
    case 'terrainLoading':
      return b(s.terrain.pending);
    case 'heatShield': {
      const ablator = r ? r.ablatorFraction : modules.reduce<number | null>((lo, { m }) => (m.type === 'heatShield' ? Math.min(lo ?? 1, m.ablatorFraction) : lo), null);
      return b(ablator !== null && ablator < alarms.ablatorLow);
    }
    case 'lowRcs':
      return b(r !== null && r.rcsFraction !== null && r.rcsFraction < alarms.rcsLow);
    case 'landed':
      return b(v.situation === 'landed' || v.situation === 'splashed');
    case 'navballMode':
      return { on: src.active, index: src.active ? Math.max(0, NAVBALL_MODES.indexOf(s.navball.mode as (typeof NAVBALL_MODES)[number])) : 0 };
    case 'sasMode':
      return { on: r?.sasEnabled === true, index: r ? Math.max(0, SAS_MODES.indexOf(r.sasMode as (typeof SAS_MODES)[number])) : 0 };
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

/** Remembered state across frames: the time at which the last stage of the interior's vessel fired. */
export interface InstrumentMemory {
  lastStageUt: number | null;
}

/** Text of a readout; blank for the readouts that only the active vessel's HUD values carry. */
export function readoutText(ro: ReadoutDef, src: InstrumentSource, mem: InstrumentMemory): string {
  const s = src.snapshot;
  const r = s.readouts;
  const n = ro.digits;
  const pad = (x: string): string => (x.length >= n ? x.slice(-n) : ' '.repeat(n - x.length) + x);
  const blank = ' '.repeat(n);
  switch (ro.binding) {
    case 'met': {
      // Mission time (the HUD's own seconds): "T+ 012:03:04:05" style -> DDDHHMMSS.
      const t = Math.max(0, Math.floor(r.met));
      const d = Math.floor(t / 86400);
      const h = Math.floor((t % 86400) / 3600);
      const m = Math.floor((t % 3600) / 60);
      const sec = t % 60;
      return pad(`${String(d).padStart(3, '0')}${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}${String(sec).padStart(2, '0')}`);
    }
    case 'eventTimer': {
      // Counts down to the start of the next planned burn (active vessel), else up from the last staging.
      const nb = src.active ? r.nodeBurn : null;
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
      // The HUD's g for the active vessel, the vessel's own g otherwise.
      const g = Math.min(99.9, Math.max(0, src.active ? r.gLoad : src.vessel.gLoad));
      return pad(String(Math.round(g * 10)).padStart(2, '0'));
    }
    case 'deltaV':
      return src.active ? pad(String(Math.min(9999, Math.max(0, Math.round(r.deltaVTotal))))) : blank;
    case 'altitudeKm':
      return src.active ? pad(String(Math.min(9999, Math.max(0, Math.round(r.altitudeAsl / 1000))))) : blank;
    case 'speed':
      return src.active ? pad(String(Math.min(99999, Math.max(0, Math.round(r.speedOrbital))))) : blank;
  }
}

/** Segment mask of digit `i` of a readout (separator bit for colons / points after the digit). */
export function digitMask(ro: ReadoutDef, text: string, i: number): number {
  const ch = text[i] ?? ' ';
  let m = SEGMENTS[ch] ?? 0;
  if ((ro.colons ?? []).includes(i) || (ro.points ?? []).includes(i)) m |= SEPARATOR_BIT;
  return m;
}

/** Body rate (rad/s) at which an attitude indicator's rate needle reaches the end of its scale: 5 deg/s. */
export const RATE_FULL_SCALE = (5 * Math.PI) / 180;

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
 * State of every control. `seatAxes` gives the hand controllers' frames (R, U, L of their seat) so stick
 * deflections follow the applied controls (the active vessel's; neutral for any other) in the crew's axes.
 */
export function controlStates(
  controls: readonly ControlMeta[],
  src: InstrumentSource,
  defs: DefLibrary,
  alarms: AlarmsDef,
  time: number,
  mem: InstrumentMemory,
  seatAxes: (seat: string) => { R: Vec3; U: Vec3; L: Vec3 },
  floodLuminance: (flood: number) => [number, number, number],
): ControlState[] {
  const s = src.snapshot;
  const c = src.active ? s.appliedControls : { pitch: 0, yaw: 0, roll: 0, throttle: 0, translate: v3.zero() };
  const lightsOn = src.active && s.readouts.lightsOn;
  const texts = new Map<ReadoutDef, string>();
  return controls.map((ctl): ControlState => {
    const st = ident();
    switch (ctl.kind) {
      case 'toggle':
      case 'guard': {
        const pos = ctl.binding === 'none' ? (ctl.fixed ?? 0) : bindingState(ctl.binding, src, defs, alarms).index;
        st.rot = quat.fromAxisAngle(ctl.axis, ctl.angles?.[pos] ?? 0);
        break;
      }
      case 'rotary': {
        const pos = ctl.binding === 'none' ? (ctl.fixed ?? 0) : bindingState(ctl.binding, src, defs, alarms).index;
        st.rot = quat.fromAxisAngle(ctl.axis, ctl.angles?.[Math.min(pos, (ctl.angles?.length ?? 1) - 1)] ?? 0);
        break;
      }
      case 'lamp': {
        const lamp = ctl.lamp!;
        const on = lamp.binding !== 'none' && bindingState(lamp.binding, src, defs, alarms).on;
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
          text = readoutText(ro, src, mem);
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
        st.rot = quat.mul(quat.fromAxisAngle(a.U, -c.roll * tilt), quat.mul(quat.fromAxisAngle(a.R, c.pitch * tilt), quat.fromAxisAngle(a.L, -c.yaw * 12 * (Math.PI / 180))));
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
      case 'needle': {
        // Body rate about the needle's axis (VES: x pitch, y roll, z yaw), full scale at RATE_FULL_SCALE.
        const w = src.vessel.w;
        const rate = [w.x, w.y, w.z][ctl.fixed ?? 0] ?? 0;
        st.offset = v3.scale(ctl.axis, Math.max(-1, Math.min(1, rate / RATE_FULL_SCALE)) * (ctl.travel ?? 0));
        break;
      }
      case 'flood': {
        st.emit = lightsOn ? floodLuminance(ctl.flood ?? 0) : [0, 0, 0];
        st.lit = lightsOn ? 1 : 0;
        break;
      }
    }
    return st;
  });
}

/** Track staging events of the interior's vessel for the event timer (call once per presented snapshot). */
export function updateMemory(mem: InstrumentMemory, s: SimSnapshot, vesselId: string): void {
  for (const e of s.events) if (e.type === 'stageFired' && e.vesselId === vesselId) mem.lastStageUt = e.ut;
}
