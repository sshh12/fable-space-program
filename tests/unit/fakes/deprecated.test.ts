/**
 * The presentation sweep's grep test (docs/WORK_PACKAGES_V2.json, `presentation-sweep`, acceptance line 1): no
 * file of the presentation, of the labs or of the browser tests reads a field of the contracts that the
 * tighten step removes, creates the simulation by its v1 name, looks a vehicle definition up by a runtime id,
 * or takes the origin of ROOT positions to be a body.
 *
 * What is scanned: the trees the sweep owns (the render packages, the UI, input, the camera, the map, audio,
 * src/app, src/core/access, src/core/fakes, src/core/gpu, the labs, the browser tests and the unit tests of
 * the presentation). Not scanned: src/sim, src/session, src/universe and the loader (src/core/defs), which
 * produce the deprecated fields until the tighten step; the lead's own paths (labs/template, labs/platform,
 * tests/browser/shell, tests/browser/platform and the harness); and the headless areas of other packages
 * (src/pilot reads `readouts.targetBodyId` in missionPilot.ts: for the lead at the tighten step).
 *
 * Comments are taken out before a file is searched. Every place a rule finds must be an exception listed
 * below with its reason, and every exception must still be found: a stale one fails the test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const SCANNED = [
  'src/render',
  'src/ui',
  'src/input',
  'src/camera',
  'src/map',
  'src/audio',
  'src/app',
  'src/core/access',
  'src/core/fakes',
  'src/core/gpu',
  'labs',
  'tests/browser',
  'tests/unit/atmosphere',
  'tests/unit/audio',
  'tests/unit/cockpit',
  'tests/unit/flight-ui',
  'tests/unit/map-view',
  'tests/unit/ocean',
  'tests/unit/render-core',
  'tests/unit/sky',
  'tests/unit/terrain-render',
  'tests/unit/vehicle',
  'tests/unit/vfx',
  'tests/unit/fakes',
];
const NOT_SCANNED = ['labs/template/', 'labs/platform/', 'tests/browser/shell/', 'tests/browser/platform/', 'tests/browser/harness.ts', 'tests/browser/globalSetup.ts', 'tests/browser/chromeArgs.ts', 'tests/unit/fakes/deprecated.test.ts'];

interface Rule {
  id: string;
  what: string;
  pattern: RegExp;
  /** Files in which the rule may find something, each with the reason. */
  exceptions: Record<string, string>;
}

