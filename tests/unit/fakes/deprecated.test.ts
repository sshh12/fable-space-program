/**
 * The presentation sweep's deprecation test (docs/WORK_PACKAGES_V2.json, `presentation-sweep`, acceptance line 1): no
 * file of the presentation, of the labs or of the browser tests looks a vehicle definition up by a runtime id,
 * takes the cockpit camera from a vehicle definition, takes the origin of ROOT positions to be a body, or
 * names the retired button action.
 *
 * SINCE THE TIGHTEN STEP after sub-wave 3.2 the members the sweep moved its readers away from are gone from
 * the contracts (`SimSnapshot.tick`, `Readouts.targetBodyId` / `.targetClosestApproach`, `LaunchSiteDef.pad` /
 * `.padAzimuthDeg` / `.structures`, the aliases `Sim` / `SimDebug`, the factory `createSim`): the compiler
 * refuses a read of them, and their five rules (`tick`, `target`, `pad`, `createSim`, `Sim`) were taken out
 * of this test with their exceptions and their lines of the self-test. What is left is what the compiler
 * does not hold: the rules `vehicles`, `cockpitCamera`, `origin`, `pause` and `html`.
 *
 * HOW IT LOOKS. It walks the syntax tree of every scanned file and asks the type checker what each name is.
 * The tree and the checker are the compiler's own: TypeScript 7 has no parser in JavaScript, so the test
 * starts the native compiler once through `typescript/unstable/sync` (one child process for the run, the
 * project of tsconfig.json; about three seconds) and reads the trees it parsed. Nothing is matched by a line
 * pattern, and comments are not part of a tree. (The package calls that entry point unstable: after a change of
 * the `typescript` version this file is the one to run first; the tree shapes it reads are the compiler's
 * usual ones.)
 *
 * A READ OF A MEMBER (`DefLibrary.vehicles`, `VehicleDef.cameras.cockpit`) is found by the member's NAME,
 * whatever it is read from and in every form a name can be read in:
 *   - a property access `x.cockpit`, `x?.cockpit`, `x!.cockpit`;
 *   - an element access with a string, `x['cockpit']`;
 *   - an object destructuring pattern, shorthand, renamed, nested, with a default, in a declaration, a parameter
 *     or an assignment: `const { cockpit } = x`, `{ cameras: { cockpit: c } }`, `({ cockpit: c } = x)`;
 *   - a type that reads it: `VehicleDef['cameras']['cockpit']`, `typeof x.cockpit`.
 * Then the checker is asked what the name is. The read is dismissed only where the checker shows the name to
 * be ANOTHER declared member (`CraftSnapshot.cockpit`, `VehicleDef.cockpit`). It stays a finding where the
 * name is the member of the contracts, where the value has no type that says what it is (`any`, a key of a
 * dictionary), and where the other declaration is written for a type assertion: inside one
 * (`(x as { cockpit: ... }).cockpit`) or in a type of the file's own that an assertion of the file names
 * (`type Cameras = { cockpit: ... }; (x as Cameras).cockpit`): the file restates the member and the compiler
 * cannot see through it. So an intermediate variable changes nothing: `const c = v.cameras; c.cockpit` is
 * `VehicleDef.cameras.cockpit`. Beside the walk, the compiler's own list of uses of a declaration marked
 * `@deprecated` is read for the members the rules name (the suggestion diagnostics of every scanned file): it
 * finds what no name shows, such as `x[key]` with a key of a literal type. (No member of the rules left is
 * marked today; the pass is there for the next one that is.)
 *
 * `defs.vehicles` may be used in three ways only: indexed by a constant of the code (a string, or a value whose
 * type is one string); its ids listed (`Object.keys(defs.vehicles)`: an id alone looks nothing up); and its
 * definitions listed (`Object.values`, `Object.entries`) to be counted, indexed by a number, or searched or
 * narrowed by a test that reads nothing but the definition it is handed (`.find((v) => v.cockpit)`; what is
 * done with the list of a `.filter(...)` or a `.map(...)` is judged again). Every other use is a finding: an
 * index that is a value, a search that reads something from outside, a list of the definitions that is kept or
 * looped over, the table in a variable, in a destructuring pattern, spread or handed to a function.
 *
 * WHAT IS SCANNED: the trees the sweep owns (the render packages, the UI, input, the camera, the map, audio,
 * src/app, src/core/access, src/core/fakes, src/core/gpu, src/core/ui, the labs, the browser tests and the unit
 * tests of the presentation, tests/unit/camera among them). Not scanned: src/sim, src/session, src/universe and
 * the loader (src/core/defs), which are the producers; the lead's own paths (labs/template, labs/platform,
 * tests/browser/shell, tests/browser/platform and the harness); and the headless areas of other packages.
 *
 * EXCEPTIONS are per LINE: the file and the exact text of the line (without its indentation), each with its
 * reason. A finding on a line that is not listed fails the test, and so does an exception that no longer finds
 * anything (a stale one: take it out), and a rule whose member the contracts no longer declare.
 *
 * NOT A FINDING, by design: an object literal that STATES a member (a producer: a definition built in a lab
 * or a test). THE LIMITS of the walk: it follows types, not values. (1) A read through a type that restates a
 * member and is given its value WITHOUT an assertion in the same file (a variable of an interface of the
 * file's own that is assigned from an untyped value; an assertion to a restating type that another file
 * declares) is the member of that type to the checker, and is not found. (2) A member named only by a string
 * that is not the index of an element access (`Reflect.get(x, 'cockpit')`, a key in a variable of type
 * `string`) is not found: `vehicles` and `cockpit` are words of other things too.
 *
 * The test tests itself: the last block runs the same rules over small sources that exist only in this file
 * (a second project, served to the compiler from memory), in which every line that must be found is marked.
 *
 * A rule whose member is taken out of the contracts says so ("does not declare"): take the rule out, with its
 * exceptions and with the lines of the self-test's sources that are marked with its id (they name the member,
 * so they no longer compile).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isIndexedAccessTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isNonNullExpression,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isRegularExpressionLiteral,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTemplateHead,
  isTemplateMiddle,
  isTemplateTail,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeLiteralNode,
  isTypeNode,
  isTypeReferenceNode,
  isVariableDeclaration,
  SyntaxKind,
  type ArrowFunction,
  type Expression,
  type FunctionExpression,
  type Identifier,
  type Node,
  type NoSubstitutionTemplateLiteral,
  type SourceFile,
  type StringLiteral,
} from 'typescript/unstable/ast';
import type { FileSystem } from 'typescript/unstable/fs';
import { API, TypeFlags, type Project, type Symbol as CheckerSymbol } from 'typescript/unstable/sync';

const ROOT = process.cwd().replace(/\\/g, '/');
/** A path as a key: the compiler names a file in more than one spelling (the case of a drive letter, the slashes). */
const pathKey = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
const samePath = (a: string, b: string): boolean => pathKey(a) === pathKey(b);

// ------------------------------------------------------------------------------------------------ the rules

/** A member of the contracts by its place: the file, and the names from a top-level declaration down to the member. */
interface Member {
  file: string;
  path: readonly string[];
}

/** A line a rule may find something on: the file, the exact text of the line without its indentation, and why. */
interface Exception {
  file: string;
  line: string;
  reason: string;
}

