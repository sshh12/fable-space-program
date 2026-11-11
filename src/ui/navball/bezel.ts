/**
 * The HUD navball's bezel, drawn once per resize with Canvas 2D on a canvas laid over the WebGPU ball (it never
 * changes while flying, so it costs nothing per frame): a recessed dark gap around the ball, a machined ring
 * with a bevel lit from above (outer chamfer bright at the top, inner chamfer bright at the bottom), fixed roll
 * index ticks (10 / 20 / 30 / 45 / 60 deg each side of the top, then every 30 deg) and the orange top index.
 * Like the ball, the light comes from the upper left.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const RETICLE_ORANGE = '#ffa53a';

/** Draw the bezel into a square canvas of `sizePx`, around a ball of radius `ballFraction` x half the size. */
export function drawNavballBezel(ctx: Ctx, sizePx: number, ballFraction: number): void {
  const c = sizePx / 2;
  const R = ballFraction * c;
  const outer = c * 0.985;
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

  // Drop shadow of the instrument on the scene.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = ring * 0.6;
  ctx.shadowOffsetY = ring * 0.18;
  annulus(gapOut, outer);
  ctx.fillStyle = '#1b2129';
  ctx.fill();
  ctx.restore();

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
  ctx.lineWidth = Math.max(1, sizePx / 500);
  ctx.strokeStyle = vertical('rgba(220,232,245,0.55)', 'rgba(220,232,245,0.04)', outer);
  ctx.beginPath();
  ctx.arc(0, 0, outer - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();

  // Recessed gap between ball and ring: near black, with a soft falloff onto the ball.
  annulus(R - Math.max(1, sizePx / 600), gapOut);
  ctx.fillStyle = '#030406';
  ctx.fill();

  // Roll index ticks on the face (angles from the top, clockwise).
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
    ctx.lineWidth = Math.max(1.5, ring * (major ? 0.16 : 0.12)) + Math.max(1, sizePx / 400);
    ctx.beginPath();
    ctx.moveTo(sx * tickIn, sy * tickIn);
    ctx.lineTo(sx * ro, sy * ro);
    ctx.stroke();
    ctx.strokeStyle = major ? '#e9eff6' : '#bcc7d4';
    ctx.lineWidth = Math.max(1, ring * (major ? 0.16 : 0.12));
    ctx.stroke();
  }

  // Top index: an orange triangle pointing at the ball.
  const tipY = -(gapOut + ring * 0.12);
  const baseY = -(gapOut + ring * 0.82);
  const halfW = ring * 0.42;
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(-halfW, baseY);
  ctx.lineTo(halfW, baseY);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.5, sizePx / 300);
  ctx.strokeStyle = 'rgba(10,6,2,0.9)';
  ctx.stroke();
  ctx.fillStyle = RETICLE_ORANGE;
  ctx.fill();
  ctx.restore();
}
