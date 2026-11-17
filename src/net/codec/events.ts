/**
 * The codec of `SimEvent` (src/core/contracts/sim.ts), every variant in the order of the contract's union
 * (the variant index is its wire code: append only). A variant added to `SimEvent` fails to compile here
 * until it has a codec.
 */
import type { MilestoneRecord, SimEvent } from '@/core/contracts/sim';
import { vec3, timeOffer } from './common';
import { array, bool, enumOf, f64, id, nullable, opt, record, struct, text, tick, uint, union, type Codec } from './schema';

const base = { ut: f64, vesselId: id, provisional: opt(bool) };

const milestoneRecord: Codec<MilestoneRecord> = struct<MilestoneRecord>({ id, ut: f64, data: record(f64, 256) });

export const simEvent: Codec<SimEvent> = union<SimEvent, 'type'>('type', {
  stageFired: { ...base, stageIndex: uint, label: text },
  engineIgnition: { ...base, partId: id },
  engineShutdown: { ...base, partId: id, flameout: bool },
  clampsReleased: { ...base },
  decoupled: { ...base, partId: id, newVesselIds: array(id, 256) },
  fairingJettisoned: { ...base, partId: id, newVesselIds: array(id, 256) },
  lesFired: { ...base, partId: id },
  legsToggled: { ...base, deployed: bool },
  chuteDeployed: { ...base, partId: id, mode: enumOf(['drogue', 'main'] as const) },
  chuteInflated: { ...base, partId: id },
  chuteCut: { ...base, partId: id },
  chuteFailed: { ...base, partId: id },
  rcsPulse: { ...base, partId: id },
  touchdown: { ...base, speed: f64, surface: enumOf(['land', 'water'] as const), partId: id },
  splash: { ...base, speed: f64 },
  partDestroyed: { ...base, partId: id, cause: enumOf(['impact', 'overheat', 'overstress', 'explosion', 'collision'] as const), posVes: vec3 },
  explosion: { ...base, posRoot: vec3, energy: f64 },
  jointBroken: { ...base, partId: id },
  crewLost: { ...base, cause: text },
  soiChange: { ...base, fromBodyId: id, toBodyId: id },
  vesselRemoved: { ...base, reason: enumOf(['burnedUp', 'impact', 'expired', 'limit', 'rolledBack', 'recovered', 'lost', 'pressure'] as const) },
  activeVesselChanged: { ...base, previousVesselId: id },
  warpChanged: { ...base, index: uint, factor: f64, reason: nullable(text) },
  nodeCompleted: { ...base, nodeId: id },
  milestone: { ...base, milestone: milestoneRecord },
  missionFailed: { ...base, reason: text },
  dockCapture: { ...base, partId: id, otherVesselId: id, otherPartId: id },
  docked: { ...base, partId: id, otherPartId: id, absorbedVesselId: id },
  captureLost: {
    ...base,
    partId: id,
    otherVesselId: id,
    reason: enumOf(['envelope', 'occupied', 'clamped', 'timeout'] as const),
    limit: opt(enumOf(['lateral', 'angle', 'roll', 'closing', 'lateralSpeed', 'rate'] as const)),
  },
  undocked: { ...base, partId: id, otherPartId: id, newVesselIds: array(id, 256) },
  collision: { ...base, otherVesselId: id, relSpeed: f64, partsDestroyed: array(id, 4096) },
  helmChanged: { ...base, accountId: nullable(id), callsign: nullable(id), craftId: id },
  commandResult: { ...base, cmdId: uint, ok: bool, appliedTick: tick, reason: opt(text) },
  claimLost: { ...base, otherVesselId: id, offer: nullable(timeOffer) },
  proximityWarning: { ...base, otherVesselId: id, timeToClosest: f64, distance: f64, relSpeed: f64 },
  padReleased: { ...base, siteId: id, padId: id, reason: enumOf(['cleared', 'rolledBack', 'safed'] as const) },
  clockChanged: { ...base, clockId: nullable(id), rate: f64, reason: nullable(text) },
  rangeClearing: { ...base, otherVesselId: id, active: bool },
});
