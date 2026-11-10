/**
 * Sound asset loading: every asset listed in audio/assets.json is fetched from `assetsUrl` and decoded
 * with decodeAudioData in the given context. Missing or undecodable files fail loudly with the file name.
 */
import type { AudioConfig } from './config';
import type { AssetBank } from './graph';

export interface AssetLoadProgress {
  loaded: number;
  total: number;
}

export async function loadAssetBank(
  ctx: BaseAudioContext,
  config: AudioConfig,
  assetsUrl: string,
  onProgress?: (p: AssetLoadProgress) => void,
): Promise<AssetBank> {
  const base = assetsUrl.replace(/\/+$/, '');
  const entries = Object.entries(config.assets);
  const buffers = new Map<string, AudioBuffer>();
  let loaded = 0;
  onProgress?.({ loaded, total: entries.length });
  await Promise.all(
    entries.map(async ([id, a]) => {
      const url = `${base}/${a.file}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`audio asset "${id}": ${url} HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(bytes);
      } catch (e) {
        throw new Error(`audio asset "${id}": ${url} could not be decoded (${e instanceof Error ? e.message : String(e)})`);
      }
      buffers.set(id, buffer);
      loaded++;
      onProgress?.({ loaded, total: entries.length });
    }),
  );
  return { buffers };
}
