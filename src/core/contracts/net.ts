/**
 * Types shared by the universe (src/universe), the servers, the network client and the menu: the rules
 * document, the clock and time view, census entries, targets and the view models of the shell
 * (docs/ARCHITECTURE.md sections 5, 13, 15.5, 23, 26).
 *
 * This file has two sections with different owners:
 *  1. Everything below up to the marker "WIRE MESSAGES": written by the lead (step 3.0 of MIGRATION_V2).
 *  2. The wire-message section (every message of ARCHITECTURE 13.3, `InputAck` included): written and owned
 *     by the `wire-protocol` package from wave 4. It does not exist yet, on purpose.
 *
 * Time. The canonical universe time is the TICK: an integer count of 1/120 s since J2000.0, carried in a
 * float64 (ARCHITECTURE section 3). `ut = tick / TICKS_PER_SECOND` is derived. Every timer in the game runs
 * on exactly one of three bases, and every duration in `UniverseRules` names its base in
 * `UNIVERSE_RULE_TIMERS`:
 *   'ticks'   universe ticks of the clock the thing is on; stops when that clock stops
 *   'upTime'  directory up-time (the persisted counter behind the live clock); frozen while the universe is down
 *   'wall'    the wall clock; expiry only
 * Rule documents state durations in SECONDS whatever their base; the engine converts a 'ticks' duration with
 * TICKS_PER_SECOND.
 *
 * JSON. Every type of this file travels as JSON (the rules document, the public census, the stores of a
 * test). JSON has no Infinity and no NaN (JSON.stringify writes both as null), so NO FIELD HERE IS EVER
 * INFINITE OR NaN: "no such tick" is `null`, stated on the field (`ClockState.untilTick`,
 * `CensusEntry.horizonTick`, `.limitTick`). A value read back from JSON is then the value that was written.
 */
import type { ConicElements } from '../math/conic';
import type { BodyId, SiteId, VehicleId } from './defs';

/** Ticks per second of universe time (1 / PHYSICS_DT). */
export const TICKS_PER_SECOND = 120;

/** Seconds in a day and in a Julian year, for the defaults below. */
const DAY = 86400;
const YEAR = 365.25 * DAY;
/** One astronomical unit, m. */
const AU = 149_597_870_700;

export type TimerBase = 'ticks' | 'upTime' | 'wall';

/** Pad classes; a pad hosts its class and anything smaller. */
export type PadClass = 'light' | 'medium' | 'heavy';

/** The largest vehicle a pad of one class takes (ARCHITECTURE 9.3). Both are positive finite numbers. */
export interface PadClassLimits {
  /** Largest lift-off mass, kg. */
  maxLiftoffMass: number;
  /** Largest stack diameter, m. */
  maxDiameter: number;
}

// ------------------------------------------------------------------------------------------------- rules

/**
 * The lend policy of a craft inside an assembly (ARCHITECTURE 7.5): what the helm may use of it.
 * `helm`: who may take the helm of an assembly this craft anchors: its owner only, anyone aboard, or the
 * listed account ids.
 */
export interface LendPolicy {
  lendAttitude: boolean;
  lendEngines: boolean;
  lendPropellant: boolean;
  helm: 'owner' | 'crew' | string[];
}

/**
 * One versioned document of every tunable number of the shared universe: the time model (ARCHITECTURE 5),
 * contact and docking (7.4-7.6), pads (9.4), expiry (15.5) and the per-account bounds (26). Served to
 * clients, which render the rules screen and every countdown from it; nothing in the engine states one of
 * these numbers. Documents live in data/defs/rules/<id>.json (`default` = production, `staging` = lifetimes
 * of minutes, `local` = offline play and tests); DEFAULT_UNIVERSE_RULES below is the `default` document.
 * A rules file is stored as OVERRIDES of the default document: it states its id, its version and the
 * fields in which it differs, and the library holds the complete document (the default with the file's
 * values over it), so a field this contract gains is the default's value in every document without a
 * change to a file. A file may state only fields of this interface. (Until the loader reads files that way
 * it holds each file to every field of the default document; see `DEFAULT_PAD_CLASS_LIMITS`.)
 *
 * Units: seconds, metres, m/s, kg unless a name says otherwise. The timer base of every duration is in
 * UNIVERSE_RULE_TIMERS (same paths).
 */
export interface UniverseRules {
  /** Document id (the file name) and a version that increases with every published change. */
  id: string;
  version: number;
  /** When this version took effect, ms since the Unix epoch (shown as "rules changed on ..."); 0 = with the lobby. */
  effectiveWallMs: number;

