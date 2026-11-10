/**
 * Simple lab camera: placeable on a body surface (lat / lon / alt / heading / pitch), relative to a vessel,
 * or orbiting a vessel / body / body-fixed point. Float64 throughout. Not the game's camera rigs (src/camera).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState, ViewKind } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, quat, v3, type Quat, type Vec3, type Vec3Tuple } from '@/core/math';

export type LabCameraSpec =
  | {
      type: 'surface';
      bodyId: string;
      latDeg: number;
      lonDeg: number;
      /** Height above the reference radius, m. */
      alt: number;
      /** Compass heading (deg, clockwise from north) and pitch above the horizon (deg). */
      headingDeg: number;
      pitchDeg: number;
    }
  | {
      type: 'vessel';
      /** Vessel id or 'active'. */
      vesselId: string;
      /** Eye offset and look-at point in the VES frame, m. */
      offset: Vec3Tuple;
      lookAt?: Vec3Tuple;
    }
  | {
      type: 'orbit';
      /** What to orbit: a vessel ('active' allowed), a body centre, or a point fixed on a body. */
      target: { vesselId: string } | { bodyId: string } | { bodyId: string; latDeg: number; lonDeg: number; alt: number };
      /** Radians; yaw about the local vertical (or ROOT +Z for body centres), pitch above the local horizontal. */
      yaw: number;
      pitch: number;
      distance: number;
    }
  | {
      /** Programmatic placement: eye position (ROOT frame, float64) and view -> ROOT orientation. */
      type: 'free';
      positionRoot: Vec3;
      qViewToRoot: Quat;
    };

export interface LabCameraSettings {
  fovY: number;
  kind: ViewKind;
  exposureCompensation: number;
  minEv100: number | null;
  fillLight: number;
}

/** View orientation from a forward direction and an approximate up, both in ROOT axes. */
export function lookRotation(forward: Vec3, upHint: Vec3): Quat {
  const f = v3.normalize(forward);
  let r = v3.cross(f, upHint);
  if (v3.lenSq(r) < 1e-12) r = v3.cross(f, v3.anyOrthogonal(f));
  r = v3.normalize(r);
  const u = v3.cross(r, f);
  return quat.fromBasis(r, u, v3.neg(f));
}

/** East / north / up unit vectors (ROOT axes) at a body-fixed direction. */
export function enuAt(qFixedToRoot: Quat, dirFixed: Vec3): { east: Vec3; north: Vec3; up: Vec3 } {
  let east = v3.cross({ x: 0, y: 0, z: 1 }, dirFixed);
  if (v3.lenSq(east) < 1e-12) east = { x: 0, y: 1, z: 0 };
  east = v3.normalize(east);
  const north = v3.cross(dirFixed, east);
  return { east: quat.rotate(qFixedToRoot, east), north: quat.rotate(qFixedToRoot, north), up: quat.rotate(qFixedToRoot, dirFixed) };
}

export class LabCamera {
  spec: LabCameraSpec;
  settings: LabCameraSettings;

  constructor(
    spec: LabCameraSpec,
    settings: Partial<LabCameraSettings> = {},
    private readonly defs: DefLibrary,
  ) {
    this.spec = spec;
    this.settings = { fovY: 60 * DEG, kind: 'external', exposureCompensation: 0, minEv100: null, fillLight: 0, ...settings };
  }

  /** window.__test.setCameraOrbit: orbit the current target (the active vessel unless the camera already orbits something). */
  setOrbit(yaw: number, pitch: number, distance: number): void {
    const target = this.spec.type === 'orbit' ? this.spec.target : { vesselId: 'active' };
    this.spec = { type: 'orbit', target, yaw, pitch, distance };
  }

  /** Mouse drag (radians) and zoom factor (> 1 moves away). */
  nudge(dYaw: number, dPitch: number, zoom: number): void {
    const s = this.spec;
    if (s.type === 'orbit') {
      s.yaw += dYaw;
      s.pitch = Math.max(-1.55, Math.min(1.55, s.pitch + dPitch));
      s.distance *= zoom;
    } else if (s.type === 'surface') {
      s.headingDeg += dYaw / DEG;
      s.pitchDeg = Math.max(-89, Math.min(89, s.pitchDeg - dPitch / DEG));
      s.alt = Math.max(0.2, s.alt * zoom);
    }
  }

