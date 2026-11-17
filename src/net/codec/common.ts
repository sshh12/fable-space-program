/**
 * Codecs of the parts the messages share: vectors, controls, targets, clocks and the view models of the
 * lead's section of net.ts (ARCHITECTURE 5.2, 23, 25), the rules document, seats and subscriptions.
 *
 * Each `enumOf` list below is exhaustive over its type, checked at compile time (`exhaustive`): a member
 * added to a contract union fails to compile here until it has a wire code. Lists are append-only: the
 * index is the code.
 */
import type { SasMode, SasTargetMode } from '@/core/contracts/controls';
import type {
  AssemblyCraftView,
  AssemblyView,
  ClockKind,
  ClockMember,
  ClockState,
  Conjunction,
  ExpiryView,
  FeedEvent,
  LendPolicy,
  PadClass,
  PadState,
  Prompt,
  RosterEntry,
  ShipRecord,
  TargetRef,
  TimeLimit,
  TimeLimitKind,
  TimeOffer,
  TimeProposal,
  UniverseRules,
  WireBlob,
  WireControls,
  WireControlState,
} from '@/core/contracts/net';
import type { Presence } from '@/core/contracts/net';
import type { SeatResult, SpawnRequest, SpawnSlot, Subscriptions } from '@/core/contracts/session';
import type { Quat } from '@/core/math/quat';
import type { Vec3 } from '@/core/math/vec3';
import type { ByteReader, ByteWriter } from './bytes';
import { WireEncodeError } from './bytes';
import {
  array,
  axis8,
  blob,
  bool,
  enumOf,
  f32,
  f64,
  id,
  nullable,
  opt,
  struct,
  text,
  tick,
  u8,
  uint,
  union,
  type Codec,
  type Gen,
} from './schema';

/** Compile-time check that a list names every member of a union: `exhaustive<U>()(list)`. */
export function exhaustive<U extends string>() {
  return <L extends readonly U[]>(list: L & ([Exclude<U, L[number]>] extends [never] ? unknown : { missing: Exclude<U, L[number]> })): readonly U[] => list;
}

// ------------------------------------------------------------------------------------------- geometry

export const vec3: Codec<Vec3> = struct<Vec3>({ x: f64, y: f64, z: f64 });
export const vec3f32: Codec<Vec3> = struct<Vec3>({ x: f32, y: f32, z: f32 });
export const quat64: Codec<Quat> = struct<Quat>({ x: f64, y: f64, z: f64, w: f64 });
export const quat32: Codec<Quat> = struct<Quat>({ x: f32, y: f32, z: f32, w: f32 });

// -------------------------------------------------------------------------------------------- handles

/** A string written as a handle of the writer's string table. */
export const handle: Codec<string> = {
  min: 1,
  write(w, v) {
    if (typeof v !== 'string') throw new WireEncodeError(`handle: ${String(v)} is not a string`);
    if (!w.table) throw new WireEncodeError('handle: the writer has no string table');
    w.varUint(w.table.handleOf(v));
  },
  read(r) {
    const h = r.varUint();
    if (r.failed) return '';
    const s = r.table?.lookup(h);
    if (s === undefined) {
      r.fail('unknownHandle');
      return '';
    }
    return s;
  },
  random: (g) => g.str(10),
};

/** A nullable string as a handle, 0 standing for null (one byte cheaper than a flag). */
export const handleOrNull: Codec<string | null> = {
  min: 1,
  write(w, v) {
    if (v === null) w.varUint(0);
    else handle.write(w, v);
  },
  read(r) {
    const h = r.varUint();
    if (r.failed || h === 0) return null;
    const s = r.table?.lookup(h);
    if (s === undefined) {
      r.fail('unknownHandle');
      return null;
    }
    return s;
  },
  random: (g) => (g.chance(0.3) ? null : g.str(10)),
};

// ------------------------------------------------------------------------------------------- controls

/** Every SAS mode, with the v2 target modes (which join `SasMode` in sub-wave 3.2). */
export const SAS_MODE_LIST = exhaustive<SasMode | SasTargetMode>()([
  'stability',
  'prograde',
  'retrograde',
  'normal',
  'antinormal',
  'radialOut',
  'radialIn',
  'maneuver',
  'target',
  'antiTarget',
  'portAlign',
] as const);
export const sasMode = enumOf<SasMode | SasTargetMode>(SAS_MODE_LIST);