interface Rule {
  id: string;
  what: string;
  /**
   * Declarations of the contracts. One with a path of two names or more is a member: its reads are found by
   * name and judged by the checker. All of them are looked for in the compiler's list of deprecated uses.
   */
  members?: readonly Member[];
  /** Names found wherever they stand as an identifier (an import, a type, a call, a property). */
  identifiers?: readonly string[];
  /** Words found inside string, template and regular-expression literals (a path in data, a list of keys). */
  words?: readonly string[];
  /** Whole strings. */
  strings?: readonly string[];
  exceptions: readonly Exception[];
}

const DEFS = 'src/core/contracts/defs.ts';

/** Reasons that several lines share. */
const EVERY_VEHICLE = 'every vehicle of the definitions in turn: none is looked up by an id';
const LAB_CHOICE = 'not a runtime id: the vehicle the lab was asked for in its URL, else the first of the definitions';
const FAKE_CABIN = "a producer: the fake states the cabin of its craft (`CraftSnapshot.cockpit`) from the vehicle it is published as, as a session's assembler does";
const NOT_A_VEHICLE = "not a vehicle: 'cockpit' is the id of a render feature, a key of the table of frame times (a dictionary has no member the checker could name)";
const ORIGIN_OF_A_PRODUCER = 'the test of a producer: where the fake puts the origin is what it asserts (the origin body at zero, the other 384,000 km away)';

const RULES: readonly Rule[] = [
  {
    id: 'pause',
    what: "names the retired button action 'pause' (it is 'flightMenu'; the contract's union no longer has it, and a string is not held by the compiler)",
    strings: ['pause'],
    exceptions: [{ file: 'src/audio/config.ts', line: "pause: { fadeTime: n.get('pause').get('fadeTime').num({ gt: 0, max: 5 }) },", reason: 'not the action: the `pause` block of the audio mix data (`mix.pause.fadeTime`)' }],
  },
  {
    id: 'vehicles',
    what: 'looks a vehicle definition up by a value, or searches, loops over or hands on the table of vehicles (the snapshot states what a consumer needs: `CraftSnapshot`, `StageInfo`, `PartSnapshot`)',
    members: [{ file: DEFS, path: ['DefLibrary', 'vehicles'] }],
    exceptions: [
      // By an id that is not out of a snapshot.
      {
        file: 'src/app/main.ts',
        line: "loading.setHeading(scenario.name, scenario.start.kind === 'pad' ? (defs.sites[scenario.site]?.name ?? '') : (defs.vehicles[scenario.vehicle]?.name ?? ''));",
        reason: 'not a runtime id: the vehicle a SCENARIO of the definitions names (`scenario.vehicle`), for the heading of the loading screen',
      },
      {
        file: 'src/core/fakes/fakeSession.ts',
        line: "const vehicle = this.scenario.vehicle !== '' ? this.defs.vehicles[this.scenario.vehicle] : undefined;",
        reason: 'a producer: the vehicle the fake is published as (its own `scenario.vehicle`), from which it states the craft block and the stage words as a session does',
      },
      { file: 'labs/vehicle/labSim.ts', line: 'return this.defs.vehicles[this.vehicleId]!.stages.map((s) => s.label);', reason: 'a producer: the lab simulation reads the vehicle it was built from (its own `vehicleId`) for its stage labels' },
      { file: 'labs/audio/labVehicle.ts', line: 'const v = lib.vehicles[vehicleId];', reason: `${LAB_CHOICE} (\`placeVehicle\` builds the lab's parts from that definition)` },
      { file: 'labs/integration/features.ts', line: 'const vehicle = defs.vehicles[vehicleId];', reason: `${LAB_CHOICE} (\`realVesselParts\` assembles the fake's parts from it)` },
      { file: 'labs/integration/main.ts', line: '...(defs.vehicles[vehicleId] ? { vesselName: defs.vehicles[vehicleId]!.name } : {}),', reason: `${LAB_CHOICE} (the name the fake's vessel is given)` },
      // A library with another vehicle in it: a producer of definitions.
      { file: 'labs/flight-ui/labVehicle.ts', line: 'vehicles: { ...defs.vehicles, [vehicle.id]: vehicle },', reason: 'a producer of definitions: the library with the lab vehicle added to it' },
      {
        file: 'tests/unit/flight-ui/resources.test.ts',
        line: 'const library: DefLibrary = { ...defs, vehicles: { ...defs.vehicles, [vehicle.id]: swapped } };',
        reason: 'a producer of definitions: the library with one vehicle whose groups are listed the other way round, flown by a session of its own (the order of the resource groups follows the file)',
      },
      // Every vehicle of the definitions.
      // Which vehicles can be shown: the one module that says so (the vessel feature, the menu, the labs and the tests ask it).
      { file: 'src/core/access/presentable.ts', line: 'const vehicle = defs.vehicles[vehicleId];', reason: 'the definition of PRESENTABLE: whether the vehicle of that id can be shown is a fact of its definition (its parts and their visuals), asked by the id a menu or a lab offers' },
      {
        file: 'src/core/access/presentable.ts',
        line: 'return Object.values(defs.vehicles).filter((v) => isPresentableVehicle(defs, v.id));',
        reason: `${EVERY_VEHICLE} (those that can be shown: the vessel feature builds their models at start, a lab keeps a library of them)`,
      },
      { file: 'tests/unit/audio/mapping.test.ts', line: 'const chase = Object.values(defs.vehicles).map((v) => v.cameras.chase);', reason: `${EVERY_VEHICLE} (the chase distances of each, for the range a camera is heard over)` },
      { file: 'tests/unit/flight-ui/camera.test.ts', line: 'const withCockpit = Object.values(defs.vehicles).filter((v) => v.cockpit !== null);', reason: `${EVERY_VEHICLE} (those with a cabin, each published by a fake of its own)` },
      {
        file: 'tests/unit/flight-ui/resources.test.ts',
        line: 'const libraryVehicles = (): VehicleDef[] => Object.values(defs.vehicles).filter((v) => v.stageGroups.length > 0);',
        reason: `${EVERY_VEHICLE} (each flown by a session of its own and held to the computation of before the sweep)`,
      },
      { file: 'tests/unit/vehicle/mounts.test.ts', line: 'for (const vehicle of Object.values(defs.vehicles)) {', reason: EVERY_VEHICLE },
    ],
  },
  {
    id: 'cockpitCamera',
    what: 'takes the cockpit camera (its part, its seat) from a vehicle definition, `cameras.cockpit` (the craft states its cabin: `cabinOf` of src/core/access/snapshotAccess.ts, `CraftSnapshot.cockpit`)',
    members: [{ file: DEFS, path: ['VehicleDef', 'cameras', 'cockpit'] }],
    exceptions: [
      { file: 'src/core/fakes/fakeSession.ts', line: 'const authored = vehicle && vehicle.cameras.cockpit?.part === commandPart ? vehicle : undefined;', reason: FAKE_CABIN },
      {
        file: 'src/core/fakes/fakeSession.ts',
        line: 'return { id, cameraSeat: id === null ? null : (authored?.cameras.cockpit?.seat ?? null), sensorMount: own?.sensorCamera ?? null, crew };',
        reason: FAKE_CABIN,
      },
      {
        file: 'tests/unit/flight-ui/camera.test.ts',
        line: 'expect(s.vessels[0]!.crafts[0]!.cockpit, vehicle.id).toEqual({ id: vehicle.cockpit, cameraSeat: vehicle.cameras.cockpit!.seat, sensorMount: null, crew: vehicle.crew.map((m) => ({ seat: m.seat, name: m.name })) });',
        reason: "the test of a producer: the fake's craft block states the cabin its vehicle's file authors",
      },
      { file: 'src/app/timing.test.ts', line: "const c = t.stats().features['cockpit']!;", reason: NOT_A_VEHICLE },
      { file: 'src/app/timing.test.ts', line: "expect(slow[0]!.features['cockpit']).toBeCloseTo(16, 9);", reason: NOT_A_VEHICLE },
    ],
  },
  {
    id: 'origin',
    what: 'takes a ROOT position for a distance from a body or compares one with zero (ROOT positions are about the render root, which is replaced: use differences)',
    exceptions: [
      { file: 'tests/unit/fakes/fakeSession.test.ts', line: 'expect(v3.len(body.rRoot), `${label}: origin body at the origin`).toBe(0);', reason: ORIGIN_OF_A_PRODUCER },
      { file: 'tests/unit/fakes/fakeSession.test.ts', line: 'expect(v3.len(moonF.rRoot)).toBe(0);', reason: ORIGIN_OF_A_PRODUCER },
      { file: 'tests/unit/fakes/fakeSession.test.ts', line: 'expect(v3.len(moonR.rRoot)).toBeGreaterThan(3.5e8);', reason: ORIGIN_OF_A_PRODUCER },
      {
        file: 'tests/unit/fakes/frameAccess.test.ts',
        line: 'expect(v3.len(bodyOf(old, vessel0.bodyId).rRoot)).toBeLessThan(1e-2);',
        reason: 'the test of the rebase functions: where the origin is after a rebase is what it asserts (the body of the new origin at zero)',
      },
      {
        file: 'tests/unit/fakes/frameAccess.test.ts',
        line: 'expect(v3.len(bodyOf(moved.snapshot, vessel.bodyId).rRoot)).toBe(0);',
        reason: 'the test of the translation of a frame to another origin: the body of the new origin at zero is what it asserts',
      },
      { file: 'tests/unit/flight-ui/camera.test.ts', line: 'expect(v3.len(moon.rRoot)).toBeGreaterThan(3e8);', reason: 'a test states that its scene is drawn about the far origin, to show that the map rig does not care' },
      {
        file: 'tests/unit/render-core/frameMath.test.ts',
        line: 'expect(v3.len(v1.rRoot)).toBeGreaterThan(6.3e6);',
        reason: 'a test states how far from the origin its vessel is, to show that the camera-relative poses keep their precision there',
      },
    ],
  },
  {
    id: 'html',
    what: 'has a script or an event handler written into a page (the walk reads modules: move the code into one)',
    exceptions: [],
  },
];