  /** Clocks, warp and everything about time (ARCHITECTURE 5.2, 5.3). */
  time: {
    /** U17: no clock runs further ahead of the live clock than this. Default 250 years. */
    leadCap: number;
    /** U2: a claim never carries another owner's craft past `liveTick + leadCap - advanceGuardBand`. Default 20 years. */
    advanceGuardBand: number;
    /** U2: how far ahead of the live clock a visitor may take an owned craft by default. Default 30 days. */
    advanceLimitDefault: number;
    /** U2: the same for a craft its owner has marked as a station module. Default 6 years. */
    advanceLimitStation: number;
    /** U6: highest warp while anything on the clock is integrated (load-aware; an index-free factor). Default 4. */
    physicsWarpMax: number;
    /** U6: inside a launch range (this ground distance from a site and below this altitude) a clock runs at 1x. Defaults 150 km, 100 km. */
    launchRangeRadius: number;
    launchRangeAltitude: number;
    /** U6 / U10: a clock is at 1x from this long before a screened encounter. Default 10 s. */
    encounterLeadTime: number;
    /** U10 / U11: a predicted miss below `Ra + Rb + encounterMargin` is an encounter (a predicted contact). Default 10 m. */
    encounterMargin: number;
    /** U6: warp steps down before the selected target's closest approach: at most `maxRate` from `timeBefore` s before it. Defaults 50x at 60 s, 1x at 10 s. */
    targetApproachSteps: { timeBefore: number; maxRate: number }[];
    /** U6: a rate change above 1x on a shared clock is a proposal with a ready-check this long. Default 15 s. */
    readyCheckTime: number;
    /** U6 / 26: open proposals per clock, and the shortest time between two proposals of one account. Defaults 1, 30 s. */
    openProposalsPerClock: number;
    proposalInterval: number;
    /** U6: a bound member without input for this long (vessel quiescent or docked) does not block a proposal. Default 120 s. */
    idleTime: number;
    /** U7: above `physicsWarpMax` the committed head trails the schedule by this much, so a stop lands where it was seen. Default 0.5 s. */
    stopWindow: number;
    /** U10 / 26: one round trip; stamps beyond `clock(up) + roundTripAllowance` are dropped, and `untilTick` is never shortened inside `stopWindow + roundTripAllowance`. Default 0.25 s. */
    roundTripAllowance: number;
    /** U8: a jump is refused when its arrival approaches within `Ra + Rb + jumpArrivalClearance` during `jumpArrivalLookahead`. Defaults 50 m, 30 s. */
    jumpArrivalClearance: number;
    jumpArrivalLookahead: number;
    /** U8: the alternative offered with a refused jump is this long before the first encounter. Default 10 s. */
    jumpAlternativeLead: number;
    /** U9 / 26: after a refusal the same account may ask the same group to advance again after this long; open requests per group. Defaults 300 s, 1. */
    advanceRetryInterval: number;
    openAdvanceRequestsPerGroup: number;
    /** U11: a departure is blocked only by contact, soft capture, a dock, or a contact predicted within this time; the others see a notice this long. Defaults 30 s, 10 s. */
    departureContactLookahead: number;
    departureNoticeTime: number;
    /** U14: longest forecast chain the directory computes for a passive vessel, in patches. Default 16. */
    forecastMaxPatches: number;
    /** 5.2: cooldown before an account may join an attended clock again without a link, and the longer one for a clock whose host forked away from it. Defaults 60 s, 30 min. */
    joinCooldown: number;
    joinCooldownAfterFork: number;
    /** 5.2 / 15.4: how long the live clock is held after a restart on the same build, and when the build changed. Defaults 30 s, 90 s. */
    resumeWindow: number;
    resumeWindowBuildChange: number;
    /** 5.9: width of a cohort bucket (the lead step of cohort clocks) and how far ahead cohort slots are offered. Defaults 5 min, 14 days. */
    cohortBucket: number;
    cohortHorizon: number;
    /** 5.9: the menu offers a cohort slot when the wait for a live pad of the class exceeds this. Default 60 s. */
    cohortOfferWait: number;
    /** 6.2: how far a single-owner island may trail its pilot (the commit lag cap). 0 in the first release. */
    lagCap: number;
  };

  /** Claiming a passive vessel and materialising beside one (ARCHITECTURE U4, U5, 7.3). */
  claim: {
    /** U4 / 7.3: join distance = `joinDistanceBase + joinClosingTime x closing speed`; islands part at `islandPartFactor` times it. Defaults 1 km, 2 s, 2. */
    joinDistanceBase: number;
    joinClosingTime: number;
    islandPartFactor: number;
    /** U4: armed margin = `armedMarginBase + armedClosingTime x closing speed`; the reservation is taken before a copy leaves it. Defaults 200 m, 2 s. */
    armedMarginBase: number;
    armedClosingTime: number;
    /** U4: an uncommitted reservation ends when the vessel has been outside the armed margin this long. Default 10 s. */
    reservationReleaseDelay: number;
    /** U5: contact and capture are off against anything a materialising vessel overlaps or would reach ballistically within this time. Default 30 s. */
    materialiseReachTime: number;
    /** U5: ... until the two have first been `Ra + Rb + materialiseClearance` apart. Default 5 m. */
    materialiseClearance: number;
    /** U5: the later vessel is pushed clear in `clearingTime` with at most `clearingAccelMax`, and recovered after `clearingTimeout`. Defaults 15 s, 0.5 m/s^2, 30 s. */
    clearingTime: number;
    clearingAccelMax: number;
    clearingTimeout: number;
  };

  /** Loss of a socket and leaving (ARCHITECTURE U16). */
  disconnect: {
    /** A socket is lost when no frame arrived for `lossTimeout` on a ping every `pingInterval`. Defaults 3 s, 1 s. */
    pingInterval: number;
    lossTimeout: number;
    /** Solo island: controls stay latched this long, then rotation is zeroed and the throttle closed. Default 10 s. */
    soloLatchTime: number;
    /** Island with another owner's vessel, or the helm of a crewed assembly: rotation and translation zero after `sharedRotationLatch`, throttle closed after `sharedThrottleLatch`. Defaults 0.25 s, 2 s. */
    sharedRotationLatch: number;
    sharedThrottleLatch: number;
    /** The server carries the vessel for its pilot (and keeps a helm seat) this long. Default 120 s. */
    reconnectGrace: number;
  };

  /** Contact, collisions and damage (ARCHITECTURE 7.4). */
  contact: {
    /** Sub-steps per tick of the contact path (4 = 480 Hz) and sequential-impulse iterations. Defaults 4, 8. */
    subSteps: number;
    solverIterations: number;
    /** Restitution above `restitutionMinSpeed` normal closing speed, and the friction coefficient between vessels. Defaults 0.2, 0.3 m/s, 0.5. */
    restitution: number;
    restitutionMinSpeed: number;
    friction: number;
    /** A pair is slow (speculative contacts) while its relative travel per step is below this fraction of the thinnest collider. Default 0.25. */
    speculativeTravelFraction: number;
    /** Vessels born by one split, or just undocked, ignore each other until their colliders were first this far apart. Default 0.05 m. */
    nascentClearance: number;
    /** Above this normal closing speed there is no rigid solve (hypervelocity regime); this specific energy destroys both parts. Defaults 250 m/s, 40 kJ/kg. */
    hypervelocitySpeed: number;
    hypervelocitySpecificEnergy: number;
    /** Impulse an exploding part gives per kg of its propellant, shared by area over the vessels in reach. Default 150 N s/kg. */
    explosionImpulsePerKg: number;
    /** New vessels one collision may create; fragments lighter than `fragmentMassLimit` live `fragmentLifetime`. Defaults 12, 50 kg, 60 s. */
    maxFragmentsPerCollision: number;
    fragmentMassLimit: number;
    fragmentLifetime: number;
    /**
     * Crash tolerance of a part that states none and has no contact points to take one from: normal closing
     * speed above which a vessel-to-vessel contact destroys it. Default 6 m/s (the value of the stack's
     * structural contact points).
     */
    defaultCrashTolerance: number;
  };