const unitF32: Codec<Vec3> = vec3f32;

/** The seven control bytes: throttle u8, then pitch, yaw, roll, tx, ty, tz as -127..127. */
export function writeControls(w: ByteWriter, c: WireControls): void {
  u8.write(w, c.throttle);
  axis8.write(w, c.pitch);
  axis8.write(w, c.yaw);
  axis8.write(w, c.roll);
  axis8.write(w, c.tx);
  axis8.write(w, c.ty);
  axis8.write(w, c.tz);
}

export function readControls(r: ByteReader, out: WireControls): void {
  out.throttle = r.u8();
  out.pitch = axis8.read(r);
  out.yaw = axis8.read(r);
  out.roll = axis8.read(r);
  out.tx = axis8.read(r);
  out.ty = axis8.read(r);
  out.tz = axis8.read(r);
}

export function randomControls(g: Gen): WireControls {
  return { throttle: g.int(0, 255), pitch: g.int(-127, 127), yaw: g.int(-127, 127), roll: g.int(-127, 127), tx: g.int(-127, 127), ty: g.int(-127, 127), tz: g.int(-127, 127) };
}

const CS_SAS = 1;
const CS_RCS = 2;
const CS_FINE = 4;
const CS_HOLD = 8;

/** Applied control state: the control bytes, a flag byte (SAS, RCS, fine, hold present), the SAS mode, the hold vector. */
export const controlState: Codec<WireControlState> = {
  min: 9,
  write(w, v) {
    writeControls(w, v);
    w.u8((v.sasEnabled ? CS_SAS : 0) | (v.rcsEnabled ? CS_RCS : 0) | (v.fineControl ? CS_FINE : 0) | (v.sasHold ? CS_HOLD : 0));
    sasMode.write(w, v.sasMode);
    if (v.sasHold) unitF32.write(w, v.sasHold);
  },
  read(r) {
    const out = {} as WireControlState;
    readControlStateInto(r, out);
    return out;
  },
  random(g) {
    return { ...randomControls(g), sasEnabled: g.chance(0.5), rcsEnabled: g.chance(0.5), fineControl: g.chance(0.5), sasMode: g.pick(SAS_MODE_LIST), sasHold: g.chance(0.5) ? unitF32.random(g) : null };
  },
};

/** Read a control state into an existing object (no allocation when it already holds a hold vector). */
export function readControlStateInto(r: ByteReader, out: WireControlState): void {
  readControls(r, out);
  const flags = r.u8();
  if (flags > 15) r.fail('badEnum');
  out.sasEnabled = (flags & CS_SAS) !== 0;
  out.rcsEnabled = (flags & CS_RCS) !== 0;
  out.fineControl = (flags & CS_FINE) !== 0;
  out.sasMode = sasMode.read(r);
  if (flags & CS_HOLD) {
    const h = out.sasHold ?? { x: 0, y: 0, z: 0 };
    h.x = r.finiteF32();
    h.y = r.finiteF32();
    h.z = r.finiteF32();
    out.sasHold = h;
  } else out.sasHold = null;
}

// ------------------------------------------------------------------------------------------- blobs

/** Largest blob a message carries (an island state, a vessel). */
export const MAX_BLOB_BYTES = 6 * 1024 * 1024;

export const wireBlob: Codec<WireBlob> = {
  min: 3,
  write(w, v) {
    if (v.encoding !== 'raw' && v.encoding !== 'deflate-raw') throw new WireEncodeError('blob: unknown encoding');
    if (v.encoding === 'raw' && v.rawLength !== v.bytes.length) throw new WireEncodeError('blob: a raw blob has rawLength = bytes.length');
    w.u8(v.encoding === 'raw' ? 0 : 1);
    if (v.encoding === 'deflate-raw') uint.write(w, v.rawLength);
    blob(MAX_BLOB_BYTES).write(w, v.bytes);
  },
  read(r) {
    const e = r.u8();
    if (e > 1) {
      r.fail('badEnum');
      return { encoding: 'raw', rawLength: 0, bytes: new Uint8Array(0) };
    }
    const rawLength = e === 1 ? r.varUint() : -1;
    const bytes = r.blob(MAX_BLOB_BYTES);
    if (e === 1 && rawLength > MAX_BLOB_BYTES * 16) r.fail('badLength');
    return { encoding: e === 0 ? 'raw' : 'deflate-raw', rawLength: e === 0 ? bytes.length : rawLength, bytes };
  },
  random(g) {
    const bytes = blob(64).random(g);
    return g.chance(0.5) ? { encoding: 'raw', rawLength: bytes.length, bytes } : { encoding: 'deflate-raw', rawLength: g.int(0, 100000), bytes };
  },
};

