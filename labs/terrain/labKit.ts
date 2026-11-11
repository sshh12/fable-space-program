/**
 * Lab-only stand-ins around the terrain feature (none of this ships in the app):
 *  - a Sim wrapper that pins the sun (so views do not depend on the FakeSim's date);
 *  - a constant-colour stand-in for the atmosphere's sky irradiance table, so that ground in shadow is lit
 *    by "sky" on bodies with an atmosphere (the real table comes from the atmosphere package);
 *  - a magenta background behind the body silhouette (crack and hole detection);
 *  - an 'ocean.nearField' publisher (what the ocean feature will publish);
 *  - a GPU ballast pass for performance measurements (an idle RTX 5090 clocks down, RENDER_API section 14).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { RENDER_FORMATS, type RenderContext, type RenderFeature } from '@/core/contracts/render';
import type { BodySnapshot, Sim, SimSnapshot } from '@/core/contracts/sim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, quat, v3, type Vec3 } from '@/core/math';
import { coreOf, f32ToF16, type CoreSharedResources, type ManagedTarget, type Tracked } from '@/render/core';
import { enuAt } from '@/render/core/lab';

export type SunSpec =
  | { kind: 'site'; bodyId: string; latDeg: number; lonDeg: number; azDeg: number; elDeg: number }
  | { kind: 'subsolar'; bodyId: string; latDeg: number; lonDeg: number }
  | null;

/** Unit direction (ROOT axes) from the spec's body to the star. */
export function sunDirection(spec: Exclude<SunSpec, null>, snapshot: SimSnapshot): Vec3 | null {
  const b = snapshot.bodies.find((x) => x.id === spec.bodyId);
  if (!b) return null;
  const dir = latLonToDir(spec.latDeg * DEG, spec.lonDeg * DEG);
  if (spec.kind === 'subsolar') return quat.rotate(b.qFixedToRoot, dir);
  const { east, north, up } = enuAt(b.qFixedToRoot, dir);
  const az = spec.azDeg * DEG;
  const el = spec.elDeg * DEG;
  return v3.normalize(v3.add(v3.scale(v3.add(v3.scale(north, Math.cos(az)), v3.scale(east, Math.sin(az))), Math.cos(el)), v3.scale(up, Math.sin(el))));
}

/** Wrap a Sim so that the star stands where `getSun()` says, as seen from that body (other bodies follow). */
export function withSun(inner: Sim, getSun: () => SunSpec): Sim {
  const fix = (s: SimSnapshot): SimSnapshot => {
    const spec = getSun();
    if (!spec) return s;
    const dir = sunDirection(spec, s);
    const star = s.bodies.find((b) => b.id === s.starId);
    const anchor = s.bodies.find((b) => b.id === spec.bodyId);
    if (!dir || !star || !anchor) return s;
    const starPos = v3.addScaled(anchor.rRoot, dir, v3.dist(star.rRoot, anchor.rRoot));
    const bodies: BodySnapshot[] = s.bodies.map((b) => {
      if (b.id === s.starId) return { ...b, rRoot: starPos };
      const to = v3.sub(starPos, b.rRoot);
      return { ...b, sunDir: v3.normalize(to), sunDistance: v3.len(to) };
    });
    return { ...s, bodies };
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'snapshot') return () => fix(target.snapshot());
      if (prop === 'peek') return () => fix(target.peek());
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Stand-in for 'atmosphere.skyIrradianceLut' (64 x 16, one layer per atmosphere body): a clear-sky
 * illuminance that follows the sun's elevation, the same at every altitude. `lux` = illuminance on a
 * horizontal surface with the sun at the zenith.
 */
export function createSkyStandIn(lux: number): RenderFeature {
  return {
    id: 'lab-sky',
    init(ctx: RenderContext) {
      if (lux <= 0) return;
      const layers = Math.max(1, Object.values(ctx.defs.bodies).filter((b) => b.render.atmosphere).length);
      const w = 64;
      const h = 16;
      const data = new Uint16Array(w * h * 4 * layers);
      for (let l = 0; l < layers; l++) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            // u = (mu_s + 0.2) / 1.2 (atmosphere_common chunk).
            const mu = ((x + 0.5) / w) * 1.2 - 0.2;
            // Daylight above the horizon, a twilight that is gone at 7 degrees below it, nothing at night.
            const day = Math.max(mu, 0) ** 0.6;
            const dusk = Math.min(1, Math.max(0, (mu + 0.12) / 0.12)) * 0.03;
            const e = lux * Math.max(day, dusk);
            const o = ((l * h + y) * w + x) * 4;
            data[o] = f32ToF16(e * 0.62);
            data[o + 1] = f32ToF16(e * 0.8);
            data[o + 2] = f32ToF16(e * 1.0);
            data[o + 3] = f32ToF16(1);
          }
        }
      }
      const tex = coreOf(ctx).createTextureChecked({ label: 'lab-sky.irradiance', format: 'rgba16float', size: [w, h, layers], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      ctx.device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: w * 8, rowsPerImage: h }, [w, h, layers]);
      ctx.resources.publish('atmosphere.skyIrradianceLut', tex.createView({ dimension: '2d-array' }));
    },
  };
}

/**
 * Magenta wherever a view ray hits the sphere of radius R + `offset` of a body but no geometry was drawn:
 * a hole or a crack in the terrain shows as magenta, the sky beyond the silhouette stays black.
 */
