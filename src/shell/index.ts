/**
 * Public API of src/shell (shell-menu, wave 4.1): the app shell's state machine, the menu over the live scene,
 * the deploy flow with the visible launch queue, and the models behind its screens. docs/handoff/shell-menu.md.
 */
export { createShell, type Shell } from './shell';
export type { BootProgress, BootStep, IdentityHost, SettingsHost, ShellDeps, ShellIntent, ShellKey, ShellKeys, ShellSession } from './types';
export { createShellMachine, DEPLOY_STEPS, HUB_TABS, INITIAL_SHELL_STATE, MAIN_STATES, SIDE_STATES, stateName, transition, type DeployStep, type HubTab, type MainState, type ShellEvent, type ShellMachine, type ShellState, type SideState } from './machine';
export { createSpawnFlow, formatEstimate, ordinal, type SpawnFlow, type SpawnPhase } from './spawnFlow';
export { classOutlook, classOutlooks, launchesPerHour, padHosts, padRows, PAD_CLASSES, usableClasses, type ClassOutlook, type PadRow, type VehicleFit } from './pads';
export { formatSpan, isNever, rulesView, type RuleLine, type RuleSection, type RulesView } from './rulesView';
export { leaveOutcome, shouldGuardUnload, type LeaveOutcome } from './leaveOutcome';
export { formatSolarClock, solarViewAt, type SolarView } from './solar';
export { creditEntries } from './screens';
export { loadShellFonts, scrimRectsOf, SCRIM_SLOTS, SHELL_FONTS, type ScrimRect } from './dom/kit';
export type { NumberFormat } from './format';
