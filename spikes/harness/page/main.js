// WebGPU harness spike page.
// HDR rgba16float scene target + reversed-Z depth32float + ACES tonemap to the canvas.
// Exposes window.__harness as the test API driven by Playwright.

const params = new URLSearchParams(location.search);
const H = (window.__harness = {
  errors: [],
  input: { keysDown: [], keyLog: [], mouse: { x: 0, y: 0, buttons: 0, wheel: 0, moves: 0, clicks: 0, dx: 0, dy: 0 }, pointerLocked: false },
});
window.addEventListener('error', (e) => H.errors.push('error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => H.errors.push('rejection: ' + (e.reason?.stack || e.reason)));

// ---------- tiny mat4 helpers (column-major) ----------
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
function lookAt(eye, target, up) {
  const f = norm(sub(target, eye)); const r = norm(cross(f, up)); const u = cross(r, f);
  const m = new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, eye), -dot(u, eye), dot(f, eye), 1]);
  return { m, r, u, f };
}
// Reversed-Z, infinite far plane: clip.z = near, clip.w = -z_view  => depth = near / distance (1 at near, 0 at infinity)
function perspectiveReversedZInfinite(fovy, aspect, near) {
  const f = 1 / Math.tan(fovy / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, 0, -1, 0, 0, near, 0]);
}

const SCENE_WGSL = /* wgsl */ `
struct U {
  viewProj: mat4x4f,
  camPos: vec4f,
  sunDir: vec4f,
  camRight: vec4f,
  camUp: vec4f,
  camFwd: vec4f,
  params: vec4f, // time, gridN, tanHalfFov, aspect
};
@group(0) @binding(0) var<uniform> u: U;

fn hash(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}

fn skyColor(d: vec3f) -> vec3f {
  let sun = normalize(u.sunDir.xyz);
  let h = clamp(d.y, -1.0, 1.0);
  let horizon = vec3f(0.55, 0.70, 0.95);
  let zenith = vec3f(0.08, 0.22, 0.60);
  var c = mix(horizon, zenith, pow(max(h, 0.0), 0.45)) * 1.5;
  if (h < 0.0) { c = mix(horizon * 1.5, vec3f(0.05, 0.05, 0.06), clamp(-h * 8.0, 0.0, 1.0)); }
  let cs = dot(d, sun);
  c += vec3f(1.0, 0.75, 0.45) * pow(max(cs, 0.0), 64.0) * 2.0;        // aureole
  c += vec3f(1.0, 0.95, 0.85) * smoothstep(0.99985, 0.99995, cs) * 4000.0; // HDR sun disk
  return c;
}

struct SkyOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn skyVS(@builtin(vertex_index) vi: u32) -> SkyOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var o: SkyOut;
  o.pos = vec4f(p, 0.0, 1.0); // z = 0 is the far plane in reversed-Z
  o.ndc = p;
  return o;
}
@fragment fn skyFS(i: SkyOut) -> @location(0) vec4f {
  let t = u.params.z;
  let d = normalize(u.camFwd.xyz + u.camRight.xyz * i.ndc.x * t * u.params.w + u.camUp.xyz * i.ndc.y * t);
  return vec4f(skyColor(d), 1.0);
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) nrm: vec3f,
  @location(2) color: vec3f,
  @location(3) emissive: f32,
};
@vertex fn cubeVS(@location(0) pos: vec3f, @location(1) nrm: vec3f, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let n = u32(u.params.y);
  let time = u.params.x;
  var world: vec3f;
  var N = nrm;
  o.emissive = 0.0;
  if (ii == 0u) {
    world = pos * vec3f(6000.0, 0.5, 6000.0) - vec3f(0.0, 0.5, 0.0);
    o.color = vec3f(0.16, 0.18, 0.15);
  } else {
    let i = ii - 1u;
    let gx = f32(i % n) - f32(n) * 0.5;
    let gz = f32(i / n) - f32(n) * 0.5;
    let h = 0.6 + hash(i) * 5.0 * (0.55 + 0.45 * sin(time * 0.7 + hash(i + 7u) * 6.2831));
    let ang = hash(i * 3u + 1u) * 6.2831 + time * (hash(i * 5u + 2u) - 0.5);
    let c = cos(ang); let s = sin(ang);
    let p = vec3f(pos.x * c - pos.z * s, pos.y * h + h, pos.x * s + pos.z * c);
    N = vec3f(nrm.x * c - nrm.z * s, nrm.y, nrm.x * s + nrm.z * c);
    world = vec3f(gx * 3.4, 0.0, gz * 3.4) + p;
    let k = hash(i * 11u + 3u);
    o.color = mix(vec3f(0.75, 0.72, 0.68), vec3f(0.25, 0.32, 0.45), k);
    if (hash(i * 13u + 5u) > 0.965) { o.emissive = 40.0; o.color = mix(vec3f(1.0, 0.35, 0.08), vec3f(0.1, 0.6, 1.0), hash(i * 17u)); }
  }
  o.world = world;
  o.nrm = N;
  o.pos = u.viewProj * vec4f(world, 1.0);
  return o;
}
@fragment fn cubeFS(i: VOut) -> @location(0) vec4f {
  let N = normalize(i.nrm);
  let L = normalize(u.sunDir.xyz);
  let V = normalize(u.camPos.xyz - i.world);
  let Hh = normalize(L + V);
  let ndl = max(dot(N, L), 0.0);
  let sunRadiance = vec3f(1.0, 0.96, 0.9) * 12.0;
  let ambient = skyColor(normalize(N + vec3f(0.0, 0.4, 0.0))) * 0.25;
  let spec = pow(max(dot(N, Hh), 0.0), 80.0) * 0.6;
  var c = i.color * (sunRadiance * ndl * 0.318 + min(ambient, vec3f(2.0))) + sunRadiance * spec * ndl;
  c += i.color * i.emissive;
  // aerial perspective so distant geometry reads against the sky
  let dist = distance(u.camPos.xyz, i.world);
  let fog = 1.0 - exp(-dist * 0.0009);
  c = mix(c, vec3f(0.55, 0.70, 0.95) * 1.5, fog);
  return vec4f(c, 1.0);
}
`;

