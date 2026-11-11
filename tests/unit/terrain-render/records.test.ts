/**
 * Tile records: which image a tile and its parent sample, in the order a frame builds them.
 */
import { describe, expect, it } from 'vitest';
import type { TileLayerManifest } from '@/core/contracts/terrain';
import { morphWindow } from '@/render/terrain/lod';
import { BodyQuadtree, type SelectParams, type TileNode } from '@/render/terrain/quadtree';
import { buildRecordConstants, RECORD_FLAG_PARENT_IMAGE, RECORD_FLAGS_AT, type RecordContext } from '@/render/terrain/records';
import { RECORD_FLOATS } from '@/render/terrain/shaders/common';
import { makeReady, observer, R } from './cdlodTwin';

function layer(globalMaxLevel: number): TileLayerManifest {
  return { encoding: 'webp', ext: 'webp', globalMaxLevel, coverage: {}, sources: [] };
}

/** A tree with levels 0..level resident, every tile holding its own layers. */
function residentTree(level: number, imageLevel: number): BodyQuadtree {
  const tree = new BodyQuadtree(R, -9130, 10790);
  let next = 0;
  const visit = (n: TileNode): void => {
    makeReady(tree, n);
    n.heightLayer = next;
    n.normalLayer = next;
    n.imageLayer = n.level <= imageLevel ? next : -1;
    next++;
    if (n.level < level) for (const c of tree.childrenOf(n)) visit(c);
  };
  for (const root of tree.roots) visit(root);
  return tree;
}

function cut(tree: BodyQuadtree, maxLevel: number): SelectParams {
  const K = 2.44;
  return { frameIndex: 1, time: 0, observers: [observer(10, 20, 3000e3)], K, window: morphWindow(K), cap: maxLevel + 1, maxLevel, frustum: null, occluderRadius: 0, fadeSeconds: 0, prefetch: 0 };
}

describe('tile records', () => {
  it('a camera cut onto resident tiles: children drawn before their parent still blend towards the parent image', () => {
    const tree = residentTree(2, 2);
    tree.select(cut(tree, 2));
    const ctx: RecordContext = { tree, detailScales: [2, 14, 110, 900], orbitalWavelength: 640, pads: [], albedoLayer: layer(2), nightLayer: undefined };
    // Records in the order of the draw items, as the feature builds them. Children come before the
    // quadrants their parent keeps, and a parent that is refined everywhere is never drawn at all.
    let built = 0;
    let parentNeverBuilt = 0;
    for (const it of tree.items) {
      const n = it.node;
      if (n.constants) continue;
      n.constants = buildRecordConstants(n, ctx);
      expect(n.constants.length).toBe(RECORD_FLOATS);
      if (n.level === 0) continue;
      built++;
      if (!n.parent!.constants) parentNeverBuilt++;
      const flags = new Int32Array(n.constants.buffer)[RECORD_FLAGS_AT]!;
      // Every tile of levels 0..2 has an image of its own here, so the parent's is always another one.
      expect(flags & RECORD_FLAG_PARENT_IMAGE, `tile L${n.level} ${n.key.x},${n.key.y}`).toBe(RECORD_FLAG_PARENT_IMAGE);
      const images = new Int32Array(n.constants.buffer).subarray(16, 18);
      expect(images[0]).toBe(n.imageLayer);
      expect(images[1]).toBe(n.parent!.imageLayer);
    }
    expect(built).toBeGreaterThan(8);
    expect(parentNeverBuilt).toBeGreaterThan(0);
  });

  it('tiles below the deepest image level share their ancestor image with their parent', () => {
    const tree = residentTree(2, 1);
    tree.select(cut(tree, 2));
    const ctx: RecordContext = { tree, detailScales: [2, 14, 110, 900], orbitalWavelength: 640, pads: [], albedoLayer: layer(1), nightLayer: layer(0) };
    let level2 = 0;
    for (const it of tree.items) {
      const n = it.node;
      if (n.level !== 2 || n.constants) continue;
      n.constants = buildRecordConstants(n, ctx);
      level2++;
      const ints = new Int32Array(n.constants.buffer);
      expect(ints[RECORD_FLAGS_AT]! & RECORD_FLAG_PARENT_IMAGE).toBe(0);
      expect(ints[16]).toBe(n.parent!.imageLayer);
      expect(ints[17]).toBe(n.parent!.imageLayer);
      // The uv transform into the level-1 image: half the image, offset by the tile's place in its parent.
      expect(n.constants[26]).toBe(0.5);
      expect(n.constants[24]).toBe((n.key.x & 1) * 0.5);
      expect(n.nightOwner!.level).toBe(0);
      expect(n.parent!.nightOwner!.level).toBe(0);
    }
    expect(level2).toBeGreaterThan(0);
  });
});