// --------------------------------------------------------------------------------------------- targets

export const targetRef: Codec<TargetRef> = union<TargetRef, 'kind'>('kind', {
  body: { id },
  vessel: { id },
  port: { vesselId: id, portId: id },
});

// ---------------------------------------------------------------------------------------------- policy

const helmPolicy: Codec<LendPolicy['helm']> = {
  min: 1,
  write(w, v) {
    if (v === 'owner') w.u8(0);
    else if (v === 'crew') w.u8(1);
    else {
      w.u8(2);
      array(id, 256).write(w, v);
    }
  },
  read(r) {
    const k = r.u8();
    if (k === 0) return 'owner';
    if (k === 1) return 'crew';
    if (k !== 2) {
      r.fail('badEnum');
      return 'owner';
    }
    return array(id, 256).read(r);
  },
  random: (g) => (g.chance(0.33) ? 'owner' : g.chance(0.5) ? 'crew' : array(id, 256).random(g)),
};

export const lendPolicy: Codec<LendPolicy> = struct<LendPolicy>({ lendAttitude: bool, lendEngines: bool, lendPropellant: bool, helm: helmPolicy });
export const lendPolicyPatch: Codec<Partial<LendPolicy>> = struct<Partial<LendPolicy>>({
  lendAttitude: opt(bool),
  lendEngines: opt(bool),
  lendPropellant: opt(bool),
  helm: opt(helmPolicy),
});

// ---------------------------------------------------------------------------------------------- clocks

const CLOCK_KINDS = exhaustive<ClockKind>()(['live', 'cohort', 'private', 'shared'] as const);
const LIMIT_KINDS = exhaustive<TimeLimitKind>()(['physics', 'altitude', 'launchRange', 'event', 'encounter', 'members', 'carryLimit', 'leadCap', 'held'] as const);

export const timeLimit: Codec<TimeLimit> = struct<TimeLimit>({
  kind: enumOf(LIMIT_KINDS),
  text,
  vesselIds: array(id, 64),
  accountIds: array(id, 64),
});

export const clockMember: Codec<ClockMember> = struct<ClockMember>({
  accountId: id,
  callsign: id,
  vesselId: id,
  bound: bool,
  requestedRate: f64,
  accepted: bool,
  idle: bool,
});

export const timeProposal: Codec<TimeProposal> = struct<TimeProposal>({
  id,
  kind: enumOf(['rate', 'advance'] as const),
  fromAccountId: id,
  fromCallsign: id,
  rate: nullable(f64),
  toTick: nullable(tick),
  expiresUpMs: f64,
});

export const clockState: Codec<ClockState> = struct<ClockState>({
  id,
  kind: enumOf(CLOCK_KINDS),
  tick0: tick,
  anchorUpMs: f64,
  rate: f64,
  untilTick: nullable(tick),
  limitedBy: nullable(timeLimit),
  members: array(clockMember, 256),
  proposals: array(timeProposal, 64),
});

export const timeOffer: Codec<TimeOffer> = union<TimeOffer, 'kind'>('kind', {
  jump: { toTick: tick, toClockId: nullable(id), vesselId: nullable(id), inPhase: bool, label: text },
  hold: { label: text },
  askAdvance: { vesselId: id, label: text },
  meet: { accountId: id, atTick: tick, label: text },
  link: { accountId: id, label: text },
  follow: { accountId: id, label: text },
  rejoin: { toTick: tick, label: text },
});

export const conjunction: Codec<Conjunction> = struct<Conjunction>({
  otherVesselId: id,
  tick,
  distance: f64,
  relSpeed: f64,
  severity: enumOf(['encounter', 'warning'] as const),
});

