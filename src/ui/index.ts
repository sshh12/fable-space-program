/**
 * Public API of src/ui (flight-ui package): HUD, navball renderer, MFD painter, shared display models and
 * formatters. See docs/handoff/flight-ui.md.
 */
export { createHud, HUD_TEXT_HZ, type HudImpl, type HudKeyHelpEntry, type HudOptions } from './hud/hud';
export { INTERACTIVE_ATTR } from './hud/dom';
export { createNavballRenderer, markerInstances, NAVBALL_FORMAT, NAVBALL_TEXTURE_SIZE, type MarkerInstance, type NavballRendererImpl, type NavballRendererOptions } from './navball/navballRenderer';
export {
  BALL_RADIUS_FRACTION,
  ballDirectionHorizon,
  ballDirectionVes,
  ballTextureUv,
  limbFade,
  MARKER_HALF_SIZE,
  pitchHeadingOf,
  projectMarker,
  type ProjectedMarker,
} from './navball/navballMath';
export { buildMfdPage, createMfdPainter, MFD_PAGES, type MfdPageModel, type MfdRow } from './mfd/mfdPainter';
export * from './format';
export * from './model';
export { drawIcon, MARKER_COLORS, MARKER_ICONS, STAGE_ICONS, stageIconFor, svgIcon, type IconDef } from './icons';
