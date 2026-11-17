/**
 * The lens shift in the effects (CameraState.lensShift, RENDER_API 19.5): a ray is never formed by hand from
 * the tangents of the field of view without the shift.
 *
 *  - Text: no shader under src/render/vfx multiplies a frame position by `<camera>Right.w` and `<camera>Up.w`
 *    unless a lens shift was subtracted from that position first. The effects have one such ray (the particle
 *    step's, through the camera of the frame BEFORE, for which the frame chunk's `ndcRay` has no values); every
 *    other ray comes from `viewRay` / `ndcRay`.
 *  - Numbers: that ray, built from what `prevCameraUniforms` packs, ends on the point the previous frame's
 *    matrix projected, with a shift and without.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CameraState } from '@/core/contracts/render';
import { mat4, quat, v3, type Vec3 } from '@/core/math';
import { buildProjection, lensShiftOf } from '@/render/core/frame/math';
import { FRAME_WGSL } from '@/render/core/shaders/chunksFrame';
import { prevCameraUniforms } from '@/render/vfx/particles';

const VFX_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/render/vfx');

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** The tangents of half the field of view as a shader names them: the `.w` of a camera's right and up axis. */
const TANGENT_X = /\b\w*[Rr]ight\.w\b/;
const TANGENT_Y = /\b\w*[Uu]p\.w\b/;

/** The statements of a source text that form a ray by hand: both tangents in one expression. */
const handMadeRays = (text: string): string[] =>
  withoutComments(text)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => TANGENT_X.test(s) && TANGENT_Y.test(s));

/**
 * True when the frame position such a statement scales by the tangents had a lens shift subtracted: the two
 * factors are the x and the y of one name, and that name is declared as something minus a `...Shift.xy`.
 */
const removesShift = (text: string, statement: string): boolean => {
  const x = /([A-Za-z_]\w*)\.x\s*\*\s*[\w.]*[Rr]ight\.w\b/.exec(statement);
  const y = /([A-Za-z_]\w*)\.y\s*\*\s*[\w.]*[Uu]p\.w\b/.exec(statement);
  if (!x || !y || x[1] !== y[1]) return false;
  return new RegExp(`\\blet\\s+${x[1]}\\s*=[^;]*-\\s*[\\w.]*[Ss]hift\\.xy\\s*;`).test(withoutComments(text));
};

const vfxSources = (): { file: string; text: string }[] =>
  readdirSync(VFX_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((file) => ({ file, text: readFileSync(path.join(VFX_DIR, file), 'utf8') }));

describe('rays formed by hand in the effect shaders', () => {
  it('the check passes the frame chunk and catches a ray from the bare frame position', () => {
    // The one place the core forms a ray: ndcRay.
    const chunk = handMadeRays(FRAME_WGSL);
    expect(chunk).toHaveLength(1);
    expect(removesShift(FRAME_WGSL, chunk[0]!)).toBe(true);
    // The particle step as it was: the ray of the previous camera through the projected point, no shift.
    const was = `
      let ndc = clip.xy / clip.w;
      let z = frame.cameraForward.w / d;
      let ray = pu.prevForward.xyz + pu.prevRight.xyz * (ndc.x * pu.prevRight.w) + pu.prevUp.xyz * (ndc.y * pu.prevUp.w);
      let surf = ray * z;`;
    const found = handMadeRays(was);
    expect(found).toHaveLength(1);
    expect(removesShift(was, found[0]!)).toBe(false);
    // Subtracting the shift from one component only does not pass either.
    const half = was.replace('(ndc.x *', '((ndc.x - frame.lensShift.x) *');
    expect(removesShift(half, handMadeRays(half)[0]!)).toBe(false);
    // The footprint of a pixel uses one tangent: not a ray.
    expect(handMadeRays('let pixel = 2.0 * frame.cameraUp.w * frame.renderSize.w * viewZ;')).toEqual([]);
  });

  it('every one of them subtracts a lens shift from the frame position first', () => {
    const sources = vfxSources();
    expect(sources.length).toBeGreaterThan(12);
    const rays = sources.flatMap((s) => handMadeRays(s.text).map((statement) => ({ ...s, statement })));
    for (const r of rays) expect(removesShift(r.text, r.statement), `${r.file}: ${r.statement}`).toBe(true);
    // The scan sees the effects' one ray of this kind, the particle step's through the previous camera.
    expect(rays.map((r) => r.file)).toEqual(['particles.ts']);
    expect(rays[0]!.statement).toContain('pu.prevRight.w');
  });

  it('the uniform block of the particle step is as long as its struct', () => {
    const text = withoutComments(readFileSync(path.join(VFX_DIR, 'particles.ts'), 'utf8'));
    const struct = /struct ParticleU \{([^}]*)\}/.exec(text);
    const floats = /const SIM_FLOATS = (\d+);/.exec(text);
    expect(struct).not.toBeNull();
    expect(floats).not.toBeNull();
    const fields = struct![1]!.split(',').map((f) => f.trim()).filter((f) => f.length > 0);
    expect(fields.every((f) => /^\w+: vec4[fu]$/.test(f))).toBe(true);
    expect(fields.at(-1)).toBe('prevShift: vec4f');
    expect(fields.length * 4).toBe(Number(floats![1]));
  });
});