  /** Docking, assemblies and the helm (ARCHITECTURE 7.2, 7.5). Port geometry and envelopes are part data. */
  docking: {
    /** Hard dock once offset, angle and relative speed stayed below these for `hardDockDwell`. Defaults 3 mm, 0.1 deg, 3 mm/s, 0.5 s. */
    hardDockOffset: number;
    hardDockAngleDeg: number;
    hardDockSpeed: number;
    hardDockDwell: number;
    /** Soft capture lets go when its force or torque was clamped this long (the port's own `soft.timeout` bounds the whole capture). Default 0.5 s. */
    softCaptureClampTime: number;
    /** A docked link breaks when the load to accelerate the lighter side exceeds the port's `hard` limits this long. Default 0.2 s. */
    linkBreakTime: number;
    /** After an undock or a lost capture both ports refuse each other for this long or until this far apart. Defaults 10 s, 1 m. */
    portCooldownTime: number;
    portCooldownDistance: number;
    /** An occupied helm is handed over on acceptance or after this long without helm input. Default 30 s. */
    helmRequestTimeout: number;
    /** Policy of a craft whose owner set none, and of every unowned craft in an assembly. Default: attitude lent, engines and propellant not, helm 'crew'. */
    defaultLendPolicy: LendPolicy;
    /** Hard limits of an assembly: a capture that would exceed them is refused. Defaults 32 craft, 600 parts. */
    maxCraftPerAssembly: number;
    maxPartsPerAssembly: number;
    /** Performance budget of an island (never a refusal: an island above it dilates, U18). Default 64 vessels. */
    islandVesselBudget: number;
  };

  /** When the simulation asks for terrain (ARCHITECTURE 7.6). */
  terrain: {
    /** A disc under a vessel is requested below this radar altitude, or below `requestAltitude` when slower than `requestSpeed`. Defaults 2 km, 50 km, 200 m/s. */
    requestRadarAltitude: number;
    requestAltitude: number;
    requestSpeed: number;
  };

  /** Launch pads (ARCHITECTURE 9.4). */
  pads: {
    /** A pad is held for a player through briefing and transit this long. Default 90 s. */
    reservationHold: number;
    /** Longest stay on a pad, its one extension while engines run, and the up-time cap that can only roll back. Defaults 300 s, 120 s, 600 s. */
    maxStay: number;
    stayExtension: number;
    maxStayUpTime: number;
    /** After a disconnect on the pad the vehicle is rolled back to the hangar after this long. Default 60 s. */
    disconnectGrace: number;
    /** The pad is cleared when the vehicle is above `clearAltitude` and more than `clearDistance` away, or destroyed. Defaults 1,500 m, 1,000 m. */
    clearAltitude: number;
    clearDistance: number;
    /** Safing after clearance; wreckage inside the keep-out radius is removed at its end. Default 20 s. */
    safingTime: number;
    /** Keep-out radius by pad class (a pad's own `keepOutRadius` overrides it). Defaults 300 / 450 / 600 m. */
    keepOutRadius: Record<PadClass, number>;
    /**
     * Largest lift-off mass (kg) and stack diameter (m) by pad class. A pad's own `maxLiftoffMass` and
     * `maxDiameter` (PadDef) override them, each on its own; a spawn is refused at a pad whose limit the
     * vehicle exceeds. Every value is a positive finite number: no class and no pad is without a limit.
     * Defaults: `DEFAULT_PAD_CLASS_LIMITS` (provisional).
     *
     * v2, optional until the lead step that follows the loader reading rules files as overrides of the
     * default: absent = `DEFAULT_PAD_CLASS_LIMITS`, which then becomes this field of the default document.
     */
    classLimits?: Record<PadClass, PadClassLimits>;
    /** Anything at rest inside a keep-out radius is recovered after this long. Default 60 s. */
    restRecoveryTime: number;
    /** Range safety acts on a vehicle below this altitude whose instantaneous impact point enters another pad's keep-out radius. Default 5 km. */
    rangeSafetyAltitude: number;
  };

  /** Expiry and cleanup on the wall clock (ARCHITECTURE 15.5). */
  expiry: {
    /** An owned craft is kept this long after its owner's last session. Default 14 days. */
    craftRetention: number;
    /** Craft per account (craft abandoned while docked count while their assembly exists). Default 10. */
    shipSlots: number;
    /** An assembly without an unexpired owner, and an unowned single craft, are removed after this long. Default 48 h each. */
    unownedAssemblyRetention: number;
    unownedCraftRetention: number;
    /** Debris is kept this long after it left every island; budgets per account and of unowned objects per sphere of influence (oldest first). Defaults 2 h, 24, 5,000. */
    debrisRetention: number;
    debrisPerAccount: number;
    unownedPerSoi: number;
    /** A landed wreck is kept this long. Default 2 h. */
    wreckRetention: number;
    /** A vessel escaping beyond this distance from the root body is removed (reason 'lost'). Default 100 AU. */
    lostDistance: number;
    /** Sampled arcs of worldlines are reduced to their end points after this long. Default 24 h. */
    arcRetention: number;
    /** An account with no ships is deleted after this long without a session. Default 90 days. */
    accountRetention: number;
    /** Passive objects per lobby. Default 50,000. */
    lobbyObjectCap: number;
    /** Pressure rule: above this share of the cap, retention shortens down to these floors (single-session accounts first). Defaults 0.7, 24 h, 72 h. */
    pressureStart: number;
    pressureFloorSingleSession: number;
    pressureFloor: number;
    /** The sweep runs this often. Default 60 s. */
    sweepInterval: number;
    /** U19: an outage longer than this extends every expiry deadline by its length. Default 1 h. */
    outageExtensionThreshold: number;
  };

