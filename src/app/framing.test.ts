import { describe, expect, it } from 'vitest';
import { discInFrame, projectToFrame } from './framing';

const DEG = Math.PI / 180;
/** The game's chase view: 55 degrees vertical, 16:9. */
const tanY = Math.tan(27.5 * DEG);
const tanX = tanY * (16 / 9);

describe('projectToFrame', () => {
  it('puts the view axis at the centre and the half-angles at the edges', () => {
    expect(projectToFrame({ x: 0, y: 0, z: -10 }, tanX, tanY)).toEqual({ x: 0, y: 0 });
    const edge = projectToFrame({ x: 10 * tanX, y: -10 * tanY, z: -10 }, tanX, tanY)!;
    expect(edge.x).toBeCloseTo(1, 12);
    expect(edge.y).toBeCloseTo(-1, 12);
  });

  it('has no place for a point behind the image plane', () => {
    expect(projectToFrame({ x: 1, y: 1, z: 5 }, tanX, tanY)).toBeNull();
    expect(projectToFrame({ x: 1, y: 1, z: 0 }, tanX, tanY)).toBeNull();
  });
});

describe('discInFrame', () => {
  const lowOrbit = Math.asin(6371 / 6571);
  const onThePad = Math.asin(6378137 / (6378137 + 80));

  it('sees the planet under a low orbit, whose centre is far off the view axis', () => {
    // The eye on the limb: the centre 76 degrees below the axis (the case the rectangle test missed).
    expect(discInFrame({ x: 0, y: -Math.sin(76 * DEG), z: -Math.cos(76 * DEG) }, lowOrbit, tanX, tanY).inFrame).toBe(true);
    // The eye level with the ground on the pad: the centre in the image plane, the ground in the lower half.
    expect(discInFrame({ x: 0, y: -1, z: 0 }, onThePad, tanX, tanY).inFrame).toBe(true);
  });

  it('does not see a planet the eye looks away from', () => {
    expect(discInFrame({ x: 0, y: 0, z: 1 }, lowOrbit, tanX, tanY).inFrame).toBe(false);
    // On the pad looking 30 degrees up: the horizon is below the frame.
    expect(discInFrame({ x: 0, y: -Math.cos(30 * DEG), z: Math.sin(30 * DEG) }, onThePad, tanX, tanY).inFrame).toBe(false);
  });

  it('places a small disc and tells inside from outside at the frame edge', () => {
    const moon = 0.26 * DEG;
    const inside = discInFrame({ x: -0.6 * tanX, y: -0.5 * tanY, z: -1 }, moon, tanX, tanY);
    expect(inside.inFrame).toBe(true);
    expect(inside.x).toBeCloseTo(-0.6, 12);
    expect(inside.y).toBeCloseTo(-0.5, 12);
    expect(discInFrame({ x: 1.2 * tanX, y: 0, z: -1 }, moon, tanX, tanY).inFrame).toBe(false);
    // Centre just off the right edge, the limb inside.
    expect(discInFrame({ x: 1.004 * tanX, y: 0, z: -1 }, moon, tanX, tanY).inFrame).toBe(true);
    expect(discInFrame({ x: 0.1, y: 0.1, z: 1 }, 0.95 * DEG, tanX, tanY).inFrame).toBe(false);
  });

  it('gives the disc as a share of the vertical half-angle', () => {
    expect(discInFrame({ x: 0, y: 0, z: -1 }, 27.5 * DEG, tanX, tanY).heightShare).toBeCloseTo(1, 12);
  });
});