// ----------------------------------------------------------------------------------------- view models

export const PAD_CLASSES = exhaustive<PadClass>()(['light', 'medium', 'heavy'] as const);
export const padClass = enumOf<PadClass>(PAD_CLASSES);

export const padState: Codec<PadState> = struct<PadState>({
  siteId: id,
  padId: id,
  class: padClass,
  state: enumOf(['free', 'reserved', 'occupied', 'safing', 'closed'] as const),
  accountId: nullable(id),
  callsign: nullable(id),
  vesselId: nullable(id),
  freeAtTick: nullable(tick),
  nextLiveTick: nullable(tick),
  nextCohortTick: nullable(tick),
});

export const expiryView: Codec<ExpiryView> = struct<ExpiryView>({ atWallMs: nullable(f64), rule: id, reasonText: text, protectedBy: nullable(id) });

const PRESENCES = exhaustive<Presence>()(['solid', 'recordedEcho', 'projectedEcho'] as const);

export const shipRecord: Codec<ShipRecord> = struct<ShipRecord>({
  craftId: id,
  vesselId: id,
  name: text,
  vehicleId: id,
  isAssembly: bool,
  members: array(id, 64),
  situation: text,
  bodyId: id,
  orbit: nullable(struct<NonNullable<ShipRecord['orbit']>>({ apoapsisAltitude: f64, periapsisAltitude: f64, inclination: f64 })),
  surface: nullable(struct<NonNullable<ShipRecord['surface']>>({ latitude: f64, longitude: f64 })),
  crew: uint,
  deltaVRemaining: f64,
  lastFlownWallMs: f64,
  expiry: expiryView,
  nodesSaved: uint,
  sessionState: enumOf(['idle', 'flownHere', 'flownElsewhere', 'flownByOther'] as const),
  flownBy: nullable(id),
  headTick: tick,
  presence: enumOf(PRESENCES),
});

type PortView = AssemblyCraftView['ports'][number];
const portView: Codec<PortView> = struct<PortView>({
  portId: id,
  portType: id,
  state: enumOf(['disabled', 'ready', 'occupied', 'soft', 'hard', 'cooldown'] as const),
  armed: bool,
  peerCraftId: nullable(id),
});

export const assemblyCraftView: Codec<AssemblyCraftView> = struct<AssemblyCraftView>({
  craftId: id,
  name: text,
  vehicleId: id,
  ownerId: nullable(id),
  ownerCallsign: nullable(id),
  attended: bool,
  seniority: uint,
  policy: lendPolicy,
  ports: array(portView, 64),
});

type HelmView = AssemblyView['helm'];
export const assemblyView: Codec<AssemblyView> = struct<AssemblyView>({
  vesselId: id,
  crafts: array(assemblyCraftView, 64),
  links: array(struct<{ a: string; b: string }>({ a: id, b: id }), 128),
  anchorCraftId: id,
  helm: struct<HelmView>({
    accountId: nullable(id),
    callsign: nullable(id),
    craftId: id,
    request: nullable(struct<NonNullable<HelmView['request']>>({ fromAccountId: id, fromCallsign: id, expiresUpMs: f64 })),
  }),
});

export const rosterEntry: Codec<RosterEntry> = struct<RosterEntry>({
  accountId: id,
  callsign: id,
  relation: enumOf(['nearby', 'docked', 'lobby'] as const),
  vesselId: nullable(id),
  bodyId: nullable(id),
  timeOffset: tick,
  linked: bool,
  blocked: bool,
});

const FEED_KINDS = exhaustive<FeedEvent['kind']>()(['launch', 'orbit', 'docked', 'undocked', 'collision', 'landing', 'splashdown', 'removed', 'rules', 'notice', 'quick'] as const);
export const feedEvent: Codec<FeedEvent> = struct<FeedEvent>({
  id,
  wallMs: f64,
  tick: nullable(tick),
  kind: enumOf(FEED_KINDS),
  text,
  vesselIds: array(id, 32),
  callsigns: array(id, 32),
  provisional: bool,
});