  /** Bounds per account and per socket at the gateway (ARCHITECTURE 26). */
  limits: {
    /** Inputs and commands accepted per second per socket; the rest is dropped. Defaults 60, 20. */
    inputsPerSecond: number;
    commandsPerSecond: number;
    /** `Time` messages per account inside `timeMessageWindow`. Defaults 6 per 10 s. */
    timeMessages: number;
    timeMessageWindow: number;
    /**
     * `Subscribe` messages accepted per second per socket ("subscription churn"); the rest is dropped.
     * ARCHITECTURE 26 names this bound without a number: the default, 5, is THE LEAD'S CHOICE (the map changes
     * its subscription when it opens, on a focus change and on a zoom across a tier, never more than a few
     * times a second), to be confirmed by the load test.
     */
    subscriptionsPerSecond: number;
    /**
     * Accounts one IP address may create per hour (`X-Real-IP` from the edge). ARCHITECTURE 26 names this bound
     * without a number: the default, 10, is THE LEAD'S CHOICE (a household or a small office behind one
     * address; bulk provisioning for load tests uses the operator token and is not subject to it).
     */
    accountsPerAddressPerHour: number;
  };

  /** Where planning work runs (ARCHITECTURE 6.3). */
  planning: {
    /** The planning worker is used while the estimate is under this; above it (or for a weak client) the API endpoint. Default 50 ms. */
    workerMaxEstimateMs: number;
    /** Clients whose calibration `cpuScore` is below this plan on the server; null until the calibration data of wave 4 sets it (no client is treated as weak). */
    weakClientCpuScore: number | null;
  };
}

/**
 * The default of `UniverseRules.pads.classLimits`: what a pad of each class takes.
 *
 * PROVISIONAL, and the lead's to set from fleet-data's table of the fleet's lift-off masses and diameters
 * (wave 4). The only numbers that come from a vehicle that exists are the heavy class's, which are what
 * data/defs/sites/ka-lae.json states for LC-1: 3,000 t and 9.5 m. 3,000 t leaves 8.7 % over the 2,760 t
 * lunar stack. 9.5 m covers the stack's 9.0 m but is UNDER the 9.56 m opening of LC-1's own launch mount,
 * so the mount takes a wider stack than the class admits: settled with the table. Light and medium are the
 * research's vehicle sheets rounded up (docs/research/v2/fleet-docking.md section 2: Azimuth 60.5 t and
 * 2.2 m, Solstice up to 610.5 t and 6.6 m; 16 % and 15 % over in mass); no vehicle of those classes exists.
 *
 * Why it is not yet a field of DEFAULT_UNIVERSE_RULES: the definitions loader holds every rules file to
 * exactly the fields of that document (src/core/defs/loader.ts, `validateRules`), so a field added there
 * fails the load of the whole library until all three files state it. Once the loader reads rules files as
 * overrides of the default, the lead moves this into `DEFAULT_UNIVERSE_RULES.pads.classLimits` and makes
 * the field required (MIGRATION_V2, lead steps); until then a reader takes
 * `rules.pads.classLimits ?? DEFAULT_PAD_CLASS_LIMITS`.
 */
export const DEFAULT_PAD_CLASS_LIMITS: Readonly<Record<PadClass, PadClassLimits>> = {
  light: { maxLiftoffMass: 70_000, maxDiameter: 2.5 },
  medium: { maxLiftoffMass: 700_000, maxDiameter: 7 },
  heavy: { maxLiftoffMass: 3_000_000, maxDiameter: 9.5 },
};

