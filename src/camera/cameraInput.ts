/**
 * InputFrame -> CameraInput for the active rig: mouse drags (any button, started on the scene and not over an
 * interactive HUD element), the camera keys (arrows, Page Up / Page Down, Num + / Num -) and wheel steps.
 * While the map view owns the pointer (`pointerConsumed`) no pointer input reaches the rig, and a drag that
 * began over the HUD or on a map handle never turns into a camera drag.
 */
import type { InputFrame } from '@/core/contracts/controls';
import type { CameraInput } from '@/core/contracts/render';

export interface CameraInputMapperOptions {
  /** Radians per CSS pixel of drag (0.005). */
  dragRadiansPerPixel?: number;
  /** Radians per second with a camera key held (1.4). */
  keyRadiansPerSecond?: number;
  /** Zoom factor per wheel step (1.18: +1 step = away from the user = zoom in). */
  wheelStep?: number;
  /** Zoom factor per second with a zoom key held (3). */
  keyZoomPerSecond?: number;
}

export interface CameraInputContext {
  /** MapUpdateResult.consumed of this frame. */
  pointerConsumed: boolean;
  /** MapUpdateResult.focus of this frame. */
  focus?: { bodyId?: string; vesselId?: string };
}

export interface CameraInputMapper {
  map(frame: InputFrame, realDt: number, ctx: CameraInputContext): CameraInput;
  /** True while a camera drag is in progress. */
  readonly dragging: boolean;
}

export function createCameraInputMapper(opts: CameraInputMapperOptions = {}): CameraInputMapper {
  const perPx = opts.dragRadiansPerPixel ?? 0.005;
  const keyRate = opts.keyRadiansPerSecond ?? 1.4;
  const wheelStep = opts.wheelStep ?? 1.18;
  const keyZoom = opts.keyZoomPerSecond ?? 3;
  let dragging = false;
  let blocked = false;

  return {
    get dragging() {
      return dragging;
    },
    map(frame, realDt, ctx) {
      const p = frame.pointer;
      const dt = Math.max(0, Math.min(realDt, 0.25));
      const anyButton = (p.buttons & 7) !== 0;
      if (!anyButton) {
        dragging = false;
        blocked = false;
      } else if (!dragging && !blocked) {
        // A drag belongs to the camera only if it starts on the scene.
        if (p.overUi || ctx.pointerConsumed) blocked = true;
        else dragging = true;
      }
      if (ctx.pointerConsumed) dragging = false;

      let yaw = frame.axes.cameraYaw * keyRate * dt;
      let pitch = frame.axes.cameraPitch * keyRate * dt;
      let zoom = Math.pow(keyZoom, frame.axes.cameraZoom * dt);
      if (dragging) {
        yaw += p.dx * perPx;
        pitch -= p.dy * perPx;
      }
      if (!ctx.pointerConsumed && !p.overUi && p.wheel !== 0) zoom *= Math.pow(wheelStep, -p.wheel);
      const out: CameraInput = { yaw, pitch, zoom };
      if (ctx.focus?.bodyId) out.focusBodyId = ctx.focus.bodyId;
      if (ctx.focus?.vesselId) out.focusVesselId = ctx.focus.vesselId;
      return out;
    },
  };
}