const PROMPT_KINDS = exhaustive<Prompt['kind']>()(['warpProposal', 'advanceRequest', 'helmRequest', 'meet', 'link', 'abandonChoice', 'notice'] as const);
export const prompt: Codec<Prompt> = struct<Prompt>({
  id,
  kind: enumOf(PROMPT_KINDS),
  fromCallsign: nullable(id),
  text,
  expiresUpMs: nullable(f64),
  onExpire: enumOf(['accept', 'decline', 'none'] as const),
});

// ----------------------------------------------------------------------------------- seats, subscriptions

export const spawnSlot: Codec<SpawnSlot> = union<SpawnSlot, 'kind'>('kind', {
  live: {},
  cohort: { tick },
  clock: { clockId: id },
});

export const spawnRequest: Codec<SpawnRequest> = struct<SpawnRequest>({ vehicleId: id, site: id, pad: id, slot: spawnSlot, name: text });

type SeatAlternative = Extract<SeatResult, { ok: false }>['alternative'];
const seatAlternative: Codec<SeatAlternative> = {
  min: 1,
  write(w, v) {
    if (v === null) w.u8(0);
    else if ('clockId' in v) {
      w.u8(1);
      id.write(w, v.clockId);
    } else {
      w.u8(2);
      id.write(w, v.site);
      id.write(w, v.pad);
      spawnSlot.write(w, v.slot);
    }
  },
  read(r) {
    const k = r.u8();
    if (k === 0) return null;
    if (k === 1) return { clockId: id.read(r) };
    if (k === 2) return { site: id.read(r), pad: id.read(r), slot: spawnSlot.read(r) };
    r.fail('badEnum');
    return null;
  },
  random(g) {
    const k = g.int(0, 2);
    if (k === 0) return null;
    if (k === 1) return { clockId: g.str(8) };
    return { site: g.str(8), pad: g.str(4), slot: spawnSlot.random(g) };
  },
};

export const seatResult: Codec<SeatResult> = {
  min: 2,
  write(w, v) {
    if (v.ok) {
      w.u8(1);
      id.write(w, v.vesselId);
      nullable(id).write(w, v.clockId);
    } else {
      w.u8(0);
      text.write(w, v.reason);
      seatAlternative.write(w, v.alternative);
    }
  },
  read(r) {
    const ok = r.u8();
    if (ok === 1) return { ok: true, vesselId: id.read(r), clockId: nullable(id).read(r) };
    if (ok !== 0) r.fail('badEnum');
    return { ok: false, reason: text.read(r), alternative: seatAlternative.read(r) };
  },
  random: (g) => (g.chance(0.5) ? { ok: true, vesselId: g.str(10), clockId: g.chance(0.3) ? null : g.str(6) } : { ok: false, reason: g.str(20), alternative: seatAlternative.random(g) }),
};

type RosterSub = NonNullable<Subscriptions['roster']>;
export const subscriptions: Codec<Subscriptions> = struct<Subscriptions>({
  censusBodies: opt(array(id, 64)),
  relevantDistance: opt(f64),
  padSites: opt(array(id, 64)),
  roster: opt(nullable(struct<RosterSub>({ filter: enumOf(['nearby', 'docked', 'lobby'] as const), cursor: nullable(id) }))),
  worldlineOf: opt(nullable(id)),
});

// ----------------------------------------------------------------------------------------------- rules

type R = UniverseRules;
type PadLimits = R['pads']['classLimits']['light'];
const perClassNumber: Codec<Record<PadClass, number>> = struct<Record<PadClass, number>>({ light: f64, medium: f64, heavy: f64 });
const padLimits: Codec<PadLimits> = struct<PadLimits>({ maxLiftoffMass: f64, maxDiameter: f64 });
const perClassLimits: Codec<Record<PadClass, PadLimits>> = struct<Record<PadClass, PadLimits>>({ light: padLimits, medium: padLimits, heavy: padLimits });