/** The `default` rules document (production). `staging` and `local` are data files that differ from it. */
export const DEFAULT_UNIVERSE_RULES: UniverseRules = {
  id: 'default',
  version: 1,
  effectiveWallMs: 0,
  time: {
    leadCap: 250 * YEAR,
    advanceGuardBand: 20 * YEAR,
    advanceLimitDefault: 30 * DAY,
    advanceLimitStation: 6 * YEAR,
    physicsWarpMax: 4,
    launchRangeRadius: 150_000,
    launchRangeAltitude: 100_000,
    encounterLeadTime: 10,
    encounterMargin: 10,
    targetApproachSteps: [
      { timeBefore: 60, maxRate: 50 },
      { timeBefore: 10, maxRate: 1 },
    ],
    readyCheckTime: 15,
    openProposalsPerClock: 1,
    proposalInterval: 30,
    idleTime: 120,
    stopWindow: 0.5,
    roundTripAllowance: 0.25,
    jumpArrivalClearance: 50,
    jumpArrivalLookahead: 30,
    jumpAlternativeLead: 10,
    advanceRetryInterval: 300,
    openAdvanceRequestsPerGroup: 1,
    departureContactLookahead: 30,
    departureNoticeTime: 10,
    forecastMaxPatches: 16,
    joinCooldown: 60,
    joinCooldownAfterFork: 30 * 60,
    resumeWindow: 30,
    resumeWindowBuildChange: 90,
    cohortBucket: 5 * 60,
    cohortHorizon: 14 * DAY,
    cohortOfferWait: 60,
    lagCap: 0,
  },
  claim: {
    joinDistanceBase: 1000,
    joinClosingTime: 2,
    islandPartFactor: 2,
    armedMarginBase: 200,
    armedClosingTime: 2,
    reservationReleaseDelay: 10,
    materialiseReachTime: 30,
    materialiseClearance: 5,
    clearingTime: 15,
    clearingAccelMax: 0.5,
    clearingTimeout: 30,
  },
  disconnect: {
    pingInterval: 1,
    lossTimeout: 3,
    soloLatchTime: 10,
    sharedRotationLatch: 0.25,
    sharedThrottleLatch: 2,
    reconnectGrace: 120,
  },
  contact: {
    subSteps: 4,
    solverIterations: 8,
    restitution: 0.2,
    restitutionMinSpeed: 0.3,
    friction: 0.5,
    speculativeTravelFraction: 0.25,
    nascentClearance: 0.05,
    hypervelocitySpeed: 250,
    hypervelocitySpecificEnergy: 40_000,
    explosionImpulsePerKg: 150,
    maxFragmentsPerCollision: 12,
    fragmentMassLimit: 50,
    fragmentLifetime: 60,
    defaultCrashTolerance: 6,
  },
  docking: {
    hardDockOffset: 0.003,
    hardDockAngleDeg: 0.1,
    hardDockSpeed: 0.003,
    hardDockDwell: 0.5,
    softCaptureClampTime: 0.5,
    linkBreakTime: 0.2,
    portCooldownTime: 10,
    portCooldownDistance: 1,
    helmRequestTimeout: 30,
    defaultLendPolicy: { lendAttitude: true, lendEngines: false, lendPropellant: false, helm: 'crew' },
    maxCraftPerAssembly: 32,
    maxPartsPerAssembly: 600,
    islandVesselBudget: 64,
  },
  terrain: {
    requestRadarAltitude: 2000,
    requestAltitude: 50_000,
    requestSpeed: 200,
  },
  pads: {
    reservationHold: 90,
    maxStay: 300,
    stayExtension: 120,
    maxStayUpTime: 600,
    disconnectGrace: 60,
    clearAltitude: 1500,
    clearDistance: 1000,
    safingTime: 20,
    keepOutRadius: { light: 300, medium: 450, heavy: 600 },
    restRecoveryTime: 60,
    rangeSafetyAltitude: 5000,
  },
  expiry: {
    craftRetention: 14 * DAY,
    shipSlots: 10,
    unownedAssemblyRetention: 48 * 3600,
    unownedCraftRetention: 48 * 3600,
    debrisRetention: 2 * 3600,
    debrisPerAccount: 24,
    unownedPerSoi: 5000,
    wreckRetention: 2 * 3600,
    lostDistance: 100 * AU,
    arcRetention: 24 * 3600,
    accountRetention: 90 * DAY,
    lobbyObjectCap: 50_000,
    pressureStart: 0.7,
    pressureFloorSingleSession: 24 * 3600,
    pressureFloor: 72 * 3600,
    sweepInterval: 60,
    outageExtensionThreshold: 3600,
  },
  limits: {
    inputsPerSecond: 60,
    commandsPerSecond: 20,
    timeMessages: 6,
    timeMessageWindow: 10,
    subscriptionsPerSecond: 5,
    accountsPerAddressPerHour: 10,
  },
  planning: {
    workerMaxEstimateMs: 50,
    weakClientCpuScore: null,
  },
};

/**
 * The base every duration of `UniverseRules` runs on, by `group.field` path (ARCHITECTURE U19). A duration
 * that is not listed here is not a timer (a look-ahead of a prediction, a lead on the universe axis, a
 * measurement window of the contact solver): it is a length of universe time and has no clock of its own.
 */
export const UNIVERSE_RULE_TIMERS: Readonly<Record<string, TimerBase>> = {
  'time.readyCheckTime': 'upTime',
  'time.proposalInterval': 'upTime',
  'time.idleTime': 'upTime',
  'time.stopWindow': 'upTime',
  'time.roundTripAllowance': 'upTime',
  'time.advanceRetryInterval': 'upTime',
  'time.departureNoticeTime': 'upTime',
  'time.joinCooldown': 'upTime',
  'time.joinCooldownAfterFork': 'upTime',
  'time.resumeWindow': 'upTime',
  'time.resumeWindowBuildChange': 'upTime',
  'time.cohortOfferWait': 'upTime',
  'time.lagCap': 'upTime',
  'claim.reservationReleaseDelay': 'ticks',
  'claim.clearingTime': 'ticks',
  'claim.clearingTimeout': 'ticks',
  'disconnect.pingInterval': 'upTime',
  'disconnect.lossTimeout': 'upTime',
  'disconnect.soloLatchTime': 'upTime',
  'disconnect.sharedRotationLatch': 'upTime',
  'disconnect.sharedThrottleLatch': 'upTime',
  'disconnect.reconnectGrace': 'upTime',
  'contact.fragmentLifetime': 'ticks',
  'docking.hardDockDwell': 'ticks',
  'docking.softCaptureClampTime': 'ticks',
  'docking.linkBreakTime': 'ticks',
  'docking.portCooldownTime': 'ticks',
  'docking.helmRequestTimeout': 'upTime',
  'pads.reservationHold': 'upTime',
  'pads.maxStay': 'ticks',
  'pads.stayExtension': 'ticks',
  'pads.maxStayUpTime': 'upTime',
  'pads.disconnectGrace': 'upTime',
  'pads.safingTime': 'ticks',
  'pads.restRecoveryTime': 'ticks',
  'expiry.craftRetention': 'wall',
  'expiry.unownedAssemblyRetention': 'wall',
  'expiry.unownedCraftRetention': 'wall',
  'expiry.debrisRetention': 'wall',
  'expiry.wreckRetention': 'wall',
  'expiry.arcRetention': 'wall',
  'expiry.accountRetention': 'wall',
  'expiry.pressureFloorSingleSession': 'wall',
  'expiry.pressureFloor': 'wall',
  'expiry.sweepInterval': 'wall',
  'expiry.outageExtensionThreshold': 'wall',
  'limits.timeMessageWindow': 'upTime',
};

// ----------------------------------------------------------------------------------------------- targets