const TONEMAP_WGSL = /* wgsl */ `
@group(0) @binding(0) var hdr: texture_2d<f32>;
struct T { exposure: f32, gammaEncode: f32, pad0: f32, pad1: f32 };
@group(0) @binding(1) var<uniform> t: T;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}
fn aces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}
fn srgbOETF(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let c = textureLoad(hdr, vec2i(p.xy), 0).rgb * t.exposure;
  var o = aces(c);
  if (t.gammaEncode > 0.5) { o = srgbOETF(o); }
  return vec4f(o, 1.0);
}
`;

function cubeGeometry() {
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const v = [];
  for (const [n, a, b] of faces) {
    const quad = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const [s, t] of quad) {
      v.push(n[0] + a[0] * s + b[0] * t, n[1] + a[1] * s + b[1] * t, n[2] + a[2] * s + b[2] * t, n[0], n[1], n[2]);
    }
  }
  return new Float32Array(v);
}

function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

async function init() {
  if (!navigator.gpu) throw new Error('navigator.gpu missing');
  const power = params.get('power') ?? 'high-performance';
  const adapterOpts = power === 'none' ? {} : { powerPreference: power };
  if (params.get('fallback') === '1') adapterOpts.forceFallbackAdapter = true;
  const adapter = await navigator.gpu.requestAdapter(adapterOpts);
  if (!adapter) throw new Error('requestAdapter returned null');
  const info = adapter.info;
  H.adapter = {
    vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
    isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
    subgroupMinSize: info.subgroupMinSize ?? null, subgroupMaxSize: info.subgroupMaxSize ?? null,
    powerPreferenceRequested: power,
  };
  H.features = [...adapter.features].sort();
  H.limits = {};
  for (const k in adapter.limits) H.limits[k] = adapter.limits[k];
  H.wgslLanguageFeatures = [...(navigator.gpu.wgslLanguageFeatures ?? [])].sort();
  H.preferredCanvasFormat = navigator.gpu.getPreferredCanvasFormat();

  // Request everything the adapter offers plus its max limits: this is what the real engine will do.
  const requiredLimits = {};
  for (const k of ['maxTextureDimension2D', 'maxTextureArrayLayers', 'maxBufferSize', 'maxStorageBufferBindingSize',
    'maxStorageBuffersPerShaderStage', 'maxSampledTexturesPerShaderStage', 'maxColorAttachmentBytesPerSample',
    'maxUniformBufferBindingSize', 'maxBindGroups', 'maxComputeInvocationsPerWorkgroup']) {
    if (k in adapter.limits) requiredLimits[k] = adapter.limits[k];
  }
  const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features], requiredLimits });
  H.deviceFeatures = [...device.features].sort();
  H.deviceLost = null;
  device.lost.then((l) => { H.deviceLost = `${l.reason}: ${l.message}`; });
  device.addEventListener('uncapturederror', (e) => H.errors.push('gpu: ' + e.error.message));
  const hasTS = device.features.has('timestamp-query');

  const canvas = document.getElementById('c');
  const context = canvas.getContext('webgpu');
  const canvasFormat = H.preferredCanvasFormat;
  let W = 0, Hh = 0, hdrTex, depthTex, tonemapBG;
  const dprOverride = params.get('dpr');

  const N = Math.max(1, parseInt(params.get('grid') ?? '48', 10)); // N*N cubes
  H.scene = { grid: N, instances: N * N + 1, triangles: (N * N + 1) * 12 };

  const cube = cubeGeometry();
  const vbuf = device.createBuffer({ size: cube.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vbuf, 0, cube);
  const ubuf = device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const tbuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  device.pushErrorScope('validation');
  const sceneMod = device.createShaderModule({ code: SCENE_WGSL });
  const tmMod = device.createShaderModule({ code: TONEMAP_WGSL });
  for (const [name, m] of [['scene', sceneMod], ['tonemap', tmMod]]) {
    const ci = await m.getCompilationInfo();
    for (const msg of ci.messages) if (msg.type === 'error') H.errors.push(`wgsl ${name}:${msg.lineNum}: ${msg.message}`);
  }
  const depthStencilBase = { format: 'depth32float' };
  const skyPipe = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module: sceneMod, entryPoint: 'skyVS' },
    fragment: { module: sceneMod, entryPoint: 'skyFS', targets: [{ format: 'rgba16float' }] },
    depthStencil: { ...depthStencilBase, depthWriteEnabled: false, depthCompare: 'always' },
  });
  const cubePipe = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: {
      module: sceneMod, entryPoint: 'cubeVS',
      buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }],
    },
    fragment: { module: sceneMod, entryPoint: 'cubeFS', targets: [{ format: 'rgba16float' }] },
    primitive: { cullMode: 'back', frontFace: 'ccw' },
    depthStencil: { ...depthStencilBase, depthWriteEnabled: true, depthCompare: 'greater' }, // reversed-Z
  });
  const tmPipe = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module: tmMod, entryPoint: 'vs' },
    fragment: { module: tmMod, entryPoint: 'fs', targets: [{ format: canvasFormat }] },
  });
  const verr = await device.popErrorScope();
  if (verr) H.errors.push('validation: ' + verr.message);

  const skyBG = device.createBindGroup({ layout: skyPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
  const cubeBG = device.createBindGroup({ layout: cubePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });

  function resize() {
    const dpr = dprOverride ? parseFloat(dprOverride) : window.devicePixelRatio;
    const w = Math.max(1, Math.min(Math.floor(canvas.clientWidth * dpr), device.limits.maxTextureDimension2D));
    const h = Math.max(1, Math.min(Math.floor(canvas.clientHeight * dpr), device.limits.maxTextureDimension2D));
    if (w === W && h === Hh) return;
    W = w; Hh = h; canvas.width = w; canvas.height = h;
    context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
    hdrTex?.destroy(); depthTex?.destroy();
    hdrTex = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    depthTex = device.createTexture({ size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    tonemapBG = device.createBindGroup({ layout: tmPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: hdrTex.createView() }, { binding: 1, resource: { buffer: tbuf } }] });
    H.size = { width: w, height: h, dpr: window.devicePixelRatio, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight };
  }

  // ---------- GPU timestamp queries ----------
  let querySet, resolveBuf; const readPool = [];
  if (hasTS) {
    querySet = device.createQuerySet({ type: 'timestamp', count: 4 });
    resolveBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  }
  const stats = { raf: [], cpu: [], gpuScene: [], gpuTonemap: [], gpuRawNs: [], frames: 0 };
  const MAXS = 20000;
  const push = (a, v) => { if (a.length < MAXS) a.push(v); };

  // ---------- camera / input ----------
  const cam = { yaw: 0.6, pitch: 0.28, dist: 95, target: [0, 4, 0], exposure: 0.6, frozenTime: null, autoOrbit: true };
  H.cam = cam;
  const keys = new Set();
  window.addEventListener('keydown', (e) => { keys.add(e.code); H.input.keyLog.push('d:' + e.code); H.input.keysDown = [...keys]; if (e.code !== 'F12') e.preventDefault(); });
  window.addEventListener('keyup', (e) => { keys.delete(e.code); H.input.keyLog.push('u:' + e.code); H.input.keysDown = [...keys]; });
  canvas.addEventListener('pointermove', (e) => {
    const m = H.input.mouse; m.x = e.clientX; m.y = e.clientY; m.buttons = e.buttons; m.moves++;
    m.dx += e.movementX; m.dy += e.movementY;
    if (e.buttons & 1) { cam.yaw += e.movementX * 0.005; cam.pitch = Math.min(1.5, Math.max(-0.05, cam.pitch + e.movementY * 0.005)); cam.autoOrbit = false; }
  });
  canvas.addEventListener('pointerdown', (e) => { H.input.mouse.buttons = e.buttons; H.input.mouse.clicks++; canvas.focus(); });
  canvas.addEventListener('pointerup', (e) => { H.input.mouse.buttons = e.buttons; });
  canvas.addEventListener('wheel', (e) => { H.input.mouse.wheel += e.deltaY; cam.dist = Math.min(2000, Math.max(5, cam.dist * Math.exp(e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });
  document.addEventListener('pointerlockchange', () => { H.input.pointerLocked = document.pointerLockElement === canvas; });
  H.requestPointerLock = async () => { try { await canvas.requestPointerLock({ unadjustedMovement: true }); return 'ok'; } catch (e) { return 'err: ' + e.message; } };

  function applyKeys(dt) {
    const sp = 1.2 * dt;
    if (keys.has('KeyA')) { cam.yaw -= sp; cam.autoOrbit = false; }
    if (keys.has('KeyD')) { cam.yaw += sp; cam.autoOrbit = false; }
    if (keys.has('KeyW')) { cam.dist = Math.max(5, cam.dist * (1 - sp)); cam.autoOrbit = false; }
    if (keys.has('KeyS')) { cam.dist = cam.dist * (1 + sp); cam.autoOrbit = false; }
  }

  const udata = new Float32Array(44);
  function encodeFrame(timeSec, withTimestamps, target) {
    resize();
    const eye = [cam.target[0] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw), cam.target[1] + cam.dist * Math.sin(cam.pitch), cam.target[2] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw)];
    const fovy = 55 * Math.PI / 180, aspect = W / Hh;
    const v = lookAt(eye, cam.target, [0, 1, 0]);
    udata.set(mul(perspectiveReversedZInfinite(fovy, aspect, 0.1), v.m), 0);
    udata.set([...eye, 1], 16);
    udata.set([...norm([0.45, 0.42, 0.6]), 0], 20);
    udata.set([...v.r, 0], 24); udata.set([...v.u, 0], 28); udata.set([...v.f, 0], 32);
    udata.set([timeSec, N, Math.tan(fovy / 2), aspect], 36);
    device.queue.writeBuffer(ubuf, 0, udata);
    device.queue.writeBuffer(tbuf, 0, new Float32Array([cam.exposure, canvasFormat.endsWith('-srgb') ? 0 : 1, 0, 0]));

    const enc = device.createCommandEncoder();
    const ts = withTimestamps && hasTS;
    const p1 = enc.beginRenderPass({
      colorAttachments: [{ view: hdrTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: depthTex.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0.0 }, // reversed-Z clears to 0
      ...(ts ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    });
    p1.setPipeline(skyPipe); p1.setBindGroup(0, skyBG); p1.draw(3);
    p1.setPipeline(cubePipe); p1.setBindGroup(0, cubeBG); p1.setVertexBuffer(0, vbuf); p1.draw(36, N * N + 1);
    p1.end();
    const p2 = enc.beginRenderPass({
      colorAttachments: [{ view: (target ?? context.getCurrentTexture()).createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      ...(ts ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } } : {}),
    });
    p2.setPipeline(tmPipe); p2.setBindGroup(0, tonemapBG); p2.draw(3);
    p2.end();
    let rb = null;
    if (ts) {
      rb = readPool.pop() ?? device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      enc.resolveQuerySet(querySet, 0, 4, resolveBuf, 0);
      enc.copyBufferToBuffer(resolveBuf, 0, rb, 0, 32);
    }
    device.queue.submit([enc.finish()]);
    if (rb) {
      rb.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(rb.getMappedRange().slice(0));
        rb.unmap(); readPool.push(rb);
        push(stats.gpuScene, Number(t[1] - t[0]) / 1e6);
        push(stats.gpuTonemap, Number(t[3] - t[2]) / 1e6);
        if (stats.gpuRawNs.length < 64) stats.gpuRawNs.push(Number(t[1] - t[0]));
      }).catch(() => {});
    }
  }

  let last = 0, running = true, simTime = 0;
  function frame(now) {
    if (!running) return;
    const dt = last ? (now - last) : 0;
    if (last) push(stats.raf, dt);
    last = now;
    applyKeys(dt / 1000);
    if (cam.autoOrbit && cam.frozenTime == null) cam.yaw += dt / 1000 * 0.05;
    simTime += dt / 1000;
    const c0 = performance.now();
    encodeFrame(cam.frozenTime ?? simTime, true);
    push(stats.cpu, performance.now() - c0);
    stats.frames++;
    requestAnimationFrame(frame);
  }

  // ---------- test API ----------
  const summarize = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const mean = s.reduce((x, y) => x + y, 0) / s.length;
    return { n: s.length, mean: +mean.toFixed(4), min: +s[0].toFixed(4), p50: +q(0.5).toFixed(4), p95: +q(0.95).toFixed(4), p99: +q(0.99).toFixed(4), max: +s[s.length - 1].toFixed(4) };
  };
  H.resetStats = () => { stats.raf.length = stats.cpu.length = stats.gpuScene.length = stats.gpuTonemap.length = stats.gpuRawNs.length = 0; stats.frames = 0; };
  H.getStats = () => ({
    frames: stats.frames, raf: summarize(stats.raf), cpuEncode: summarize(stats.cpu),
    gpuScene: summarize(stats.gpuScene), gpuTonemap: summarize(stats.gpuTonemap),
    fps: stats.raf.length ? +(1000 / (stats.raf.reduce((x, y) => x + y, 0) / stats.raf.length)).toFixed(2) : null,
    gpuRawNs: stats.gpuRawNs.slice(0, 24), hasTimestampQuery: hasTS, visibility: document.visibilityState,
  });
  H.setTime = (t) => { cam.frozenTime = t; cam.autoOrbit = false; };
  H.setCamera = (o) => { Object.assign(cam, o); cam.autoOrbit = false; };
  H.pause = () => { running = false; };
  H.resume = () => { if (!running) { running = true; last = 0; requestAnimationFrame(frame); } };

  // Wait until N more frames have actually been presented through rAF.
  H.waitFrames = (n) => new Promise((res) => { const target = stats.frames + n; const tick = () => (stats.frames >= target ? res(stats.frames) : requestAnimationFrame(tick)); tick(); });

  // Uncapped throughput benchmark: renders `n` frames back to back, not paced by rAF/vsync.
  // mode 'batch': submit all, await GPU idle once (pure GPU throughput incl. CPU encode).
  // mode 'serial': await onSubmittedWorkDone after each frame (per-frame latency distribution).
  H.benchmark = async (n = 200, mode = 'batch') => {
    const wasRunning = running; running = false;
    await device.queue.onSubmittedWorkDone();
    H.resetStats();
    const per = [];
    const off = device.createTexture({ size: [W, Hh], format: canvasFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const f0 = performance.now();
      encodeFrame(cam.frozenTime ?? (simTime + i / 60), true, off);
      if (mode === 'serial') { await device.queue.onSubmittedWorkDone(); per.push(performance.now() - f0); }
    }
    const tEnc = performance.now() - t0;
    await device.queue.onSubmittedWorkDone();
    const total = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 100)); // let timestamp readbacks land
    off.destroy();
    const out = { mode, frames: n, totalMs: +total.toFixed(2), msPerFrame: +(total / n).toFixed(4), fps: +(1000 * n / total).toFixed(1), cpuEncodeMsPerFrame: +(tEnc / n).toFixed(4), perFrame: summarize(per), gpuScene: summarize(stats.gpuScene), gpuTonemap: summarize(stats.gpuTonemap), gpuRawNs: stats.gpuRawNs.slice(0, 16) };
    if (wasRunning) H.resume();
    return out;
  };

  // Read back the HDR target (rgba16float) and the reversed-Z depth buffer; return statistics.
  H.readHDR = async () => {
    const bpr = Math.ceil(W * 8 / 256) * 256;
    const buf = device.createBuffer({ size: bpr * Hh, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const dbpr = Math.ceil(W * 4 / 256) * 256;
    const dbuf = device.createBuffer({ size: dbpr * Hh, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: hdrTex }, { buffer: buf, bytesPerRow: bpr }, [W, Hh]);
    enc.copyTextureToBuffer({ texture: depthTex, aspect: 'depth-only' }, { buffer: dbuf, bytesPerRow: dbpr }, [W, Hh]);
    device.queue.submit([enc.finish()]);
    await Promise.all([buf.mapAsync(GPUMapMode.READ), dbuf.mapAsync(GPUMapMode.READ)]);
    const u16 = new Uint16Array(buf.getMappedRange());
    const f32 = new Float32Array(dbuf.getMappedRange());
    let maxL = 0, sum = 0, over1 = 0, nan = 0, cnt = 0, dMin = 1e9, dMax = -1e9, dZero = 0;
    for (let y = 0; y < Hh; y += 2) for (let x = 0; x < W; x += 2) {
      const o = (y * bpr) / 2 + x * 4;
      const r = halfToFloat(u16[o]), g = halfToFloat(u16[o + 1]), b = halfToFloat(u16[o + 2]);
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (!Number.isFinite(L)) { nan++; continue; }
      if (L > maxL) maxL = L; if (L > 1) over1++; sum += L; cnt++;
      const d = f32[(y * dbpr) / 4 + x];
      if (d === 0) dZero++; else { if (d < dMin) dMin = d; }
      if (d > dMax) dMax = d;
    }
    const cx = W >> 1, cy = Hh >> 1, co = (cy * bpr) / 2 + cx * 4;
    const center = [halfToFloat(u16[co]), halfToFloat(u16[co + 1]), halfToFloat(u16[co + 2])];
    const centerDepth = f32[(cy * dbpr) / 4 + cx];
    buf.unmap(); dbuf.unmap(); buf.destroy(); dbuf.destroy();
    return { width: W, height: Hh, samples: cnt, maxLuminance: maxL, meanLuminance: sum / cnt, fractionOver1: over1 / cnt, nanPixels: nan,
      center, depth: { fractionSky_depth0: dZero / cnt, minNonZero: dMin, max: dMax, center: centerDepth, centerDistanceM: centerDepth > 0 ? 0.1 / centerDepth : Infinity } };
  };

  // In-page canvas capture. Must render and read in the same task (the canvas texture expires after the task).
  H.captureDataURL = () => { encodeFrame(cam.frozenTime ?? simTime, false); return canvas.toDataURL('image/png'); };

  // Probe optional capabilities that need a real device call to verify.
  H.probeExtras = async () => {
    const out = {};
    const tryCfg = async (label, fn) => {
      device.pushErrorScope('out-of-memory');
      device.pushErrorScope('validation');
      let thrown = null;
      try { await fn(); } catch (e) { thrown = e.message; }
      const err = await device.popErrorScope();
      const oom = await device.popErrorScope();
      out[label] = thrown ? 'throws: ' + thrown.slice(0, 160) : err ? 'validation: ' + err.message.slice(0, 160) : oom ? 'out-of-memory' : 'ok';
    };
    await tryCfg('canvas_rgba16float_extended_tonemapping', async () => {
      const c2 = new OffscreenCanvas(64, 64); const ctx2 = c2.getContext('webgpu');
      ctx2.configure({ device, format: 'rgba16float', colorSpace: 'display-p3', toneMapping: { mode: 'extended' } });
      out.canvas_hdr_config = JSON.stringify(ctx2.getConfiguration?.() ?? null, (k, v) => (k === 'device' ? undefined : v));
    });
    await tryCfg('rgba16float_msaa4_render_target', async () => { device.createTexture({ size: [64, 64], format: 'rgba16float', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT }).destroy(); });
    await tryCfg('depth32float_msaa4', async () => { device.createTexture({ size: [64, 64], format: 'depth32float', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT }).destroy(); });
    await tryCfg('depth32float_stencil8_texture', async () => { device.createTexture({ size: [64, 64], format: 'depth32float-stencil8', usage: GPUTextureUsage.RENDER_ATTACHMENT }).destroy(); });
    await tryCfg('bc7_texture', async () => { device.createTexture({ size: [64, 64], format: 'bc7-rgba-unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }).destroy(); });
    await tryCfg('bc6h_texture', async () => { device.createTexture({ size: [64, 64], format: 'bc6h-rgb-ufloat', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }).destroy(); });
    await tryCfg('r32float_filterable_sampling', async () => {
      const m = device.createShaderModule({ code: `@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var s: sampler;
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0.0); }
        @fragment fn fs() -> @location(0) vec4f { return textureSampleLevel(t, s, vec2f(0.5), 0.0); }` });
      const p = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: m }, fragment: { module: m, targets: [{ format: 'rgba8unorm' }] } });
      const t = device.createTexture({ size: [4, 4], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING });
      device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView() }, { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) }] });
    });
    const TB = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    await tryCfg('texture_array_2048x2048x256_rgba8_4GiB', async () => { device.createTexture({ size: [2048, 2048, 256], format: 'rgba8unorm', usage: TB }).destroy(); });
    await tryCfg('texture_array_2048x2048x120_rgba8_1.9GiB', async () => { device.createTexture({ size: [2048, 2048, 120], format: 'rgba8unorm', usage: TB }).destroy(); });
    await tryCfg('texture_array_1024x1024x2048_bc7_2GiB', async () => { device.createTexture({ size: [1024, 1024, 2048], format: 'bc7-rgba-unorm', usage: TB }).destroy(); });
    await tryCfg('texture_array_512x512x2048_rgba8_2GiB', async () => { device.createTexture({ size: [512, 512, 2048], format: 'rgba8unorm', usage: TB }).destroy(); });
    await tryCfg('texture_16384x16384_r8_256MiB', async () => { device.createTexture({ size: [16384, 16384], format: 'r8unorm', usage: TB }).destroy(); });
    await tryCfg('texture_16384x16384_rgba8_1GiB', async () => { device.createTexture({ size: [16384, 16384], format: 'rgba8unorm', usage: TB }).destroy(); });
    await tryCfg('texture_16384x16384_rgba16float_2GiB', async () => { device.createTexture({ size: [16384, 16384], format: 'rgba16float', usage: TB }).destroy(); });
    await tryCfg('buffer_1GiB', async () => { device.createBuffer({ size: 1024 * 1024 * 1024, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }).destroy(); });
    await tryCfg('buffer_2GiB_maxBufferSize', async () => { device.createBuffer({ size: device.limits.maxBufferSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }).destroy(); });
    // cumulative VRAM: keep allocating 1 GiB rgba8 textures (and touching them) until OOM or 24 GiB
    {
      const held = []; let gib = 0;
      for (; gib < 24; gib++) {
        device.pushErrorScope('out-of-memory');
        const t = device.createTexture({ size: [16384, 16384], format: 'rgba8unorm', usage: TB | GPUTextureUsage.RENDER_ATTACHMENT });
        const e = device.createCommandEncoder();
        e.beginRenderPass({ colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store' }] }).end();
        device.queue.submit([e.finish()]);
        const oom = await device.popErrorScope();
        if (oom) { t.destroy(); break; }
        held.push(t);
      }
      await device.queue.onSubmittedWorkDone();
      out.cumulative_1GiB_textures_allocated_before_OOM = gib + (gib === 24 ? ' (stopped at cap, no OOM)' : '');
      for (const t of held) t.destroy();
    }
    await tryCfg('compute_pipeline', async () => {
      const m = device.createShaderModule({ code: `@group(0) @binding(0) var<storage, read_write> d: array<f32>; @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) { d[id.x] = f32(id.x) * 2.0; }` });
      const p = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: m } });
      const b = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const r = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const e = device.createCommandEncoder(); const cp = e.beginComputePass();
      cp.setPipeline(p); cp.setBindGroup(0, device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: b } }] })); cp.dispatchWorkgroups(1); cp.end();
      e.copyBufferToBuffer(b, 0, r, 0, 256); device.queue.submit([e.finish()]);
      await r.mapAsync(GPUMapMode.READ); const f = new Float32Array(r.getMappedRange()); out.compute_result_63 = f[63]; r.unmap();
    });
    out.crossOriginIsolated = self.crossOriginIsolated;
    out.sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
    out.hardwareConcurrency = navigator.hardwareConcurrency;
    out.deviceMemory = navigator.deviceMemory ?? null;
    out.userAgent = navigator.userAgent;
    return out;
  };

  resize();
  new ResizeObserver(() => resize()).observe(canvas);
  requestAnimationFrame(frame);
  return true;
}