const RULES: Rule[] = [
  {
    id: 'tick',
    what: 'reads `tick` of a snapshot (use `revisionOf` of src/core/access/snapshotAccess.ts)',
    pattern: /\.tick\b/,
    exceptions: {
      'src/core/access/snapshotAccess.ts': '`revisionOf`: the one reader, for a producer that does not state `revision` yet',
      'src/core/fakes/fakeSession.ts': 'a producer: its own step counter, which it states as `tick` and as `revision`',
    },
  },
  {
    id: 'target',
    what: 'reads `Readouts.targetBodyId` or `.targetClosestApproach` (use `targetOf` / `targetBodyOf` / `targetNameOf`)',
    pattern: /\.targetBodyId\b|\.targetClosestApproach\b/,
    exceptions: {
      'src/core/access/snapshotAccess.ts': '`targetOf`: the one place that derives the target from the deprecated pair while no session fills `Readouts.target`',
      'src/audio/config.ts': 'the PATH `readouts.targetBodyId` that the audio data may name for a click watch: `readSnapshotPath` answers it through `targetBodyOf`, the field itself is not read',
      'tests/unit/fakes/fakeSession.test.ts': 'the test of a producer: the fake states the deprecated field beside `Readouts.target`, as a session does until the tighten step',
    },
  },
  {
    id: 'pad',
    what: 'reads the single pad of a site, `LaunchSiteDef.pad` / `.padAzimuthDeg` / `.structures` (use `padsOf` / `padOf` / `padLocationOf` of src/core/defs/sites.ts)',
    pattern: /\.padAzimuthDeg\b|\bsite\w*!?\??\.(?:pad|structures)\b|\bsites\b[^\n;]{0,16}\]!?\??\.(?:pad|structures)\b/i,
    exceptions: {},
  },
  {
    id: 'pause',
    what: "names the retired button action 'pause' (it is 'flightMenu')",
    pattern: /['"]pause['"]/,
    exceptions: {
      'src/input/bindings.ts': 'the retired member as a TYPE (`RetiredButtonAction`), so that the table of every button action compiles until the lead takes the member out of the union',
      'src/audio/config.ts': "not the action: the `pause` block of the audio mix data (`mix.pause.fadeTime`)",
      'tests/unit/flight-ui/bindings.test.ts': 'the test that the action is gone: no table of the bindings names it',
    },
  },
  {
    id: 'createSim',
    what: 'creates the simulation by its v1 name `createSim` (use `createSession` of src/session)',
    pattern: /\bcreateSim\b/,
    exceptions: {},
  },
  {
    id: 'Sim',
    what: 'names the aliases `Sim` / `SimDebug` (they are `LocalSession` / `SessionDebug` of src/core/contracts/session.ts)',
    pattern: /(?<![\w$.'"`/-])(?:Sim|SimDebug)(?![\w$'"`/-])/,
    exceptions: {},
  },
  {
    id: 'vehicles',
    what: 'looks a vehicle definition up by an id of a snapshot, `vehicles[<... .vehicleId or .vehicle>]` (the snapshot states what a consumer needs: `CraftSnapshot`, `StageInfo`, `PartSnapshot`)',
    pattern: /vehicles\[[^\]]*\.(?:vehicleId|vehicle)\b[^\]]*\]/,
    exceptions: {
      'src/core/fakes/fakeSession.ts': 'a producer: the vehicle the fake is published as (its own `scenario.vehicle`), from which it states the craft block and the stage words as a session does',
      'src/app/main.ts': 'not a runtime id: the vehicle a SCENARIO of the definitions names (`scenario.vehicle`), for the heading of the loading screen',
      'labs/vehicle/labSim.ts': 'a producer: the lab simulation reads the vehicle it was built from (its own `vehicleId`) for its stage labels',
    },
  },
  {
    id: 'origin',
    what: 'takes a ROOT position for a distance from a body or compares one with zero (ROOT positions are about the render root, which is replaced: use differences)',
    pattern: /\b(?:len|lenSq)\(\s*[\w.!?[\]]*\.(?:rRoot|positionRoot)\s*\)|\.(?:rRoot|positionRoot)\.[xyz]\s*(?:===?|!==?)\s*0\b/,
    exceptions: {
      'tests/unit/fakes/fakeSession.test.ts': 'the test of a producer: where the fake puts the origin is what it asserts (the origin body at zero, the other 384,000 km away)',
      'tests/unit/flight-ui/camera.test.ts': 'a test states that its scene is drawn about the far origin, to show that the map rig does not care',
      'tests/unit/render-core/frameMath.test.ts': 'a test states how far from the origin its vessel is, to show that the camera-relative poses keep their precision there',
    },
  },
];

function filesUnder(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (NOT_SCANNED.some((x) => rel === x || rel.startsWith(x))) continue;
    if (e.isDirectory()) filesUnder(rel, out);
    else if (rel.endsWith('.ts') || rel.endsWith('.html')) out.push(rel);
  }
}

/** The text without its comments (a `//` inside a string ends the line too, which only hides what follows a URL). */
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');

describe('deprecated reads (the presentation sweep)', () => {
  const files: string[] = [];
  for (const dir of SCANNED) filesUnder(dir, files);
  files.push('index.html');
  const found = new Map<string, Map<string, string[]>>();
  for (const rule of RULES) found.set(rule.id, new Map());
  for (const file of files) {
    const lines = withoutComments(fs.readFileSync(path.join(ROOT, file), 'utf8')).split('\n');
    for (const rule of RULES) {
      const hits: string[] = [];
      lines.forEach((line, i) => {
        if (rule.pattern.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
      if (hits.length > 0) found.get(rule.id)!.set(file, hits);
    }
  }

  it('scans the presentation, the labs and the browser tests', () => {
    expect(files.length).toBeGreaterThan(500);
    for (const must of ['src/ui/model.ts', 'src/render/core/renderer.ts', 'src/app/game.ts', 'labs/integration/main.ts', 'tests/browser/integration/origin.spec.ts']) expect(files, must).toContain(must);
    expect(files.some((f) => f.startsWith('tests/browser/shell/'))).toBe(false);
  });

  for (const rule of RULES) {
    it(`no file ${rule.what}`, () => {
      const hits = found.get(rule.id)!;
      const unlisted = [...hits.entries()].filter(([file]) => !(file in rule.exceptions)).flatMap(([, lines]) => lines);
      expect(unlisted, `rule "${rule.id}"`).toEqual([]);
      // An exception that finds nothing has had its day: take it out of the list.
      const stale = Object.keys(rule.exceptions).filter((file) => !hits.has(file));
      expect(stale, `stale exceptions of rule "${rule.id}"`).toEqual([]);
    });
  }
});