// ------------------------------------------------------------------------------------------------ the walk

interface Hit {
  rule: string;
  file: string;
  /** 1-based. */
  line: number;
  /** The line without its indentation: what an exception names. */
  text: string;
  why: string;
}

type StringLike = StringLiteral | NoSubstitutionTemplateLiteral;
const isStringLike = (n: Node): n is StringLike => isStringLiteral(n) || isNoSubstitutionTemplateLiteral(n);
const sameNode = (a: Node, b: Node): boolean => a === b || (a.kind === b.kind && a.pos === b.pos && a.end === b.end);
/** The name a property name states: `name`, `'name'`, `['name']`; undefined for a name that is computed from a value. */
function keyOf(name: Node | undefined): Identifier | StringLike | undefined {
  if (!name) return undefined;
  if (isIdentifier(name) || isStringLike(name)) return name;
  return isComputedPropertyName(name) && isStringLike(name.expression) ? name.expression : undefined;
}
const isJsDoc = (n: Node): boolean => n.kind >= SyntaxKind.FirstJSDocNode && n.kind <= SyntaxKind.LastJSDocNode;

/** The declaration a member path names in a file of the contracts, or undefined when it is not declared there (any more). */
function locate(sf: SourceFile, names: readonly string[]): Node | undefined {
  const nameOf = (n: Node): string | undefined => {
    if (isInterfaceDeclaration(n) || isTypeAliasDeclaration(n)) return n.name.text;
    if (isFunctionDeclaration(n)) return n.name?.text;
    if (isPropertySignatureDeclaration(n)) return isIdentifier(n.name) || isStringLike(n.name) ? n.name.text : undefined;
    return undefined;
  };
  let scope: readonly Node[] = sf.statements;
  for (let i = 0; i < names.length; i++) {
    const found = scope.find((n) => nameOf(n) === names[i]);
    if (!found) return undefined;
    if (i === names.length - 1) return found;
    if (isInterfaceDeclaration(found)) scope = found.members;
    else if ((isPropertySignatureDeclaration(found) || isTypeAliasDeclaration(found)) && isTypeLiteralNode(found.type)) scope = found.type.members;
    else return undefined;
  }
  return undefined;
}

/** `node` with the parentheses, non-null marks and assertions around it taken off. */
function bare(node: Node): Node {
  let n = node;
  while (isParenthesizedExpression(n) || isNonNullExpression(n) || isAsExpression(n) || isSatisfiesExpression(n) || isTypeAssertion(n)) n = n.expression;
  return n;
}

/** `node` with the parentheses and non-null marks around it: the node whose parent decides what is done with the value. */
function wrapped(node: Node): Node {
  let n = node;
  while (isParenthesizedExpression(n.parent) || isNonNullExpression(n.parent)) n = n.parent;
  return n;
}

/**
 * An object (or array) literal that is the TARGET of an assignment is a destructuring pattern: `source` is
 * what the outermost pattern is assigned from, absent for a pattern inside another and for a loop variable.
 */
function assignmentPattern(node: Node): { source?: Expression } | null {
  const child = wrapped(node);
  const p = child.parent;
  if (isBinaryExpression(p) && p.operatorToken.kind === SyntaxKind.EqualsToken && sameNode(p.left, child)) return { source: p.right };
  if (isForOfStatement(p) && sameNode(p.initializer, child)) return {};
  if (isPropertyAssignment(p) && sameNode(p.initializer, child) && isObjectLiteralExpression(p.parent)) return assignmentPattern(p.parent) ? {} : null;
  if (isArrayLiteralExpression(p)) return assignmentPattern(p) ? {} : null;
  return null;
}

/**
 * Whether a declaration is written for a type assertion: inside the type of one (`x as { pad: ... }`,
 * `<{ ... }>x`), or in a type of the file's own (an interface, a type alias) that an assertion of the same file
 * names (`type Site = { pad: ... }; (x as Site).pad`). Either way the file restates the member and asserts a
 * value into it. `asserted`: the type names the assertions of the declaration's file name.
 */
function writtenForAssertion(declaration: Node, asserted: ReadonlySet<string> | undefined): boolean {
  let child = declaration;
  for (let p: Node | undefined = declaration.parent; p; p = p.parent) {
    if ((isAsExpression(p) || isTypeAssertion(p)) && sameNode(p.type, child)) return true;
    if ((isInterfaceDeclaration(p) || isTypeAliasDeclaration(p)) && asserted?.has(p.name.text)) return true;
    child = p;
  }
  return false;
}

/** The names of the types a type names (`Site`, `Site[]`, `{ a: Site | null }`), into `out`. */
function typeNames(type: Node, out: Set<string>): void {
  if (isTypeReferenceNode(type) && isIdentifier(type.typeName)) out.add(type.typeName.text);
  type.forEachChild((child) => typeNames(child, out));
}

/**
 * The names a function reads that are not its own: not a parameter, not declared inside it. A function
 * without any can only tell things about the value it is handed.
 */