/** What a pilot can target (ARCHITECTURE 19). A vessel target is stored with its craft id and follows lineage. */
export type TargetRef =
  | { kind: 'body'; id: BodyId }
  | { kind: 'vessel'; id: string }
  /** `portId` is the part key `craftId/instanceId` of the docking-port part on `vesselId`. */
  | { kind: 'port'; vesselId: string; portId: string };

// ------------------------------------------------------------------------------------------------- clocks

export type ClockKind = 'live' | 'cohort' | 'private' | 'shared';

/** Why a clock cannot run faster, or stops where it stops. */
export type TimeLimitKind =
  /** Thrust, atmosphere or contact on the clock: physics warp only. */
  | 'physics'
  /** The altitude ladder of the body. */
  | 'altitude'
  /** Inside a launch range. */
  | 'launchRange'
  /** The next sphere-of-influence crossing, horizon or end of a computed forecast chain. */
  | 'event'
  /** A screened encounter or the selected target's closest approach. */
  | 'encounter'
  /** Bound members who ask for less or have not answered. */
  | 'members'
  /** The carry limit of a craft whose owner has not accepted. */
  | 'carryLimit'
  /** The lead cap. */
  | 'leadCap'
  /** The island is behind (overload, or held for a reservation, terrain or its pilots; U18). */
  | 'held';

export interface TimeLimit {
  kind: TimeLimitKind;
  /** Player-facing sentence ("Cannot warp: VEGA is 12 km away and has not agreed"). */
  text: string;
  /** Vessels and accounts that cause it (empty when it is the pilot's own situation). */
  vesselIds: string[];
  accountIds: string[];
}

/** A member of a clock as shown in the time strip. */
export interface ClockMember {
  accountId: string;
  callsign: string;
  vesselId: string;
  /** Bound members share the rate; a guest never holds anyone (ARCHITECTURE 5.1). */
  bound: boolean;
  /** The rate this member asks for (bound members), and whether it has accepted the proposal in force. */
  requestedRate: number;
  accepted: boolean;
  /** True when the member does not block (idle, docked and quiescent, or disconnected; U6). */
  idle: boolean;
}

/** An open warp proposal (U6) or ask-to-advance (U9) on a clock. */
export interface TimeProposal {
  id: string;
  kind: 'rate' | 'advance';
  fromAccountId: string;
  fromCallsign: string;
  /** Proposed rate (kind 'rate') or the tick to advance to (kind 'advance'). */
  rate: number | null;
  toTick: number | null;
  /** Directory up-time (ms) at which the ready-check ends. */
  expiresUpMs: number;
}

/**
 * A server clock (ARCHITECTURE 5.2). Server and clients evaluate the same closed form from the same message:
 *   tick(up) = min(untilTick, tick0 + floor(rate x TICKS_PER_SECOND x (up - anchorUpMs) / 1000))
 * where `up` is directory up-time in ms. A client never reports time.
 */
export interface ClockState {
  id: string;
  kind: ClockKind;
  /** The schedule: tick at `anchorUpMs`, the up-time of that anchor, and the rate (0 = hold). */
  tick0: number;
  anchorUpMs: number;
  rate: number;
  /** The tick the clock stops at (the earliest event, cap or limit), and what sets it; null when nothing does (never Infinity: see "JSON" in the file header). */
  untilTick: number | null;
  limitedBy: TimeLimit | null;
  members: ClockMember[];
  proposals: TimeProposal[];
}

/** An action the time model offers the pilot now (the keys of the time strip and of every echo label). */
export type TimeOffer =
  /** Jump to a later tick or onto another clock (U8). `inPhase` marks a jump that arrives at the wanted phase angle. */
  | { kind: 'jump'; toTick: number; toClockId: string | null; vesselId: string | null; inPhase: boolean; label: string }
  | { kind: 'hold'; label: string }
  /** Ask the group that holds or is behind `vesselId` to advance to the pilot's tick (U9). */
  | { kind: 'askAdvance'; vesselId: string; label: string }
  /** Fix a meeting tick with another pilot (U8). */
  | { kind: 'meet'; accountId: string; atTick: number; label: string }
  | { kind: 'link'; accountId: string; label: string }
  | { kind: 'follow'; accountId: string; label: string }
  /** Rejoin the live clock after being behind (U18). */
  | { kind: 'rejoin'; toTick: number; label: string };

/**
 * What the HUD's time strip shows (ARCHITECTURE 5.4): `SimSnapshot.time`. `SimSnapshot.warp` is derived
 * from it. In a session with one clock and nobody else (a `LocalSession` on its own) it is trivial:
 * `relation: 'live'`, `offset: 0`, no members, proposals or offers.
 */
export interface TimeView {
  /** The tick of the pilot's clock and of the live clock. */
  myTick: number;
  liveTick: number;
  /** Rate applied now and the highest the pilot may request now, as factors. */
  rate: number;
  maxRate: number;
  limitedBy: TimeLimit | null;
  /** The pilot's clock against the live clock, and `myTick - liveTick` in ticks. */
  relation: 'live' | 'ahead' | 'behind';
  offset: number;
  /** Kind and id of the clock; null id in a session without a directory. */
  clockId: string | null;
  clockKind: ClockKind;
  members: ClockMember[];
  proposals: TimeProposal[];
  offers: TimeOffer[];
}

/** How a vessel exists for the viewer (ARCHITECTURE 5.1): solid, or one of the two kinds of echo. */
export type Presence = 'solid' | 'recordedEcho' | 'projectedEcho';

// ------------------------------------------------------------------------------------------------- census

/** One conic of a published forecast chain or committed coast, valid between two ticks (ARCHITECTURE U14). */
export interface CensusPatch {
  bodyId: BodyId;
  conic: ConicElements;
  fromTick: number;
  toTick: number;
  /** True for a forecast after the head (drawn differently from committed history). */
  forecast: boolean;
}

export type CensusKind = 'ship' | 'assembly' | 'debris' | 'wreck';

