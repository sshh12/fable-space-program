/**
 * The HUD navball's bezel, drawn once per resize with Canvas 2D on a canvas laid over the WebGPU ball (it never
 * changes while flying, so it costs nothing per frame): a recessed dark gap around the ball's window, a machined
 * ring with a bevel lit from above (outer chamfer bright at the top, inner chamfer bright at the bottom), the
 * fixed roll scale (10 / 20 / 30 / 45 / 60 deg each side of the top, then every 30 deg) that the ball's sky
 * pointer reads against, and the orange top index. Like the ball, the light comes from the upper left.
 *
 * The canvas is larger than the instrument: its soft drop shadow on the scene is round and fades to nothing well
 * inside the canvas edge (a shadow cut by its canvas would print a straight line beside the bezel).
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const RETICLE_ORANGE = '#ffa53a';

/**
 * Draw the bezel into a square canvas of `sizePx`, around a window of radius `windowFraction` x half the size;
 * the ring's outer edge is at `outerFraction` x half the size (the rest of the canvas is the shadow's margin).
 */
export function drawNavballBezel(ctx: Ctx, sizePx: number, windowFraction: number, outerFraction = windowFraction * (0.985 / 0.84)): void {
  const c = sizePx / 2;
  const R = windowFraction * c;
  const outer = c * outerFraction;
  const gapOut = R * 1.028;
  const ring = outer - gapOut;
  ctx.clearRect(0, 0, sizePx, sizePx);
  ctx.save();
  ctx.translate(c, c);

  const annulus = (r0: number, r1: number): void => {
    ctx.beginPath();
    ctx.arc(0, 0, r1, 0, Math.PI * 2);
    ctx.arc(0, 0, r0, 0, Math.PI * 2, true);
    ctx.closePath();
  };
  const vertical = (top: string, bottom: string, r: number, mid?: string): CanvasGradient => {
    const g = ctx.createLinearGradient(-r * 0.35, -r, r * 0.35, r);
    g.addColorStop(0, top);
    if (mid) g.addColorStop(0.5, mid);
    g.addColorStop(1, bottom);
    return g;
  };

  // Drop shadow of the instrument on the scene: a radial falloff, offset down, that reaches zero before the
  // canvas edge whatever the margin.
  const margin = c - outer;
  const spread = Math.min(margin * 0.92, ring * 1.1);
  const dy = Math.min(ring * 0.2, margin * 0.08);
  if (spread > 1) {
    const sh = ctx.createRadialGradient(0, dy, outer * 0.9, 0, dy, outer + spread);
    sh.addColorStop(0, 'rgba(0,0,0,0.5)');
    sh.addColorStop((outer * 0.1) / (outer * 0.1 + spread), 'rgba(0,0,0,0.42)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.arc(0, dy, outer + spread, 0, Math.PI * 2);
    ctx.arc(0, 0, gapOut, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
  }

  // Ring face: dark gunmetal, lighter toward the top.
  annulus(gapOut, outer);
  ctx.fillStyle = vertical('#39424e', '#151a20', outer, '#232a33');
  ctx.fill();
  // Outer chamfer (faces outward and up: lit at the top) and inner chamfer (faces inward: lit at the bottom).
  annulus(outer - ring * 0.2, outer);
  ctx.fillStyle = vertical('#77828f', '#0c0f13', outer, '#2b323b');
  ctx.fill();
  annulus(gapOut, gapOut + ring * 0.22);
  ctx.fillStyle = vertical('#0a0d10', '#5a6573', gapOut, '#20262e');
  ctx.fill();
  // Hairline highlights on the edges.
  ctx.lineWidth = Math.max(1, sizePx / 600);
  ctx.strokeStyle = vertical('rgba(220,232,245,0.55)', 'rgba(220,232,245,0.04)', outer);
  ctx.beginPath();
  ctx.arc(0, 0, outer - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();

  // Recessed gap between the window and the ring: near black (the ball's own contact shadow continues it).
  annulus(R - Math.max(1, sizePx / 700), gapOut);
  ctx.fillStyle = '#030406';
  ctx.fill();

  // Roll scale on the face (angles from the top, clockwise).
  const tickIn = gapOut + ring * 0.3;
  const minorOut = gapOut + ring * 0.56;
  const majorOut = gapOut + ring * 0.74;
  const ticks: [number, boolean][] = [];
  for (const a of [10, 20, 30, 45, 60]) ticks.push([a, a === 30 || a === 60], [-a, a === 30 || a === 60]);
  for (let a = 90; a <= 270; a += 30) ticks.push([a, true]);
  ctx.lineCap = 'round';
  for (const [deg, major] of ticks) {
    const t = (deg * Math.PI) / 180;
    const sx = Math.sin(t);
    const sy = -Math.cos(t);
    const ro = major ? majorOut : minorOut;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = Math.max(1.5, ring * (major ? 0.16 : 0.12)) + Math.max(1, sizePx / 480);
    ctx.beginPath();
    ctx.moveTo(sx * tickIn, sy * tickIn);
    ctx.lineTo(sx * ro, sy * ro);
    ctx.stroke();
    ctx.strokeStyle = major ? '#e9eff6' : '#bcc7d4';
    ctx.lineWidth = Math.max(1, ring * (major ? 0.16 : 0.12));
    ctx.stroke();
  }

  // Top index: an orange triangle pointing at the ball (roll 0 of the scale).
  const tipY = -(gapOut + ring * 0.12);
  const baseY = -(gapOut + ring * 0.82);
  const halfW = ring * 0.42;
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(-halfW, baseY);
  ctx.lineTo(halfW, baseY);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.5, sizePx / 360);
  ctx.strokeStyle = 'rgba(10,6,2,0.9)';
  ctx.stroke();
  ctx.fillStyle = RETICLE_ORANGE;
  ctx.fill();
  ctx.restore();
}