function namesFromOutside(fn: ArrowFunction | FunctionExpression): string[] {
  const own = new Set<string>(['undefined']);
  const read: string[] = [];
  const visit = (n: Node): void => {
    if (isTypeNode(n) || isJsDoc(n)) return;
    if (isIdentifier(n)) {
      const p = n.parent;
      if ((isPropertyAccessExpression(p) || isPropertyAssignment(p)) && sameNode(p.name, n)) return;
      if (isBindingElement(p) && p.propertyName && sameNode(p.propertyName, n)) return;
      if ((isBindingElement(p) || isVariableDeclaration(p) || isParameterDeclaration(p) || isFunctionDeclaration(p) || isFunctionExpression(p)) && p.name && sameNode(p.name, n)) own.add(n.text);
      else read.push(n.text);
      return;
    }
    n.forEachChild(visit);
  };
  fn.forEachChild(visit);
  return read.filter((name) => !own.has(name));
}

/** Array functions that answer with one entry, one index or yes / no, and those that answer with a list again. */
const ONE_OF_A_LIST = new Set(['find', 'findLast', 'findIndex', 'findLastIndex', 'some', 'every']);
const LIST_OF_A_LIST = new Set(['filter', 'map', 'flatMap']);

/**
 * What is done with a list of vehicle definitions (`Object.values(defs.vehicles)`, `Object.entries(...)`, or
 * what `filter` / `map` made of one). Permitted: its length, its n-th entry, and a function of the two sets
 * above with a test that reads nothing from outside the entry it is handed; for `filter` and `map` the list
 * they answer with is judged the same way.
 */
function listUse(list: Node): { ok: boolean; why: string } {
  const value = wrapped(list);
  const q = value.parent;
  if (isElementAccessExpression(q) && sameNode(q.expression, value) && isNumericLiteral(q.argumentExpression)) return { ok: true, why: '' };
  if (isPropertyAccessExpression(q) && sameNode(q.expression, value)) {
    if (q.name.text === 'length') return { ok: true, why: '' };
    const call = q.parent;
    if ((ONE_OF_A_LIST.has(q.name.text) || LIST_OF_A_LIST.has(q.name.text)) && isCallExpression(call) && sameNode(call.expression, q)) {
      const test = call.arguments[0];
      if (test && (isArrowFunction(test) || isFunctionExpression(test))) {
        const outside = namesFromOutside(test);
        if (outside.length > 0) return { ok: false, why: `the vehicles searched by a test that reads ${[...new Set(outside)].join(', ')} from outside the definition it is handed` };
        return ONE_OF_A_LIST.has(q.name.text) ? { ok: true, why: '' } : listUse(call);
      }
    }
  }
  return { ok: false, why: 'the list of every vehicle definition kept, looped over or handed on (a count, the n-th entry and a search by a test of the definition alone say what is looked up)' };
}

/**
 * What is done with the table of vehicles at one place it is named. `ok`: one of the permitted uses. `index`:
 * permitted when that expression is a constant of the code (the checker is asked for its type).
 */
function vehiclesUse(access: Node | undefined): { ok: boolean; index?: Expression; why: string } {
  if (!access) return { ok: false, why: 'the table of vehicles taken out by a destructuring pattern' };
  const value = wrapped(access);
  const p = value.parent;
  if (isElementAccessExpression(p) && sameNode(p.expression, value)) {
    if (isStringLike(p.argumentExpression)) return { ok: true, why: '' };
    return { ok: false, index: p.argumentExpression, why: `a vehicle definition looked up by a value, [${p.argumentExpression.getText()}], that is not a constant of the code` };
  }
  if (isCallExpression(p) && p.arguments.length === 1 && sameNode(p.arguments[0]!, value) && isPropertyAccessExpression(p.expression) && isIdentifier(p.expression.expression) && p.expression.expression.text === 'Object') {
    // The ids alone look nothing up: a definition is only had by an index, which is judged where it stands.
    if (p.expression.name.text === 'keys') return { ok: true, why: '' };
    if (p.expression.name.text === 'values' || p.expression.name.text === 'entries') return listUse(p);
  }
  return { ok: false, why: 'the table of vehicles kept, handed on or spread (an index by a constant, the ids, a count, the n-th entry and a search by a test of the definition alone say what is looked up)' };
}

const ROOT_POSITIONS = new Set(['rRoot', 'positionRoot']);
const memberName = (n: Node): string | undefined => (isPropertyAccessExpression(n) ? n.name.text : isElementAccessExpression(n) && isStringLike(n.argumentExpression) ? n.argumentExpression.text : undefined);
const isRootPosition = (e: Node): boolean => ROOT_POSITIONS.has(memberName(bare(e)) ?? '');
function isRootComponent(e: Node): boolean {
  const n = bare(e);
  return ['x', 'y', 'z'].includes(memberName(n) ?? '') && (isPropertyAccessExpression(n) || isElementAccessExpression(n)) && isRootPosition(n.expression);
}
function isZero(e: Node): boolean {
  const n = bare(e);
  if (isPrefixUnaryExpression(n) && n.operator === SyntaxKind.MinusToken) return isZero(n.operand);
  return isNumericLiteral(n) && Number(n.text) === 0;
}
const COMPARISONS: readonly SyntaxKind[] = [SyntaxKind.EqualsEqualsEqualsToken, SyntaxKind.EqualsEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken, SyntaxKind.ExclamationEqualsToken];

/** How a finding that is not the member by its declaration is put (the self-test reads these). */
const UNTYPED = 'of a value whose type does not say what it is';
const BY_NAME_ALONE = 'found by its name alone';
const ASSERTED = 'through a type assertion that restates the member';
const BY_THE_COMPILER = 'the compiler';

interface Scan {
  hits: Hit[];
  /** What keeps the scan from proving its line: a member the contracts no longer declare, a file outside the program. */
  problems: string[];
}

/** One place a watched name is read, before the checker has said what the name is. */
interface NameUse {
  name: string;
  file: string;
  sf: SourceFile;
  at: Node;
  form: string;
  /** How the checker is asked: the symbol at the name, the property of the type of another node, or not at all. */
  ask: 'symbol' | 'property' | 'none';
  typeOf?: Node;
  /** The access expression (for what is done with the value); absent for a pattern. */
  access?: Node;
}