  state(snapshot: SimSnapshot): CameraState {
    const s = this.spec;
    const body = (id: string): SimSnapshot['bodies'][number] => {
      const b = snapshot.bodies.find((x) => x.id === id);
      if (!b) throw new Error(`lab camera: unknown body "${id}"`);
      return b;
    };
    const vessel = (id: string): SimSnapshot['vessels'][number] => {
      const v = snapshot.vessels.find((x) => x.id === (id === 'active' ? snapshot.activeVesselId : id));
      if (!v) throw new Error(`lab camera: unknown vessel "${id}"`);
      return v;
    };
    let positionRoot: Vec3;
    let qViewToRoot: Quat;
    let focusVesselId: string | null = null;
    let focusBodyId: string | null = null;

    if (s.type === 'free') {
      positionRoot = s.positionRoot;
      qViewToRoot = s.qViewToRoot;
    } else if (s.type === 'surface') {
      const b = body(s.bodyId);
      const radius = this.defs.bodies[s.bodyId]!.radius;
      const dir = latLonToDir(s.latDeg * DEG, s.lonDeg * DEG);
      const { east, north, up } = enuAt(b.qFixedToRoot, dir);
      positionRoot = v3.addScaled(b.rRoot, up, radius + s.alt);
      const h = s.headingDeg * DEG;
      const p = s.pitchDeg * DEG;
      const horizontal = v3.add(v3.scale(east, Math.sin(h)), v3.scale(north, Math.cos(h)));
      const forward = v3.add(v3.scale(horizontal, Math.cos(p)), v3.scale(up, Math.sin(p)));
      qViewToRoot = lookRotation(forward, Math.abs(s.pitchDeg) > 89.5 ? horizontal : up);
      focusBodyId = s.bodyId;
    } else if (s.type === 'vessel') {
      const v = vessel(s.vesselId);
      positionRoot = v3.add(v.rRoot, quat.rotate(v.q, v3.fromTuple(s.offset)));
      const target = v3.add(v.rRoot, quat.rotate(v.q, v3.fromTuple(s.lookAt ?? [0, 0, 0])));
      qViewToRoot = lookRotation(v3.sub(target, positionRoot), quat.rotate(v.q, { x: 0, y: 0, z: 1 }));
      focusVesselId = v.id;
    } else {
      let target: Vec3;
      let up: Vec3;
      let ref: Vec3;
      if ('vesselId' in s.target) {
        const v = vessel(s.target.vesselId);
        const b = body(v.bodyId);
        target = v.rRoot;
        up = v3.normalize(v3.sub(v.rRoot, b.rRoot));
        ref = quat.rotate(b.qFixedToRoot, { x: 0, y: 0, z: 1 });
        focusVesselId = v.id;
      } else if ('latDeg' in s.target) {
        const b = body(s.target.bodyId);
        const dir = latLonToDir(s.target.latDeg * DEG, s.target.lonDeg * DEG);
        up = quat.rotate(b.qFixedToRoot, dir);
        target = v3.addScaled(b.rRoot, up, this.defs.bodies[s.target.bodyId]!.radius + s.target.alt);
        ref = quat.rotate(b.qFixedToRoot, { x: 0, y: 0, z: 1 });
        focusBodyId = s.target.bodyId;
      } else {
        const b = body(s.target.bodyId);
        target = b.rRoot;
        up = { x: 0, y: 0, z: 1 };
        ref = { x: 1, y: 0, z: 0 };
        focusBodyId = s.target.bodyId;
      }
      // Horizontal axes: "north" = the reference axis projected to the horizontal plane, east = north x up.
      let north = v3.reject(ref, up);
      if (v3.lenSq(north) < 1e-12) north = v3.anyOrthogonal(up);
      north = v3.normalize(north);
      const east = v3.cross(north, up);
      const dirOut = v3.add(v3.scale(v3.add(v3.scale(north, Math.cos(s.yaw)), v3.scale(east, Math.sin(s.yaw))), Math.cos(s.pitch)), v3.scale(up, Math.sin(s.pitch)));
      positionRoot = v3.addScaled(target, dirOut, s.distance);
      qViewToRoot = lookRotation(v3.neg(dirOut), up);
    }
    const insideVesselId = this.settings.kind === 'interior' ? (focusVesselId ?? snapshot.activeVesselId) : null;
    return {
      mode: this.settings.kind === 'interior' ? 'cockpit' : this.settings.kind === 'map' ? 'map' : 'chase',
      kind: this.settings.kind,
      positionRoot,
      qViewToRoot,
      fovY: this.settings.fovY,
      insideVesselId,
      focusVesselId,
      focusBodyId,
      exposureCompensation: this.settings.exposureCompensation,
      minEv100: this.settings.minEv100,
      fillLight: this.settings.fillLight,
    };
  }
}