export function createMagentaBackground(offsets: Record<string, number>): RenderFeature {
  let ctx: RenderContext;
  let pipeline: Tracked<GPURenderPipeline>;
  let uniform: GPUBuffer;
  let group: GPUBindGroup;
  return {
    id: 'lab-magenta',
    init(c) {
      ctx = c;
      uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
      pipeline = coreOf(c).fullscreenPipeline({
        label: 'lab-magenta',
        layouts: [layout],
        fragment: /* wgsl */ `
          @group(1) @binding(0) var<uniform> offsets: vec4f;
          @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
            let d = normalize(viewRay(in.uv));
            var hit = false;
            for (var i = 0u; i < frame.counts.x; i++) {
              if ((bodyFlags(i) & BODY_FLAG_TERRAIN) == 0u) { continue; }
              let b = frame.bodies[i];
              let rs = b.center.w + offsets[i];
              // Cancellation-free ray / sphere test from the eye at radius r0 (RENDER_API section 4).
              let r0 = b.cameraUp.w;
              let mu = dot(d, b.cameraUp.xyz);
              let c = cross(d, b.cameraUp.xyz);
              if (r0 > rs && mu < 0.0 && rs * rs - r0 * r0 * dot(c, c) > 0.0) { hit = true; }
            }
            if (!hit) { discard; }
            return vec4f(writeHdr(vec3f(8.0, 0.0, 8.0)), 1.0);
          }`,
        targets: [{ format: RENDER_FORMATS.hdr }],
        depthStencil: { format: RENDER_FORMATS.depth, depthWriteEnabled: false, depthCompare: 'equal' },
      });
      pipeline.get();
    },
    prepare(frame) {
      const data = new Float32Array(4);
      frame.bodies.slice(0, 4).forEach((b, i) => (data[i] = offsets[b.id] ?? ctx.defs.bodies[b.id]?.terrain?.minElevation ?? 0));
      ctx.device.queue.writeBuffer(uniform, 0, data);
    },
    drawBackground(_frame, pass) {
      pass.setPipeline(pipeline.get());
      pass.setBindGroup(1, group);
      pass.draw(3);
    },
  };
}

/** Publishes 'ocean.nearField' the way the ocean feature will (null = back to the default: no near field). */
export function createNearFieldPublisher(defs: DefLibrary, resources: () => CoreSharedResources): { feature: RenderFeature; set(v: { bodyId: string; fadeStart: number; fadeEnd: number } | null): void } {
  let ctx: RenderContext;
  let buffer: GPUBuffer;
  let current: { bodyId: string; fadeStart: number; fadeEnd: number } | null = null;
  return {
    feature: {
      id: 'lab-nearfield',
      init(c) {
        ctx = c;
        buffer = c.device.createBuffer({ label: 'lab-nearfield', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      },
      prepare(frame) {
        if (!current) return;
        const data = new ArrayBuffer(16);
        new Int32Array(data, 0, 1)[0] = frame.bodies.findIndex((b) => b.id === current!.bodyId);
        new Float32Array(data, 4, 3).set([current.fadeStart, current.fadeEnd, 0]);
        ctx.device.queue.writeBuffer(buffer, 0, data);
      },
    },
    set(v) {
      if (v && !defs.bodies[v.bodyId]) throw new Error(`near field: unknown body "${v.bodyId}"`);
      current = v;
      if (v) ctx.resources.publish('ocean.nearField', buffer);
      else resources().reset('ocean.nearField');
    },
  };
}

/** A fullscreen pass of `iterations` loop steps per pixel, encoded late in the frame, to keep the GPU at its working clock. */
export function createBallast(initial: number): { feature: RenderFeature; set(iterations: number): void; get(): number } {
  let iterations = initial;
  let ctx: RenderContext;
  let target: ManagedTarget;
  let pipeline: Tracked<GPURenderPipeline>;
  let uniform: GPUBuffer;
  let group: GPUBindGroup;
  return {
    feature: {
      id: 'lab-ballast',
      init(c) {
        ctx = c;
        const core = coreOf(c);
        target = core.createTarget('lab-ballast.scratch', 'rgba16float', 1);
        uniform = c.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const layout = c.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
        group = c.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
        pipeline = core.fullscreenPipeline({
          label: 'lab-ballast.burn',
          layouts: [layout],
          fragment: /* wgsl */ `
            @group(1) @binding(0) var<uniform> ballast: vec4f;
            @fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
              let steps = i32(ballast.x);
              var a = vec3f(in.uv, 0.5);
              for (var i = 0; i < steps; i++) { a = fract(sin(a.yzx * 12.9898 + a.zxy * 78.233 + f32(i)) * 43758.5453); }
              return vec4f(a, 1.0);
            }`,
          targets: [{ format: 'rgba16float' }],
        });
        pipeline.get();
      },
      prepare() {
        ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([iterations, 0, 0, 0]));
      },
      // Encoded after the scene (preTransparent), so that the tail of this long pass is not charged to the
      // shadow and G-buffer passes that are being measured: it lands in the core's last copy instead.
      preTransparent(frame, encoder) {
        if (iterations <= 0) return;
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-ballast.burn') as GPURenderPassTimestampWrites | undefined });
        pass.setBindGroup(0, frame.frameBindGroup);
        pass.setPipeline(pipeline.get());
        pass.setBindGroup(1, group);
        pass.draw(3);
        pass.end();
        // The tail of a long pass is charged to whatever is encoded next; this empty pass takes it.
        encoder.beginRenderPass({ colorAttachments: [{ view: target.view, loadOp: 'load', storeOp: 'store' }], timestampWrites: ctx.perf.gpuPass('lab-ballast.tail') as GPURenderPassTimestampWrites | undefined }).end();
      },
    },
    set(n) {
      iterations = n;
    },
    get: () => iterations,
  };
}
