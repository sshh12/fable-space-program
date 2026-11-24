/**
 * Fly one flight of the fleet and print its record (a tool, not a test; the acceptance flights are
 * flights.test.ts).
 *
 *   npx tsx tests/unit/fleet/flyOne.ts <vehicle id> [--separate]     the ascent from its Ka Lae pad
 *   npx tsx tests/unit/fleet/flyOne.ts entry | lunar | departure      the Kestrel's entry, the Egret's landing, the Albatross's burn
 */
import type { Pilot } from '@/core/contracts/controls';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { createAscentPilot } from '@/pilot/generic/ascent';
import type { GenericPilot } from '@/pilot/generic/common';
import { analyzeVehicle } from '@/sim/vessel/analyze';
import { fly } from './flights';
import { DeparturePilot, EntryPilot, LanderPilot } from './pilots';

const lib = await loadDefs(fsDefSource());
const what = process.argv[2] ?? 'solstice-pelican';
const special: Record<string, { vehicle: string; scenario: string; make: (caps: ReturnType<typeof analyzeVehicle>) => GenericPilot; maxSimTime: number }> = {
  entry: { vehicle: 'solstice-kestrel', scenario: 'fleet-kestrel-entry', make: (c) => new EntryPilot(c), maxSimTime: 7200 },
  lunar: { vehicle: 'meridian-egret', scenario: 'fleet-egret-lunar', make: (c) => new LanderPilot(c, { targetAltitude: 30000, cutoffPeriapsis: 18000, maxG: 3 }), maxSimTime: 7200 },
  departure: { vehicle: 'meridian-albatross', scenario: 'fleet-albatross-departure', make: (c) => new DeparturePilot(c), maxSimTime: 3600 },
};
const job = special[what];
const vehicle = job?.vehicle ?? what;
const caps = analyzeVehicle(lib, lib.vehicles[vehicle]!);
const pilot: GenericPilot = job ? job.make(caps) : createAscentPilot(caps, { separateInOrbit: process.argv.includes('--separate') });
if (pilot instanceof LanderPilot) pilot.trace = true;
pilot.onLog = (n) => console.log(`  ${n.met.toFixed(1).padStart(7)} ${n.phase.padEnd(9)} ${n.note}`);
const rec = await fly(lib, job?.scenario ?? `fleet-${vehicle}`, pilot as Pilot, { maxSimTime: job?.maxSimTime ?? 2400 });
const r = rec.final.readouts;
console.log(`${what}: ${rec.result.reason} ${rec.result.failure ?? ''} t=${rec.result.simTime.toFixed(0)} pe ${(r.periapsisAltitude / 1000).toFixed(1)} ap ${(r.apoapsisAltitude / 1000).toFixed(1)} maxQ ${rec.maxQ.toFixed(0)} qa ${rec.maxQAlpha.toFixed(0)} dvLeft ${r.deltaVTotal.toFixed(0)} mass ${r.mass.toFixed(0)} situation ${rec.active?.situation} crew ${rec.final.mission.crewAlive} milestones ${rec.final.milestones.map((m) => m.id).join(',')}`);
for (const s of rec.separations) console.log(`  sep at ${(s.ut - rec.final.simUt + rec.result.simTime).toFixed(1)} s: ${s.pieces.join(', ')} from ${JSON.stringify(s.positiveFrom)} end ${JSON.stringify(s.endClearance)}`);
if (pilot instanceof DeparturePilot) console.log(`  burn ${((pilot.burnEndUt ?? 0) - (pilot.burnStartUt ?? 0)).toFixed(0)} s, integrated ${pilot.deltaV.toFixed(0)} m/s, ideal ${pilot.idealDeltaV(900).toFixed(0)} m/s, max warp index ${pilot.maxWarpIndex}`);
for (const d of rec.damage) console.log(`  DAMAGE ${d.type} at ${(d.ut - rec.final.simUt + rec.result.simTime).toFixed(1)} s: ${d.detail}`);
if (pilot instanceof LanderPilot) console.log(`  touchdown ${pilot.touchdownSpeed?.toFixed(2)} m/s`);