const num = (p: URLSearchParams, key: string, fallback: number): number => {
  const v = p.get(key);
  if (v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const tuple = (v: string | null, fallback: Vec3Tuple): Vec3Tuple => {
  if (!v) return fallback;
  const a = v.split(',').map(Number);
  return a.length === 3 && a.every(Number.isFinite) ? (a as Vec3Tuple) : fallback;
};

/**
 * Camera from the query string:
 *   body=<id>&lat=&lon=&alt=&heading=&pitch=          on a body surface (degrees, metres)
 *   vessel=<id|active>&offset=x,y,z[&look=x,y,z]      relative to a vessel, VES frame
 *   orbit=yawDeg,pitchDeg,distance[&target=vessel:<id>|body:<id>|site:<body>,<lat>,<lon>,<alt>]
 * plus fov=<deg>, kind=interior|external|map, ec=<EV>, minev=<EV100>, fill=<fraction>.
 * Without any of them: orbit the active vessel at 3 bounding radii.
 */
export function labCameraFromQuery(params: URLSearchParams, snapshot: SimSnapshot, defs: DefLibrary): LabCamera {
  const settings: Partial<LabCameraSettings> = {
    fovY: num(params, 'fov', 60) * DEG,
    kind: (params.get('kind') as ViewKind | null) ?? 'external',
    exposureCompensation: num(params, 'ec', 0),
    minEv100: params.has('minev') ? num(params, 'minev', 0) : null,
    fillLight: num(params, 'fill', 0),
  };
  let spec: LabCameraSpec;
  if (params.has('body')) {
    spec = { type: 'surface', bodyId: params.get('body')!, latDeg: num(params, 'lat', 0), lonDeg: num(params, 'lon', 0), alt: num(params, 'alt', 2), headingDeg: num(params, 'heading', 0), pitchDeg: num(params, 'pitch', 0) };
  } else if (params.has('vessel')) {
    spec = { type: 'vessel', vesselId: params.get('vessel')!, offset: tuple(params.get('offset'), [0, -30, 10]), lookAt: tuple(params.get('look'), [0, 0, 0]) };
  } else {
    const active = snapshot.vessels.find((v) => v.id === snapshot.activeVesselId);
    const o = tuple(params.get('orbit'), [30, 15, 3 * (active?.boundingRadius ?? 20)]);
    let target: Extract<LabCameraSpec, { type: 'orbit' }>['target'] = { vesselId: 'active' };
    const t = params.get('target');
    if (t?.startsWith('vessel:')) target = { vesselId: t.slice(7) };
    else if (t?.startsWith('body:')) target = { bodyId: t.slice(5) };
    else if (t?.startsWith('site:')) {
      const [bodyId, lat, lon, alt] = t.slice(5).split(',');
      target = { bodyId: bodyId!, latDeg: Number(lat), lonDeg: Number(lon), alt: Number(alt ?? 0) };
    }
    spec = { type: 'orbit', target, yaw: o[0] * DEG, pitch: o[1] * DEG, distance: o[2] };
  }
  return new LabCamera(spec, settings, defs);
}
