/**
 * Material textures: webp/png URLs and procedural textures registered by id, uploaded with full mip chains.
 * A material holds a TextureRef; until an image has loaded the ref points at a neutral 1x1 texture and its
 * `version` changes when the real one arrives (the mesh system then rebuilds the material bind group).
 */
import { createSolidTexture, createTextureChecked, mipCount, MipGenerator } from '../util/gpu';

export interface ProceduralTexture {
  width: number;
  height: number;
  /** rgba8, row 0 = v 0. */
  data: Uint8Array<ArrayBuffer>;
}

export interface TextureRef {
  view: GPUTextureView;
  version: number;
}

export type TextureRole = 'baseColor' | 'normal' | 'orm' | 'emissive';

export class TextureManager {
  private readonly procedural = new Map<string, ProceduralTexture>();
  private readonly cache = new Map<string, TextureRef>();
  private readonly defaults: Record<TextureRole, GPUTextureView>;
  private readonly mips: MipGenerator;
  private pending = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly assetsUrl: string,
    private readonly reportError: (m: string) => void,
    mips?: MipGenerator,
  ) {
    this.mips = mips ?? new MipGenerator(device);
    this.defaults = {
      baseColor: createSolidTexture(device, 'mesh.white', 'rgba8unorm-srgb', [1, 1, 1, 1]).createView(),
      normal: createSolidTexture(device, 'mesh.flatNormal', 'rgba8unorm', [0.5, 0.5, 1, 1]).createView(),
      // AO 1, roughness x1, metallic x1.
      orm: createSolidTexture(device, 'mesh.orm', 'rgba8unorm', [1, 1, 1, 1]).createView(),
      emissive: createSolidTexture(device, 'mesh.emissiveWhite', 'rgba8unorm-srgb', [1, 1, 1, 1]).createView(),
    };
  }

  /** Register (or replace) a procedural texture; materials refer to it by `id` in PbrMaterialDef.textures. */
  registerProcedural(id: string, texture: ProceduralTexture): void {
    this.procedural.set(id, texture);
    for (const [key, ref] of this.cache) {
      if (key.endsWith(`|${id}`)) {
        ref.view = this.upload(id, texture, key.startsWith('srgb')).createView();
        ref.version++;
      }
    }
  }

  pendingLoads(): number {
    return this.pending;
  }

  /** Resolve a material texture: a registered procedural id, else a URL (absolute, or relative to the assets base). */
  resolve(idOrUrl: string | undefined, role: TextureRole): TextureRef {
    if (!idOrUrl) return { view: this.defaults[role], version: 0 };
    const srgb = role === 'baseColor' || role === 'emissive';
    const key = `${srgb ? 'srgb' : 'lin'}|${idOrUrl}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const ref: TextureRef = { view: this.defaults[role], version: 0 };
    this.cache.set(key, ref);
    const proc = this.procedural.get(idOrUrl);
    if (proc) {
      ref.view = this.upload(idOrUrl, proc, srgb).createView();
      ref.version++;
      return ref;
    }
    const url = /^(https?:)?\/|^data:|^blob:/.test(idOrUrl) ? idOrUrl : `${this.assetsUrl}/${idOrUrl}`;
    this.pending++;
    this.load(url, srgb).then(
      (tex) => {
        ref.view = tex.createView();
        ref.version++;
        this.pending--;
      },
      (e: unknown) => {
        this.pending--;
        this.reportError(`texture ${url}: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
    return ref;
  }

  private create(label: string, width: number, height: number, srgb: boolean): GPUTexture {
    return createTextureChecked(
      this.device,
      {
        label: `mesh.tex.${label}`,
        format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
        size: [width, height],
        mipLevelCount: mipCount(width, height),
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      },
      this.reportError,
    );
  }

  private upload(label: string, t: ProceduralTexture, srgb: boolean): GPUTexture {
    const tex = this.create(label, t.width, t.height, srgb);
    this.device.queue.writeTexture({ texture: tex }, t.data, { bytesPerRow: t.width * 4 }, [t.width, t.height]);
    this.mips.generate(tex);
    return tex;
  }

  private async load(url: string, srgb: boolean): Promise<GPUTexture> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const tex = this.create(url, bitmap.width, bitmap.height, srgb);
    this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex, premultipliedAlpha: false }, [bitmap.width, bitmap.height]);
    bitmap.close();
    this.mips.generate(tex);
    return tex;
  }
}