/**
 * One object of the universe as every viewer receives it (the relevant set on the socket and the public
 * census of a sphere of influence; ARCHITECTURE 13.3, 14). Whether it is solid or an echo for a viewer is
 * decided on the client from `head`, `horizon`, the chain, `reservedBy`, `clockId` and the viewer's own
 * clock (U2), which is why the census is one document for all viewers.
 */
export interface CensusEntry {
  /** Vessel id; `craftIds` lists the craft aboard (a target is stored by craft id and follows lineage). */
  vesselId: string;
  craftIds: string[];
  kind: CensusKind;
  name: string;
  /** Vehicle of the base craft, for the icon; owners by craft order (null = unowned). */
  vehicleId: VehicleId;
  ownerIds: (string | null)[];
  ownerCallsigns: (string | null)[];
  /** Sphere of influence the vessel is in at its head. */
  bodyId: BodyId;
  /** Committed coast and forecast chain, in time order. Empty for a landed vessel (see `landed`). */
  patches: CensusPatch[];
  /** At rest on a body: planetocentric latitude, east longitude (rad) and altitude above the reference radius (m). */
  landed: { bodyId: BodyId; latitude: number; longitude: number; altitude: number } | null;
  /** Head tick, and the horizon (tick of the next atmosphere entry or impact); null when there is none: a closed orbit clear of every surface and atmosphere, or at rest. */
  headTick: number;
  horizonTick: number | null;
  /** End of the computed forecast chain; past it the vessel is "not computed this far ahead". */
  chainEndTick: number;
  /** Clock the vessel is on when attended; null when passive. */
  clockId: string | null;
  /** Clock whose island holds the reservation (U4), null when unreserved. */
  reservedBy: string | null;
  /** Latest tick a visitor may take it to (`liveTick + advanceLimit`); null = no limit (unowned objects: unowned ships, debris). */
  limitTick: number | null;
  /** Bounding radius about the centre of mass, m. */
  radius: number;
  /** Wall time (ms since the Unix epoch) at which it is removed, and why it is kept until then; null = not expiring. */
  expiresWallMs: number | null;
  /** Under thrust or otherwise integrated: its elements are refreshed at 1 Hz and at burn end. */
  thrusting: boolean;
  /** Monotonic counter of this entry's changes (the planning cache key of a target). */
  revision: number;
}

/** A screened encounter or a proximity warning of the pilot's own vessel (ARCHITECTURE 13.3 `Conjunctions`). */
export interface Conjunction {
  otherVesselId: string;
  /** Tick and miss distance (m) of the closest approach, and the relative speed there (m/s). */
  tick: number;
  distance: number;
  relSpeed: number;
  /** 'encounter': inside `Ra + Rb + encounterMargin`, the clock stops for it; 'warning': close, shown only. */
  severity: 'encounter' | 'warning';
}

// ------------------------------------------------------------------------------------------- view models

/** One lobby in the client's list (ARCHITECTURE 25). */
export interface LobbySummary {
  id: string;
  name: string;
  kind: 'public' | 'private' | 'event';
  region: string;
  /** Round trip measured by the client, ms; null before the first measurement. */
  rttMs: number | null;
  /** Pilots connected, the admission cap, pilots in flight, ships and stations stored. */
  online: number;
  softCap: number;
  flying: number;
  shipsSaved: number;
  stations: number;
  /** Live clock tick, and the rules document in force. */
  liveTick: number;
  rulesId: string;
  rulesVersion: number;
  /** One line about the time model for the list row. */
  timeModelSummary: string;
  /** Admission state; `position` and `etaSeconds` only when queued. */
  status: 'open' | 'queued' | 'maintenance' | 'incompatible';
  position: number | null;
  etaSeconds: number | null;
  /** False when the client's build or definition library differs from the lobby's ("a new version is ready"). */
  buildCompatible: boolean;
}

/** One pad of a site as the pad-selection screen and the directory see it (ARCHITECTURE 5.9, 9.4). */
export interface PadState {
  siteId: SiteId;
  padId: string;
  class: PadClass;
  /** 'free'; 'reserved' (briefing or transit); 'occupied' (a vehicle stands on it); 'safing'; 'closed' (keep-out not clear). */
  state: 'free' | 'reserved' | 'occupied' | 'safing' | 'closed';
  /** Account and vessel that hold it, when reserved or occupied. */
  accountId: string | null;
  callsign: string | null;
  vesselId: string | null;
  /** Tick at which the current interval of its timetable ends (the pad's own clock), null when free. */
  freeAtTick: number | null;
  /** Earliest slot on the live clock and the earliest cohort slot, as ticks; null when none inside the cohort horizon. */
  nextLiveTick: number | null;
  nextCohortTick: number | null;
}

/** Why a ship is still kept and until when (ARCHITECTURE 15.5). */
export interface ExpiryView {
  /** Wall time of removal, ms since the Unix epoch; null = kept indefinitely (attended, or protected). */
  atWallMs: number | null;
  /** The `UniverseRules.expiry` field that sets the date, e.g. 'craftRetention', and the sentence shown. */
  rule: string;
  reasonText: string;
  /** Callsign of the owner whose activity protects an assembly, when that is why it is kept. */
  protectedBy: string | null;
}

/** One of the player's ships in My Ships (ARCHITECTURE 23). */
export interface ShipRecord {
  /** The player's craft and the vessel that holds it now (an assembly id when docked). */
  craftId: string;
  vesselId: string;
  name: string;
  vehicleId: VehicleId;
  isAssembly: boolean;
  /** Callsigns of the other owners in the assembly. */
  members: string[];
  situation: string;
  bodyId: BodyId;
  /** Apoapsis and periapsis altitude (m) when in orbit; the surface location (rad) when landed. */
  orbit: { apoapsisAltitude: number; periapsisAltitude: number; inclination: number } | null;
  surface: { latitude: number; longitude: number } | null;
  crew: number;
  /** Remaining vacuum delta-v, m/s. */
  deltaVRemaining: number;
  /** Wall time the owner last flew it, ms since the Unix epoch. */
  lastFlownWallMs: number;
  expiry: ExpiryView;
  /** Maneuver nodes are stored with the ship. */
  nodesSaved: number;
  /** Who flies it now: nobody, this session, another session of the account, or another pilot at the assembly's helm. */
  sessionState: 'idle' | 'flownHere' | 'flownElsewhere' | 'flownByOther';
  flownBy: string | null;
  /** Head tick and its relation to the live clock (for "3 d 4 h ahead"). */
  headTick: number;
  presence: Presence;
}