/** The findings of `rules` in `files` (paths from the root of the repository, modules of `project`). */
function scan(project: Project, files: readonly string[], rules: readonly Rule[]): Scan {
  const { program, checker } = project;
  const hits: Hit[] = [];
  const problems: string[] = [];

  // The declarations the rules name.
  interface Located {
    rule: Rule;
    member: Member;
    node: Node;
    sf: SourceFile;
  }
  const located: Located[] = [];
  for (const rule of rules) {
    for (const member of rule.members ?? []) {
      const gone = `rule "${rule.id}": ${member.file} does not declare ${member.path.join('.')} (when the contracts have dropped the member, take the rule out)`;
      const sf = program.getSourceFile(`${ROOT}/${member.file}`);
      if (!sf) {
        // A module the program does not contain declares nothing its files could use (the self-test's project
        // has no module of the simulation); a file that is gone from the disk is a member that is gone.
        if (!fs.existsSync(path.join(ROOT, member.file))) problems.push(gone);
        continue;
      }
      const node = locate(sf, member.path);
      if (node) located.push({ rule, member, node, sf });
      else problems.push(gone);
    }
  }
  const watched = new Map<string, Located[]>();
  for (const l of located) {
    if (l.member.path.length < 2) continue;
    const name = l.member.path[l.member.path.length - 1]!;
    watched.set(name, [...(watched.get(name) ?? []), l]);
  }
  const identifierRules = rules.filter((r) => r.identifiers && r.identifiers.length > 0);
  const stringRules = rules.filter((r) => (r.strings && r.strings.length > 0) || (r.words && r.words.length > 0));
  const words = new Map<string, RegExp>();
  for (const rule of rules) for (const word of rule.words ?? []) words.set(word, new RegExp(`(?<![\\w$])${word}(?![\\w$])`));
  const origin = rules.find((r) => r.id === 'origin');
  const vehicles = rules.find((r) => r.id === 'vehicles');

  const lines = new Map<SourceFile, string[]>();
  const hit = (rule: Rule, file: string, sf: SourceFile, position: number, why: string): void => {
    let text = lines.get(sf);
    if (!text) lines.set(sf, (text = sf.text.split('\n')));
    const line = sf.getLineAndCharacterOfPosition(position).line;
    hits.push({ rule: rule.id, file, line: line + 1, text: (text[line] ?? '').trim(), why });
  };

  const uses: NameUse[] = [];
  const sources = new Map<string, SourceFile>();
  /** The type names the type assertions of each walked file name, by the file's path. */
  const asserted = new Map<string, Set<string>>();
  for (const file of files) {
    const sf = program.getSourceFile(`${ROOT}/${file}`);
    if (!sf) {
      problems.push(`${file} is not a module of the program of tsconfig.json: it cannot be walked`);
      continue;
    }
    sources.set(file, sf);
    const assertedHere = new Set<string>();
    asserted.set(pathKey(sf.path), assertedHere);
    const use = (name: string, at: Node, form: string, ask: NameUse['ask'], typeOf?: Node, access?: Node): void => {
      if (watched.has(name)) uses.push({ name, file, sf, at, form, ask, ...(typeOf ? { typeOf } : {}), ...(access ? { access } : {}) });
    };
    const visit = (node: Node): void => {
      if (isJsDoc(node)) return;
      if (isAsExpression(node) || isTypeAssertion(node)) typeNames(node.type, assertedHere);
      if (isPropertyAccessExpression(node)) use(node.name.text, node.name, `.${node.name.text}`, 'symbol', undefined, node);
      else if (isElementAccessExpression(node) && isStringLike(node.argumentExpression)) use(node.argumentExpression.text, node.argumentExpression, `['${node.argumentExpression.text}']`, 'symbol', undefined, node);
      else if (isBindingElement(node) && isObjectBindingPattern(node.parent)) {
        // `{ name }`, `{ name: local }`, `{ ['name']: local }`: the member is the property name. The checker names
        // the property of a plain `name: local`; for the other two it is asked for the type that is taken apart.
        const key = keyOf(node.propertyName ?? node.name);
        if (key) use(key.text, key, `{ ${key.text} } in a destructuring pattern`, node.propertyName && isIdentifier(node.propertyName) ? 'symbol' : 'property', node.parent);
      } else if (isObjectLiteralExpression(node)) {
        const pattern = assignmentPattern(node);
        if (pattern) {
          for (const property of node.properties) {
            const key = isPropertyAssignment(property) || isShorthandPropertyAssignment(property) ? keyOf(property.name) : undefined;
            if (key) use(key.text, key, `{ ${key.text} } in a destructuring assignment`, pattern.source ? 'property' : 'none', pattern.source);
          }
        }
      } else if (isQualifiedName(node)) use(node.right.text, node.right, `.${node.right.text} in a type`, 'symbol');
      else if (isIndexedAccessTypeNode(node) && isLiteralTypeNode(node.indexType) && isStringLike(node.indexType.literal)) use(node.indexType.literal.text, node.indexType.literal, `['${node.indexType.literal.text}'] of a type`, 'symbol');

      if (isIdentifier(node)) {
        for (const rule of identifierRules) if (rule.identifiers!.includes(node.text)) hit(rule, file, sf, node.getStart(sf), `the name ${node.text}`);
      } else if (isStringLike(node) || isTemplateHead(node) || isTemplateMiddle(node) || isTemplateTail(node) || isRegularExpressionLiteral(node)) {
        for (const rule of stringRules) {
          if (isStringLike(node) && rule.strings?.includes(node.text)) hit(rule, file, sf, node.getStart(sf), `the string '${node.text}'`);
          for (const word of rule.words ?? []) if (words.get(word)!.test(node.text)) hit(rule, file, sf, node.getStart(sf), `${word} named in a string (a path, a key)`);
        }
      }

      if (origin && isCallExpression(node) && node.arguments.length === 1) {
        const callee = isIdentifier(node.expression) ? node.expression.text : isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
        if ((callee === 'len' || callee === 'lenSq') && isRootPosition(node.arguments[0]!)) hit(origin, file, sf, node.getStart(sf), `${callee}() of a ROOT position: its distance from the origin`);
      }
      if (origin && isBinaryExpression(node) && COMPARISONS.includes(node.operatorToken.kind)) {
        if ((isRootComponent(node.left) && isZero(node.right)) || (isRootComponent(node.right) && isZero(node.left))) hit(origin, file, sf, node.getStart(sf), 'a component of a ROOT position compared with zero');
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }

  // What each name is, by the checker: two requests for all the files.
  const symbols = new Map<NameUse, CheckerSymbol | undefined>();
  const bySymbol = uses.filter((u) => u.ask === 'symbol');
  if (bySymbol.length > 0) checker.getSymbolAtLocation(bySymbol.map((u) => u.at)).forEach((symbol, i) => symbols.set(bySymbol[i]!, symbol));
  const byProperty = uses.filter((u) => u.ask === 'property');
  if (byProperty.length > 0) {
    checker.getTypeAtLocation(byProperty.map((u) => u.typeOf!)).forEach((type, i) => {
      const u = byProperty[i]!;
      symbols.set(u, type ? checker.getPropertyOfType(type, u.name) : undefined);
    });
  }

  /** Why a use of a watched name is a finding, with the rule; null when the checker shows the name to be another declared member. */
  const judge = (u: NameUse): { rule: Rule; why: string } | null => {
    const candidates = watched.get(u.name)!;
    if (u.ask === 'none') return { rule: candidates[0]!.rule, why: `${u.form}, in a pattern inside another: ${BY_NAME_ALONE}` };
    const symbol = symbols.get(u);
    if (!symbol || symbol.declarations.length === 0) return { rule: candidates[0]!.rule, why: `${u.form} ${UNTYPED}` };
    for (const d of symbol.declarations) {
      for (const l of candidates) {
        if (!samePath(d.path, l.sf.path)) continue;
        const node = d.resolve(project);
        if (node && sameNode(node, l.node)) return { rule: l.rule, why: `${u.form}: ${l.member.path.join('.')}` };
      }
    }
    for (const d of symbol.declarations) {
      if (d.path.includes('/node_modules/')) continue;
      const node = d.resolve(project);
      if (node && writtenForAssertion(node, asserted.get(pathKey(d.path)))) return { rule: candidates[0]!.rule, why: `${u.form} ${ASSERTED}` };
    }
    return null;
  };

  const indexed: { u: NameUse; index: Expression; why: string }[] = [];
  for (const u of uses) {
    const verdict = judge(u);
    if (!verdict) continue;
    if (vehicles && verdict.rule === vehicles) {
      const done = vehiclesUse(u.access);
      if (done.ok) continue;
      if (done.index) indexed.push({ u, index: done.index, why: done.why });
      else hit(vehicles, u.file, u.sf, u.at.getStart(u.sf), done.why);
      continue;
    }
    hit(verdict.rule, u.file, u.sf, u.at.getStart(u.sf), verdict.why);
  }
  // An index is a constant of the code when its type is one string.
  if (vehicles && indexed.length > 0) {
    checker.getTypeAtLocation(indexed.map((x) => x.index)).forEach((type, i) => {
      const { u, why } = indexed[i]!;
      if (!type || (type.flags & TypeFlags.StringLiteral) === 0) hit(vehicles, u.file, u.sf, u.at.getStart(u.sf), why);
    });
  }

  // The compiler's own list of uses of a declaration marked @deprecated.
  for (const [file, sf] of sources) {
    for (const d of program.getSuggestionDiagnostics(`${ROOT}/${file}`)) {
      if (!d.reportsDeprecated) continue;
      for (const related of d.relatedInformation ?? []) {
        const l = located.find((x) => related.fileName !== undefined && samePath(related.fileName, x.sf.fileName) && x.node.pos <= related.pos && related.pos < x.node.end);
        if (l) hit(l.rule, file, sf, d.pos, `${BY_THE_COMPILER}: ${d.text} (${l.member.path.join('.')})`);
      }
    }
  }

  // One finding per rule and line.
  const seen = new Set<string>();
  return {
    hits: hits.filter((h) => {
      const key = `${h.rule}|${h.file}|${h.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    problems,
  };
}

/** The findings in a page: a quoted 'pause', and code the walk cannot read (a script without a source, an event handler attribute). */
function scanHtml(file: string, text: string, rules: readonly Rule[]): Hit[] {
  const out: Hit[] = [];
  const pause = rules.find((r) => r.id === 'pause');
  const html = rules.find((r) => r.id === 'html');
  const visible = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  visible.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (pause && /['"]pause['"]/.test(line)) out.push({ rule: pause.id, file, line: i + 1, text: line, why: "the string 'pause'" });
    if (html && ((/<script\b/i.test(line) && !/<script\b[^>]*\bsrc\s*=/i.test(line)) || /\son[a-z]+\s*=\s*['"]/i.test(line))) out.push({ rule: html.id, file, line: i + 1, text: line, why: 'code written into the page' });
  });
  return out;
}

/** The findings of a rule no exception lists, and the exceptions that list nothing found. */
function settle(hits: readonly Hit[], exceptions: readonly Exception[]): { unlisted: string[]; stale: string[] } {
  const excepted = (h: Hit): boolean => exceptions.some((e) => e.file === h.file && e.line === h.text);
  return {
    unlisted: hits.filter((h) => !excepted(h)).map((h) => `${h.file}:${h.line}: ${h.text}\n    (${h.why})`),
    stale: exceptions.filter((e) => !hits.some((h) => h.file === e.file && h.text === e.line)).map((e) => `${e.file}: ${e.line}`),
  };
}

// ------------------------------------------------------------------------------------------------ what is scanned

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
  'src/core/ui',
  'labs',
  'tests/browser',
  'tests/unit/atmosphere',
  'tests/unit/audio',
  'tests/unit/camera',
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
/** Code in a form the walk does not read: a file of one of these kinds in a scanned tree fails the test. */
const OTHER_CODE = ['.js', '.mjs', '.cjs', '.jsx', '.tsx', '.mts', '.cts', '.vue', '.svelte'];

/** The modules and pages under `dir` into `out`; code of another kind into `unread`. */
function filesUnder(dir: string, out: string[], unread: string[]): void {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (NOT_SCANNED.some((x) => rel === x || rel.startsWith(x))) continue;
    if (e.isDirectory()) filesUnder(rel, out, unread);
    else if (rel.endsWith('.ts') || rel.endsWith('.html')) out.push(rel);
    else if (OTHER_CODE.some((x) => rel.endsWith(x))) unread.push(rel);
  }
}

// ------------------------------------------------------------------------------------------------ the sources of the self-test

/**
 * A project that exists only here: its tsconfig and its modules are served to the compiler from memory (the
 * directory is not on the disk, so the project of the tree does not contain it). The modules name the real
 * contracts, so the rules judge them as they judge the tree. A line that must be found ends in `// flag: <rule
 * id>` (several with commas); every other line must not be found. After the id the mark says how the line is
 * found when it is not by the walk naming the member or the word itself: `untyped` (the value has no type that
 * says what the name is), `asserted` (a type assertion restates the member), `by the compiler` (only the
 * compiler's list of deprecated uses has it).
 */
const SYNTHETIC = 'tests/unit/fakes/deprecated-synthetic';
const HEAD = `
import type { DefLibrary, VehicleDef } from '@/core/contracts/defs';
import type { CraftSnapshot, SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
declare const s: SimSnapshot;
declare const defs: DefLibrary;
declare const vessel: VesselSnapshot;
declare const vehicle: VehicleDef;
declare const loose: any;
`;
const SYNTHETIC_SOURCES: Record<string, string> = {
  // The evasions the review named, and their neighbours.
  'destructuring.ts': `${HEAD}
export const { vehicles } = defs; // flag: vehicles
export const { cameras: { cockpit } } = vehicle; // flag: cockpitCamera
export const { cameras: { cockpit: camera } } = vehicle; // flag: cockpitCamera
export function parameter({ cameras: { cockpit: seat } }: VehicleDef): unknown { // flag: cockpitCamera
  return seat;
}
export const { cameras: { cockpit: fallback = null } } = vehicle; // flag: cockpitCamera
export function untyped(): unknown {
  const { cockpit } = loose; // flag: cockpitCamera untyped
  return cockpit;
}
let k1: unknown;
let k2: unknown;
let k3: unknown;
({ cockpit: k1 } = vehicle.cameras); // flag: cockpitCamera
({ cockpit: k2 } = loose); // flag: cockpitCamera untyped
[{ cockpit: k3 }] = [vehicle.cameras]; // flag: cockpitCamera untyped
export const assigned = [k1, k2, k3];
export const { ['cameras']: { 'cockpit': quoted } } = vehicle; // flag: cockpitCamera
export const { ['cockpit']: computedLoose } = loose; // flag: cockpitCamera untyped
export const { cameras: { chase } } = vehicle;
`,
  'brackets.ts': `${HEAD}
export const a1 = vehicle.cameras['cockpit']; // flag: cockpitCamera
export const a3 = vehicle.cameras[\`cockpit\`]; // flag: cockpitCamera
export const a4 = vehicle?.cameras?.['cockpit']; // flag: cockpitCamera
export const a5 = defs['vehicles'][vessel.vehicleId]; // flag: vehicles
export const a6 = vehicle['cameras']['cockpit']; // flag: cockpitCamera
export const a7 = [(vehicle as VehicleDef)!.cameras.cockpit, vehicle?.cameras.cockpit]; // flag: cockpitCamera
export type T1 = VehicleDef['cameras']['cockpit']; // flag: cockpitCamera
export type T2 = typeof vehicle.cameras.cockpit; // flag: cockpitCamera
`,
  'intermediate.ts': `${HEAD}
const cams = vehicle.cameras;
export const b5 = cams.cockpit?.seat; // flag: cockpitCamera
const library = defs;
export const b6 = library.vehicles[vessel.vehicleId]; // flag: vehicles
`,
  'untyped.ts': `${HEAD}
export const c4 = loose.cameras.cockpit; // flag: cockpitCamera untyped
export const c5 = loose.vehicles[loose.id]; // flag: vehicles
export const c6 = (loose as { cockpit: { seat: string } }).cockpit; // flag: cockpitCamera asserted
export const c7 = (<{ cockpit: number }>loose).cockpit; // flag: cockpitCamera asserted
type Restated = { cockpit: number; cameras: { cockpit: number } };
export const c11 = (loose as Restated).cockpit; // flag: cockpitCamera asserted
export const c12 = (loose as Restated[])[0]!.cameras.cockpit; // flag: cockpitCamera asserted
`,
  'vehicles.ts': `${HEAD}
export const v1 = defs.vehicles[vessel.vehicleId]; // flag: vehicles
export const v2 = defs.vehicles[[vessel.vehicleId][0]!]; // flag: vehicles
const id = vessel.vehicleId;
export const v3 = defs.vehicles[id]!; // flag: vehicles
export const v4 = Object.values(defs.vehicles).find((d) => d.id === vessel.vehicleId); // flag: vehicles
export const v5 = Object.values(defs.vehicles).find((d) => vessel.parts.some((p) => p.instanceId === d.parts[0]?.id)); // flag: vehicles
export const v6 = Object.entries(defs.vehicles).find(([name]) => name === id); // flag: vehicles
const table = defs.vehicles; // flag: vehicles
export const v7 = table[id];
export const v8: VehicleDef[] = [];
for (const d of Object.values(defs.vehicles)) if (d.id === id) v8.push(d); // flag: vehicles
export const v9 = new Map(Object.entries(defs.vehicles)).get(id); // flag: vehicles
export const v10 = Object.values(defs.vehicles).filter((d) => d.cockpit !== null).find((d) => d.id === id); // flag: vehicles
export const v11 = Object.values(defs.vehicles).filter(() => true); // flag: vehicles
export const v12 = Object.values(defs.vehicles).map((d) => d); // flag: vehicles
export const v13 = Object.values(defs.vehicles)[Object.keys(defs.vehicles).indexOf(id)]; // flag: vehicles
export const v14 = vehicle.cameras.cockpit?.part; // flag: cockpitCamera
export const v15 = defs.vehicles['a']!.cameras.cockpit?.seat; // flag: cockpitCamera
`,
  'names.ts': `${HEAD}
export const action = 'pause'; // flag: pause
declare function len(v: unknown): number;
export const o1 = len(vessel.rRoot); // flag: origin
export const o2 = vessel.rRoot.x === 0; // flag: origin
export const o3 = 0 !== s.vessels[0]!.rRoot!.z; // flag: origin
`,
  // The reads the review found passing the line patterns, as they stood in the tree (with `?.` where the
  // member is optional today).
  'review.ts': `${HEAD}
declare const lab: { app: { defs: DefLibrary; snapshot(): SimSnapshot }; cockpitSeats(): { id: string }[] };
const seats = lab.cockpitSeats();
export const target = seats.find((x) => x.id !== lab.app.defs.vehicles[lab.app.snapshot().vessels[0]!.vehicleId]?.cameras.cockpit?.seat) ?? seats[0]; // flag: vehicles, cockpitCamera
export const found = Object.values(defs.vehicles).find((d) => d.cockpit && vessel.parts.some((p) => p.instanceId === d.cameras.cockpit?.part)); // flag: vehicles, cockpitCamera
export const part = vessel.parts.find((p) => p.instanceId === found?.cameras.cockpit?.part); // flag: cockpitCamera
const vehicleId = vessel.vehicleId;
export const model = defs.vehicles[vehicleId]!.cockpit!; // flag: vehicles
export const own = vessel.parts.find((p) => p.instanceId === defs.vehicles[vehicleId]!.cameras.cockpit?.part)!; // flag: vehicles, cockpitCamera
const v = defs.vehicles[vehicleId]; // flag: vehicles
export const camera = v!.cameras.cockpit; // flag: cockpitCamera
`,
  // What must NOT be found.
  'clean.ts': `${HEAD}
import { cabinOf } from '@/core/access/snapshotAccess';
declare const craft: CraftSnapshot;
declare function len(v: unknown): number;
interface Panel {
  cockpit: number;
  vehicles: string[];
}
declare const panel: Panel;
export const inner = panel.cockpit + panel.vehicles.length;
const { cockpit: gauge, vehicles: listed } = panel;
const { nested: { vehicles: list } } = { nested: panel };
let gauges: number;
({ cockpit: gauges } = panel);
export const sum = gauge + gauges + listed.length + list.length + panel['cockpit'];
export type Gauge = Panel['cockpit'];
export type Gauges = typeof panel.cockpit;
class Cabin {
  private cockpit = 0;
  step(): number {
    return ++this.cockpit;
  }
}
export const counter = new Cabin();
export const stated = { ...vehicle, cameras: { ...vehicle.cameras, cockpit: { part: 'capsule', seat: 'cdr' } } };
const LAB_VEHICLE = 'lab-vehicle';
export const byConstant = defs.vehicles[LAB_VEHICLE];
export const byString = defs.vehicles['meridian-lunar']!;
export const firstId = Object.keys(defs.vehicles)[0]!;
export const ids = Object.keys(defs.vehicles).map((x) => 'vehicle:' + x);
for (const x of Object.keys(defs.vehicles)) ids.push(x);
export const firstOf = Object.values(defs.vehicles)[0]!;
export const count = Object.values(defs.vehicles).length;
export const withCabin = Object.values(defs.vehicles).find((v) => v.cockpit !== null);
export const cabins = Object.values(defs.vehicles).filter((v) => v.cockpit !== null).length;
export const firstName = Object.entries(defs.vehicles).map(([x, v]) => x + v.name)[0];
export const cabin = craft.cockpit;
export const layout = vehicle.cockpit;
export const chase = vehicle.cameras.chase;
export const seat = cabinOf(vessel)?.cameraSeat;
export const paused = 'paused';
export const apart = len({ x: vessel.rRoot.x - s.bodies[0]!.rRoot.x });
export const above = vessel.r.x === 0;
`,
};

const syntheticFiles: Record<string, string> = {
  [`${ROOT}/${SYNTHETIC}/tsconfig.json`]: JSON.stringify({ extends: '../../../../tsconfig.json', compilerOptions: { paths: { '@/*': ['../../../../src/*'] } }, include: ['*.ts'] }),
};
for (const [name, text] of Object.entries(SYNTHETIC_SOURCES)) syntheticFiles[`${ROOT}/${SYNTHETIC}/${name}`] = text;
const syntheticFile = (name: string): string | undefined => Object.entries(syntheticFiles).find(([file]) => samePath(file, name))?.[1];
const isSyntheticDirectory = (name: string): boolean => samePath(name.replace(/[\\/]+$/, ''), `${ROOT}/${SYNTHETIC}`);
/** Answers for the modules of the self-test; `undefined` hands a question on to the disk. */
const syntheticFs: FileSystem = {
  readFile: (name) => syntheticFile(name),
  fileExists: (name) => (syntheticFile(name) !== undefined ? true : undefined),
  directoryExists: (name) => (isSyntheticDirectory(name) ? true : undefined),
  getAccessibleEntries: (name) => (isSyntheticDirectory(name) ? { files: Object.keys(syntheticFiles).map((file) => path.posix.basename(file)), directories: [] } : undefined),
};

// ------------------------------------------------------------------------------------------------ the tests

describe('deprecated reads (the presentation sweep)', () => {
  const files: string[] = [];
  const unread: string[] = [];
  for (const dir of SCANNED) filesUnder(dir, files, unread);
  files.push('index.html');

  let api: API | undefined;
  let tree: Scan = { hits: [], problems: ['the scan did not run'] };
  let synthetic: Scan = { hits: [], problems: ['the scan did not run'] };
  /** Errors of the compiler in the sources of the self-test: a source that does not compile has no types to be judged by. */
  let syntheticErrors: string[] = ['the scan did not run'];

  beforeAll(() => {
    // The compiler is given five seconds to open its pipe; on a machine under load it can take longer to start,
    // so it is started again before the test gives up.
    let refused: unknown;
    for (let attempt = 0; attempt < 3 && !api; attempt++) {
      try {
        api = new API({ cwd: ROOT, fs: syntheticFs });
      } catch (e) {
        refused = e;
      }
    }
    if (!api) throw refused;
    const snapshot = api.updateSnapshot({ openProjects: [`${ROOT}/tsconfig.json`, `${ROOT}/${SYNTHETIC}/tsconfig.json`] });
    const project = snapshot.getProject(`${ROOT}/tsconfig.json`);
    const selfTest = snapshot.getProject(`${ROOT}/${SYNTHETIC}/tsconfig.json`);
    if (!project || !selfTest) throw new Error(`the compiler did not open the two projects (it has: ${snapshot.getProjects().map((p) => p.configFileName).join(', ')})`);
    tree = scan(project, files.filter((f) => f.endsWith('.ts')), RULES);
    for (const file of files.filter((f) => f.endsWith('.html'))) tree.hits.push(...scanHtml(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), RULES));
    synthetic = scan(selfTest, Object.keys(SYNTHETIC_SOURCES).map((name) => `${SYNTHETIC}/${name}`), RULES);
    syntheticErrors = Object.keys(SYNTHETIC_SOURCES).flatMap((name) => {
      const file = `${ROOT}/${SYNTHETIC}/${name}`;
      return [...selfTest.program.getSyntacticDiagnostics(file), ...selfTest.program.getSemanticDiagnostics(file)].map((d) => `${name} at ${d.pos}: ${d.text}`);
    });
  }, 180_000);

  afterAll(() => {
    api?.close();
  });

  it('scans the presentation, the labs, the browser tests and the unit tests of the presentation', () => {
    expect(files.length).toBeGreaterThan(500);
    for (const must of ['src/ui/model.ts', 'src/render/core/renderer.ts', 'src/app/game.ts', 'labs/integration/main.ts', 'tests/browser/integration/origin.spec.ts', 'tests/unit/camera/chase.test.ts', 'labs/cockpit/index.html']) expect(files, must).toContain(must);
    expect(files.some((f) => f.startsWith('tests/browser/shell/'))).toBe(false);
    // No code in a form the walk does not read; every module was walked; the contracts still declare every member the rules name.
    expect(unread).toEqual([]);
    expect(tree.problems.join('\n')).toBe('');
  });

  for (const rule of RULES) {
    it(`no file ${rule.what}`, () => {
      const { unlisted, stale } = settle(tree.hits.filter((h) => h.rule === rule.id), rule.exceptions);
      expect(unlisted.join('\n'), `rule "${rule.id}": findings that no exception lists`).toBe('');
      // An exception that finds nothing has had its day: take it out of the list.
      expect(stale.join('\n'), `rule "${rule.id}": stale exceptions`).toBe('');
    });
  }

  describe('the test itself', () => {
    /** `<file>:<line> <rule>` for every marked line of the sources, and for every finding of the scan. */
    const marked = (): string[] => {
      const out: string[] = [];
      for (const [name, text] of Object.entries(SYNTHETIC_SOURCES)) {
        text.split('\n').forEach((line, i) => {
          const flag = /\/\/ flag: ([\w, ]+)$/.exec(line);
          for (const rule of flag ? flag[1]!.split(',') : []) out.push(`${name}:${i + 1} ${rule.trim()}`);
        });
      }
      return out.sort();
    };
    const how = (h: Hit): string => (h.why.startsWith(BY_THE_COMPILER) ? ' by the compiler' : h.why.includes(ASSERTED) ? ' asserted' : h.why.includes(UNTYPED) || h.why.includes(BY_NAME_ALONE) ? ' untyped' : '');
    const found = (): string[] => synthetic.hits.map((h) => `${path.posix.basename(h.file)}:${h.line} ${h.rule}${how(h)}`).sort();
    const of = (list: string[], name: string): string[] => list.filter((x) => x.startsWith(`${name}:`));

    it('walks its own sources with the real contracts, and the sources compile (so what is typed in them is judged by its type)', () => {
      expect(synthetic.problems.join('\n')).toBe('');
      expect(syntheticErrors).toEqual([]);
      expect(marked().length).toBeGreaterThan(50);
    });

    for (const [name, what] of [
      ['destructuring.ts', 'a destructuring pattern: shorthand, renamed, nested, in a parameter, with a default, in an assignment'],
      ['brackets.ts', 'bracket access with a string, and the types that read a member'],
      ['intermediate.ts', 'an intermediate variable (`const cams = vehicle.cameras; cams.cockpit`)'],
      ['untyped.ts', 'a value without a type, a type assertion that restates the member'],
      ['vehicles.ts', 'a vehicle looked up by a value, by a nested index, through a variable, by `Object.values(...).find(...)`, by a loop; `cameras.cockpit`'],
      ['names.ts', 'the retired action and the origin of ROOT positions'],
      ['review.ts', 'the reads the review found passing the line patterns, as they stood'],
    ] as const) {
      it(`finds ${what}`, () => {
        expect(of(marked(), name).length).toBeGreaterThan(0);
        expect(of(found(), name)).toEqual(of(marked(), name));
      });
    }

    it('finds nothing in a source that reads through the access functions, names its own members, states the fields or uses the vehicles as permitted', () => {
      expect(of(marked(), 'clean.ts')).toEqual([]);
      expect(synthetic.hits.filter((h) => h.file.endsWith('/clean.ts')).map((h) => `${h.line} ${h.rule}: ${h.text} (${h.why})`)).toEqual([]);
    });

    it('lists a finding unless an exception names its file and its line, and reports an exception that finds nothing', () => {
      const hits: Hit[] = [
        { rule: 'vehicles', file: 'a.ts', line: 3, text: 'return defs.vehicles[id];', why: '' },
        { rule: 'vehicles', file: 'b.ts', line: 9, text: 'return defs.vehicles[id];', why: '' },
      ];
      expect(settle(hits, [{ file: 'a.ts', line: 'return defs.vehicles[id];', reason: 'a reader' }])).toEqual({ unlisted: ['b.ts:9: return defs.vehicles[id];\n    ()'], stale: [] });
      expect(settle(hits.slice(0, 1), [{ file: 'a.ts', line: 'return defs.vehicles[id]!;', reason: 'the line as it was' }])).toEqual({ unlisted: ['a.ts:3: return defs.vehicles[id];\n    ()'], stale: ['a.ts: return defs.vehicles[id]!;'] });
    });

    it('finds code and the retired action written into a page', () => {
      const page = ['<body>', '<!-- <script>old()</script> -->', '<script type="module" src="./main.ts"></script>', '<script>go()</script>', '<button onclick="go()" data-action="pause">', '</body>'].join('\n');
      expect(scanHtml('page.html', page, RULES).map((h) => `${h.line} ${h.rule}`)).toEqual(['4 html', '5 pause', '5 html']);
    });
  });
});