// ---------- audio ----------
let actx = null, analyser = null, nodes = [];
H.audioStart = async (opts = {}) => {
  actx = new AudioContext({ latencyHint: 'interactive' });
  const stateAtCreate = actx.state;
  if (opts.resume) await actx.resume();
  else await new Promise((r) => setTimeout(r, 300)); // give autoplay policy time to settle without a gesture
  const master = actx.createGain(); master.gain.value = 1;
  analyser = actx.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0;
  master.connect(analyser); analyser.connect(actx.destination);
  const osc = actx.createOscillator(); osc.type = 'sine'; osc.frequency.value = opts.freq ?? 220;
  const g = actx.createGain(); g.gain.value = opts.gain ?? 0.25;
  osc.connect(g).connect(master); osc.start();
  nodes = [osc, g, master];
  H._audioGain = g; H._audioOsc = osc;
  return { stateAtCreate, state: actx.state, sampleRate: actx.sampleRate, baseLatency: actx.baseLatency, outputLatency: actx.outputLatency, maxChannelCount: actx.destination.maxChannelCount, sinkId: actx.sinkId ?? null };
};
H.audioSet = (gain, freq) => { if (gain != null) H._audioGain.gain.setValueAtTime(gain, actx.currentTime); if (freq != null) H._audioOsc.frequency.setValueAtTime(freq, actx.currentTime); };
H.audioLevel = () => {
  const td = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(td);
  let ss = 0, peak = 0; for (const v of td) { ss += v * v; peak = Math.max(peak, Math.abs(v)); }
  const fd = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(fd);
  let bi = 0; for (let i = 1; i < fd.length; i++) if (fd[i] > fd[bi]) bi = i;
  return { state: actx.state, currentTime: actx.currentTime, rms: Math.sqrt(ss / td.length), peak, dominantHz: bi * actx.sampleRate / analyser.fftSize, dominantDb: fd[bi] };
};
H.audioStop = async () => { for (const n of nodes) { try { n.stop?.(); n.disconnect(); } catch {} } await actx?.close(); actx = null; };
// Deterministic offline render: verifies DSP graphs without any audio device and faster than realtime.
H.audioOffline = async () => {
  const sr = 48000, secs = 2;
  const oc = new OfflineAudioContext(2, sr * secs, sr);
  const osc = oc.createOscillator(); osc.frequency.value = 440;
  const g = oc.createGain(); g.gain.value = 0.5;
  const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000;
  osc.connect(g).connect(lp).connect(oc.destination); osc.start();
  // second half: "vacuum muffling" style lowpass at 100 Hz should strongly attenuate the 440 Hz tone
  lp.frequency.setValueAtTime(100, 1.0);
  const t0 = performance.now();
  const buf = await oc.startRendering();
  const ms = performance.now() - t0;
  const ch = buf.getChannelData(0);
  const rms = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += ch[i] * ch[i]; return Math.sqrt(s / (b - a)); };
  return { renderMs: ms, seconds: secs, rmsOpen: rms(sr * 0.2, sr * 0.9), rmsMuffled: rms(sr * 1.5, sr * 2), expectedOpen: 0.5 / Math.SQRT2 };
};

H.ready = init().then(() => true, (e) => { H.errors.push(String(e?.stack || e)); return false; });

// Autoplay-policy probe that runs with NO automation-injected user activation (page.evaluate grants one).
if (params.get('audioAtLoad') === '1') {
  const c = new AudioContext();
  const o = c.createOscillator(); o.connect(c.destination); o.start();
  H.audioAtLoad = { stateAtCreate: c.state, userActivationAtLoad: navigator.userActivation?.hasBeenActive ?? null };
  setTimeout(() => { H.audioAtLoad.stateAfter500ms = c.state; H.audioAtLoad.currentTime = c.currentTime; o.stop(); c.close(); }, 500);
}
