/**
 * FlightController: the ActiveController for flying a vessel. Maps one InputFrame to ControlInputs (attitude
 * and translation axes, the integrated throttle lever) and PlayerCommands (one call per ButtonAction).
 *
 * - Throttle lever: integrated from the throttleRate axis at THROTTLE_RATE (0.5 per second); Z = full, X = cut.
 *   While `ctx.pointerCaptured` is true (the map view owns the pointer: hovering a node handle, dragging,
 *   typing in the node panel) the throttleRate axis is ignored, so the node editor's Shift/Ctrl drag
 *   modifiers can never move the throttle.
 * - Fine control only toggles the sim flag; the input scaling is the simulation's job.
 * - View, HUD, pause and cockpit-display actions are not the controller's: the app routes them to the view
 *   manager, HUD and cockpit.
 * - Refused commands (warp limits, staging lockout, no node for maneuver hold...) are reported through
 *   `notify`, which the app connects to Hud.notify.
 */
import type { ActiveController, ButtonAction, CommandResult, ControlContext, ControlInputs, InputFrame, PlayerCommands, SasMode } from '@/core/contracts/controls';
import type { SimSnapshot } from '@/core/contracts/sim';

/** Throttle lever travel per second of real time with the throttle key held. */
export const THROTTLE_RATE = 0.5;

export interface FlightControllerOptions {
  /** Sink for refusal messages (Hud.notify). */
  notify?: (message: string) => void;
  /** Lever rate per second (default THROTTLE_RATE). */
  throttleRate?: number;
}

export interface FlightController extends ActiveController {
  readonly kind: 'flight';
  /** Current lever position, 0..1. */
  readonly throttle: number;
  /** Set the lever (the test API and the app's own throttle UI write here, like a held key would). */
  setThrottle(value: number): void;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

const CONTROLLER_ACTIONS: ReadonlySet<string> = new Set<ButtonAction>([
  'stage',
  'abort',
  'throttleFull',
  'throttleCut',
  'toggleSas',
  'toggleRcs',
  'toggleLegs',
  'toggleLights',
  'toggleFineControl',
  'toggleNavballMode',
  'warpUp',
  'warpDown',
  'warpStop',
  'nextVessel',
  'prevVessel',
]);

/** True for actions the flight controller turns into PlayerCommands / lever changes. */
export const isControllerAction = (a: ButtonAction): boolean => CONTROLLER_ACTIONS.has(a) || a.startsWith('sas:');

export function createFlightController(opts: FlightControllerOptions = {}): FlightController {
  const rate = opts.throttleRate ?? THROTTLE_RATE;
  let throttle = 0;
  let synced = false;

  const report = (what: string, r: CommandResult): void => {
    if (!r.ok) opts.notify?.(r.reason ?? `${what} refused`);
  };

  const run = (action: ButtonAction, snap: SimSnapshot, cmd: PlayerCommands): void => {
    const ro = snap.readouts;
    switch (action) {
      case 'stage':
        return report('Staging', cmd.stage());
      case 'abort':
        return report('Abort', cmd.abort());
      case 'throttleFull':
        throttle = 1;
        return;
      case 'throttleCut':
        throttle = 0;
        return;
      case 'toggleSas':
        return report('SAS', cmd.setSasEnabled(!ro.sasEnabled));
      case 'toggleRcs':
        return report('RCS', cmd.setRcsEnabled(!ro.rcsEnabled));
      case 'toggleLegs':
        return report('Landing gear', cmd.toggleLegs());
      case 'toggleLights':
        return report('Lights', cmd.toggleLights());
      case 'toggleFineControl':
        return report('Fine control', cmd.setFineControl(!ro.fineControl));
      case 'toggleNavballMode':
        return report('Navball mode', cmd.setNavballMode(snap.navball.mode === 'surface' ? 'orbit' : 'surface'));
      case 'warpUp':
        return report('Time warp', cmd.setWarpLevel(snap.warp.index + 1));
      case 'warpDown':
        if (snap.warp.index > 0) report('Time warp', cmd.setWarpLevel(snap.warp.index - 1));
        return;
      case 'warpStop':
        if (snap.warp.index > 0) report('Time warp', cmd.setWarpLevel(0));
        return;
      case 'nextVessel':
        return report('Vessel switch', cmd.cycleActiveVessel(1));
      case 'prevVessel':
        return report('Vessel switch', cmd.cycleActiveVessel(-1));
      default:
        if (action.startsWith('sas:')) {
          const mode = action.slice(4) as SasMode;
          if (!ro.sasModesAvailable.includes(mode)) {
            opts.notify?.(`${mode === 'maneuver' ? 'Maneuver hold needs a maneuver node' : `SAS mode ${mode} is not available`}`);
            return;
          }
          if (!ro.sasEnabled) {
            const on = cmd.setSasEnabled(true);
            if (!on.ok) return report('SAS', on);
          }
          return report('SAS mode', cmd.setSasMode(mode));
        }
    }
  };

  return {
    kind: 'flight',
    get throttle() {
      return throttle;
    },
    setThrottle(value) {
      throttle = clamp(value, 0, 1);
      synced = true;
    },
    update(input: InputFrame, snapshot: SimSnapshot, commands: PlayerCommands, realDt: number, ctx: ControlContext): ControlInputs {
      if (!synced) {
        throttle = clamp(snapshot.appliedControls.throttle, 0, 1);
        synced = true;
      }
      for (const action of input.pressed) if (isControllerAction(action)) run(action, snapshot, commands);
      if (!ctx.pointerCaptured) {
        const dt = clamp(realDt, 0, 0.25);
        throttle = clamp(throttle + input.axes.throttleRate * rate * dt, 0, 1);
      }
      const a = input.axes;
      return {
        pitch: clamp(a.pitch, -1, 1),
        yaw: clamp(a.yaw, -1, 1),
        roll: clamp(a.roll, -1, 1),
        translate: { x: clamp(a.translateX, -1, 1), y: clamp(a.translateY, -1, 1), z: clamp(a.translateZ, -1, 1) },
        throttle,
      };
    },
  };
}
