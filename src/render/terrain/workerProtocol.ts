/**
 * Messages between the terrain streamer (main thread) and its tile workers. A job produces everything a
 * render tile needs: the terrain-core bake (65 x 65 heights, 256 x 256 normal/material map) and, when the
 * tile sits at a level that has image data of its own, the decoded image tiles.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { TileKey } from '@/core/geo/cubeSphere';

export interface WorkerInit {
  type: 'init';
  /** Definitions the height authority needs (bodies and sites; the other sections may be empty). */
  defs: DefLibrary;
  /** Tile root, e.g. "/tiles" or an absolute URL. */
  tilesUrl: string;
  /** Bodies with terrain to serve. */
  bodies: string[];
  /** Decoded-tile cache budget of the worker's height authority, bytes. */
  cacheBytes: number;
}

export interface TileJob {
  type: 'tile';
  id: number;
  bodyId: string;
  tileset: string;
  key: TileKey;
  /** Fetch and decode the albedo image and the aux bytes (water mask, land cover) of this very tile. */
  image: boolean;
  /** Fetch and decode the night-light image of this very tile. */
  night: boolean;
}

export type WorkerRequest = WorkerInit | TileJob;

export interface TileResult {
  type: 'tile';
  id: number;
  /** 65 x 65 float32 heights (m above the reference radius), row = v. */
  heights: Float32Array<ArrayBuffer>;
  hMin: number;
  hMax: number;
  /** 256 x 256 rgba8: encoded slopes, AO, material weight (terrain-core NormalMaterialBake). */
  normal: Uint8Array<ArrayBuffer>;
  slopeScale: number;
  /** False when the bake ran on incomplete data (a bake bug: prepareTile loads everything). */
  complete: boolean;
  /** Decoded albedo (premultiplyAlpha 'none', colorSpaceConversion 'none'); null when not requested. */
  albedo: ImageBitmap | null;
  /** 256 x 256 x 2 bytes: r = water mask (0 land .. 255 water), g = land-cover class id; null when not requested. */
  aux: Uint8Array<ArrayBuffer> | null;
  /** Night lights, NIGHT_SIZE x NIGHT_SIZE bytes (nightImage.ts); null when not requested or when the tile is completely dark. */
  night: Uint8Array<ArrayBuffer> | null;
  nightDark: boolean;
  /** Milliseconds spent baking and decoding (diagnostics). */
  bakeMs: number;
  imageMs: number;
}

export interface WorkerReady {
  type: 'ready';
}

export interface WorkerFailure {
  type: 'error';
  /** Job id, or -1 for an initialisation failure. */
  id: number;
  message: string;
}

export type WorkerResponse = TileResult | WorkerReady | WorkerFailure;

/** Options every image tile is decoded with (ARCHITECTURE section 1, row 5). */
export const IMAGE_DECODE_OPTIONS: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