/** One craft of an assembly in the assembly panel (ARCHITECTURE 7.5, 21). */
export interface AssemblyCraftView {
  craftId: string;
  name: string;
  vehicleId: VehicleId;
  ownerId: string | null;
  ownerCallsign: string | null;
  /** True when a pilot is seated in it now. */
  attended: boolean;
  /** Seniority order in the assembly (0 = longest aboard); the anchor is the most senior craft with an unexpired owner. */
  seniority: number;
  policy: LendPolicy;
  /** Ports of this craft: part key, type, state and the craft docked there. */
  ports: { portId: string; portType: string; state: 'disabled' | 'ready' | 'occupied' | 'soft' | 'hard' | 'cooldown'; armed: boolean; peerCraftId: string | null }[];
}

/** The assembly the pilot is aboard (ARCHITECTURE 7.5). */
export interface AssemblyView {
  vesselId: string;
  crafts: AssemblyCraftView[];
  /** Dock links as pairs of port part keys. */
  links: { a: string; b: string }[];
  /** Craft that anchors the assembly, and the helm: who flies, from which craft, with an open request if any. */
  anchorCraftId: string;
  helm: { accountId: string | null; callsign: string | null; craftId: string; request: { fromAccountId: string; fromCallsign: string; expiresUpMs: number } | null };
}

/** A pilot in the roster (ARCHITECTURE 25). */
export interface RosterEntry {
  accountId: string;
  callsign: string;
  /** 'nearby' (in the near tier), 'docked' (aboard the pilot's assembly) or 'lobby'. */
  relation: 'nearby' | 'docked' | 'lobby';
  vesselId: string | null;
  bodyId: BodyId | null;
  /** The pilot's clock against the viewer's, in ticks (0 on the same clock), and whether they are linked. */
  timeOffset: number;
  linked: boolean;
  /** The viewer hides this pilot's quick-comms and name; their craft stays physical. */
  blocked: boolean;
}

/** A line of the feed ticker and the ops log (ARCHITECTURE 23). */
export interface FeedEvent {
  id: string;
  wallMs: number;
  /** Universe tick of the event; null for out-of-fiction notices. */
  tick: number | null;
  kind: 'launch' | 'orbit' | 'docked' | 'undocked' | 'collision' | 'landing' | 'splashdown' | 'removed' | 'rules' | 'notice' | 'quick';
  text: string;
  /** Vessels and callsigns it names (the map can focus them). */
  vesselIds: string[];
  callsigns: string[];
  /** True until the outcome is durable (ARCHITECTURE 15.1, decision 53 d). */
  provisional: boolean;
}

/** A prompt card: something another pilot or the server asks the player (ARCHITECTURE 21). */
export interface Prompt {
  id: string;
  kind: 'warpProposal' | 'advanceRequest' | 'helmRequest' | 'meet' | 'link' | 'abandonChoice' | 'notice';
  fromCallsign: string | null;
  text: string;
  /** Directory up-time (ms) at which it lapses, and what lapsing means. */
  expiresUpMs: number | null;
  onExpire: 'accept' | 'decline' | 'none';
}

/** Who is where, for the title and the hub (public, cached 1 s). */
export interface PresenceSummary {
  online: number;
  flying: number;
  /** Pilots per sphere of influence. */
  byBody: Record<BodyId, number>;
  queued: number;
}

/** State of the session's link to its universe (a `LocalSession` is always 'local'). */
export interface LinkState {
  state: 'local' | 'offline' | 'connecting' | 'online' | 'reconnecting' | 'queued' | 'takenOver' | 'incompatible' | 'maintenance';
  /** Round trip and the measured input margin (how early inputs arrive for their stamped tick), ms; null when unknown. */
  rttMs: number | null;
  inputMarginMs: number | null;
  /** Seconds left of the reconnect grace while reconnecting; queue position while queued. */
  graceRemaining: number | null;
  queuePosition: number | null;
  /** Tick up to which the pilot's island is durable (ARCHITECTURE 13.3 `Durable`); null when local. */
  durableTick: number | null;
  /** Player-facing reason for the current state when it is not 'online' or 'local'. */
  reason: string | null;
}

/** What the capability gate found (ARCHITECTURE 24). Only vendor, architecture, browser and the reason may leave the client. */
export interface CapabilityReport {
  pass: boolean;
  /** Machine-readable reason of a block and the sentence shown; null when it passed. */
  reason: 'mobile' | 'noWebGpu' | 'noAdapter' | 'fallbackAdapter' | 'missingFeature' | 'lowLimits' | 'deviceFailed' | 'missingApi' | null;
  reasonText: string | null;
  vendor: string;
  architecture: string;
  /** A hint only (never a block): judged by the calibration on the real renderer. */
  adapterClass: 'discrete' | 'integrated' | 'unknown';
  features: string[];
  limits: Record<string, number>;
  /** Browser family and major version; true when it is not Chromium desktop ("not tested on this browser"). */
  browser: string;
  untestedBrowser: boolean;
  mobile: boolean;
  /** Display size in device pixels, device pixel ratio, and the refresh rate once measured. */
  displayPx: [number, number];
  dpr: number;
  refreshHz: number | null;
  /** Hash of vendor, architecture, features, limits, browser major, display bucket and dpr: the key settings are stored under. */
  fingerprint: string;
}

// ===================================================================================== WIRE MESSAGES =====
// Written and owned by the `wire-protocol` package from wave 4 (ARCHITECTURE 13.3). Nothing below this line
// is the lead's; nothing above it is a wire encoding.