/** The rules document, field by field (a field added to `UniverseRules` fails to compile here until it is added). */
export const universeRules: Codec<UniverseRules> = struct<R>({
  id,
  version: uint,
  effectiveWallMs: f64,
  time: struct<R['time']>({
    leadCap: f64,
    advanceGuardBand: f64,
    advanceLimitDefault: f64,
    advanceLimitStation: f64,
    physicsWarpMax: f64,
    launchRangeRadius: f64,
    launchRangeAltitude: f64,
    encounterLeadTime: f64,
    encounterMargin: f64,
    targetApproachSteps: array(struct<{ timeBefore: number; maxRate: number }>({ timeBefore: f64, maxRate: f64 }), 32),
    readyCheckTime: f64,
    openProposalsPerClock: f64,
    proposalInterval: f64,
    idleTime: f64,
    stopWindow: f64,
    roundTripAllowance: f64,
    jumpArrivalClearance: f64,
    jumpArrivalLookahead: f64,
    jumpAlternativeLead: f64,
    advanceRetryInterval: f64,
    openAdvanceRequestsPerGroup: f64,
    departureContactLookahead: f64,
    departureNoticeTime: f64,
    forecastMaxPatches: f64,
    joinCooldown: f64,
    joinCooldownAfterFork: f64,
    resumeWindow: f64,
    resumeWindowBuildChange: f64,
    cohortBucket: f64,
    cohortHorizon: f64,
    cohortOfferWait: f64,
    lagCap: f64,
  }),
  claim: struct<R['claim']>({
    joinDistanceBase: f64,
    joinClosingTime: f64,
    islandPartFactor: f64,
    armedMarginBase: f64,
    armedClosingTime: f64,
    reservationReleaseDelay: f64,
    materialiseReachTime: f64,
    materialiseClearance: f64,
    clearingTime: f64,
    clearingAccelMax: f64,
    clearingTimeout: f64,
  }),
  disconnect: struct<R['disconnect']>({
    pingInterval: f64,
    lossTimeout: f64,
    soloLatchTime: f64,
    sharedRotationLatch: f64,
    sharedThrottleLatch: f64,
    reconnectGrace: f64,
  }),
  contact: struct<R['contact']>({
    subSteps: f64,
    solverIterations: f64,
    restitution: f64,
    restitutionMinSpeed: f64,
    friction: f64,
    speculativeTravelFraction: f64,
    nascentClearance: f64,
    hypervelocitySpeed: f64,
    hypervelocitySpecificEnergy: f64,
    explosionImpulsePerKg: f64,
    maxFragmentsPerCollision: f64,
    fragmentMassLimit: f64,
    fragmentLifetime: f64,
    defaultCrashTolerance: f64,
  }),
  docking: struct<R['docking']>({
    hardDockOffset: f64,
    hardDockAngleDeg: f64,
    hardDockSpeed: f64,
    hardDockDwell: f64,
    softCaptureClampTime: f64,
    linkBreakTime: f64,
    portCooldownTime: f64,
    portCooldownDistance: f64,
    helmRequestTimeout: f64,
    defaultLendPolicy: lendPolicy,
    maxCraftPerAssembly: f64,
    maxPartsPerAssembly: f64,
    islandVesselBudget: f64,
  }),
  terrain: struct<R['terrain']>({ requestRadarAltitude: f64, requestAltitude: f64, requestSpeed: f64 }),
  pads: struct<R['pads']>({
    reservationHold: f64,
    maxStay: f64,
    stayExtension: f64,
    maxStayUpTime: f64,
    disconnectGrace: f64,
    clearAltitude: f64,
    clearDistance: f64,
    safingTime: f64,
    keepOutRadius: perClassNumber,
    classLimits: perClassLimits,
    restRecoveryTime: f64,
    rangeSafetyAltitude: f64,
  }),
  expiry: struct<R['expiry']>({
    craftRetention: f64,
    shipSlots: f64,
    unownedAssemblyRetention: f64,
    unownedCraftRetention: f64,
    debrisRetention: f64,
    debrisPerAccount: f64,
    unownedPerSoi: f64,
    wreckRetention: f64,
    lostDistance: f64,
    arcRetention: f64,
    accountRetention: f64,
    lobbyObjectCap: f64,
    pressureStart: f64,
    pressureFloorSingleSession: f64,
    pressureFloor: f64,
    sweepInterval: f64,
    outageExtensionThreshold: f64,
  }),
  limits: struct<R['limits']>({
    inputsPerSecond: f64,
    commandsPerSecond: f64,
    timeMessages: f64,
    timeMessageWindow: f64,
    subscriptionsPerSecond: f64,
    accountsPerAddressPerHour: f64,
  }),
  planning: struct<R['planning']>({ workerMaxEstimateMs: f64, weakClientCpuScore: nullable(f64) }),
});
