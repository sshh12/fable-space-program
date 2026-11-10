/**
 * Public API of src/input (flight-ui package): binding table, input system, flight controller, unload guard.
 * See docs/handoff/flight-ui.md.
 */
export {
  ALL_AXIS_ACTIONS,
  ALL_BUTTON_ACTIONS,
  BINDING_GROUP_ORDER,
  BROWSER_RESERVED_CODES,
  BROWSER_RESERVED_MODIFIERS,
  DEFAULT_BINDINGS,
  actionIdOf,
  chordOf,
  describeBinding,
  keyHelpEntries,
  keyLabel,
  validateBindings,
  type AxisBinding,
  type Binding,
  type BindingGroup,
  type ButtonBinding,
  type KeyHelpEntry,
  type ModifierKey,
  type UiAction,
} from './bindings';
export { createInputCore, type FlightInputFrame, type InputCore, type ModifierState } from './inputCore';
export { createInputSystem, type InputSystem, type InputSystemOptions } from './inputSystem';
export { createFlightController, isControllerAction, THROTTLE_RATE, type FlightController, type FlightControllerOptions } from './flightController';
export { installUnloadGuard } from './unloadGuard';