describe('the ray of the previous camera, from what the particle step is given', () => {
  const W = 1600;
  const H = 900;
  const FOV = (50 * Math.PI) / 180;
  const q = quat.fromAxisAngle(v3.normalize({ x: 0.3, y: 1, z: -0.2 }), 0.9);
  const cameraOf = (lensShift?: [number, number]): CameraState => ({ positionRoot: v3.zero(), qViewToRoot: q, fovY: FOV, ...(lensShift ? { lensShift } : {}) }) as CameraState;

  /** A point 40 m ahead of the camera and off its axis, in ROOT axes relative to the eye. */
  const point = quat.rotate(q, { x: 9, y: -4, z: -40 });

  /** The shader's arithmetic: where the previous frame's depth puts the surface seen at `ndc`, `depth` metres along the axis. */
  const surfaceAt = (u: ReturnType<typeof prevCameraUniforms>, ndc: { x: number; y: number }, depth: number, shift: readonly [number, number]): Vec3 => {
    const ax = (ndc.x - shift[0]) * u.tanX;
    const ay = (ndc.y - shift[1]) * u.tanY;
    return { x: (u.forward[0] + u.right[0] * ax + u.up[0] * ay) * depth, y: (u.forward[1] + u.right[1] * ax + u.up[1] * ay) * depth, z: (u.forward[2] + u.right[2] * ax + u.up[2] * ay) * depth };
  };

  /** The point through the matrix the core keeps of a frame for the next one (`prevViewProj`): unjittered projection times view. */
  const project = (camera: CameraState): { x: number; y: number } => {
    const viewProj = mat4.mul(buildProjection(camera.fovY, W, H, [0, 0], lensShiftOf(camera)).projUnjittered, mat4.viewRotation(camera.qViewToRoot));
    const clip = mat4.transformPoint(viewProj, point);
    return { x: clip.x / clip.w, y: clip.y / clip.w };
  };

  it('ends on the projected point under a lens shift; without the shift it misses by the shift', () => {
    const camera = cameraOf([0.3, -0.2]);
    const u = prevCameraUniforms(camera, [W, H]);
    expect(u.shift).toEqual([0.3, -0.2]);
    const ndc = project(camera);
    const depth = v3.dot(point, { x: u.forward[0], y: u.forward[1], z: u.forward[2] });
    expect(depth).toBeCloseTo(40, 9);
    expect(v3.dist(surfaceAt(u, ndc, depth, u.shift), point)).toBeLessThan(1e-9);
    // The ray as it was formed before: 0.3 of the half width and 0.2 of the half height beside the point.
    const missed = v3.dist(surfaceAt(u, ndc, depth, [0, 0]), point);
    expect(missed).toBeCloseTo(40 * Math.hypot(0.3 * u.tanX, 0.2 * u.tanY), 6);
    expect(missed).toBeGreaterThan(9);
  });

  it('is the ray it always was for a camera without a shift: the same floats, and a shift of zero', () => {
    const camera = cameraOf();
    const u = prevCameraUniforms(camera, [W, H]);
    expect(u.shift).toEqual([0, 0]);
    // The values the step was given before the shift was packed: the camera's axes and the two tangents.
    const axis = (x: number, y: number, z: number): number[] => {
      const r = quat.rotate(q, { x, y, z });
      return [r.x, r.y, r.z];
    };
    for (const [got, want] of [
      [u.right, axis(1, 0, 0)],
      [u.up, axis(0, 1, 0)],
      [u.forward, axis(0, 0, -1)],
    ] as const) {
      for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i]!, 12);
    }
    expect(u.tanY).toBe(Math.tan(FOV / 2));
    expect(u.tanX).toBe(Math.tan(FOV / 2) * (W / H));
    // Subtracting it changes no bit of a frame position (x - 0 is x in every float), so the ray is the same.
    for (const x of [0.731, -0.98, 0, 1e-7]) expect(Math.fround(Math.fround(x) - Math.fround(u.shift[0]))).toBe(Math.fround(x));
    const ndc = project(camera);
    expect(v3.dist(surfaceAt(u, ndc, 40, u.shift), point)).toBeLessThan(1e-9);
  });
});
