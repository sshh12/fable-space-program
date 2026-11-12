/**
 * Photographic source images of the cockpit's material sets, generated with an image model:
 *
 *   npx tsx tools/cockpit/photo-source.ts --list-models
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/cockpit/photo-source.ts [--only <id>[,<id>...]] [--force] [--model <id>] [--quality high]
 *
 * Each entry of SOURCES is one square, straight-on photograph of a flat sample of a cabin material at a stated
 * size, lit evenly (the renderer lights it). The images go to data/cache/cockpit/photo/<id>.png (not
 * committed: they are inputs of tools/cockpit/bake-textures.ts, which makes them tileable, removes residual
 * shading and derives the detail layers), and what each call used is appended to
 * data/cache/cockpit/photo/usage.json (the spend record of the package's 50 USD budget).
 *
 * The key is read from .env (OPENAI_API_KEY) and sent only in the Authorization header; it is never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(repo, 'data', 'cache', 'cockpit', 'photo');

const COMMON =
  'Macro product photograph taken exactly straight on (orthographic, perpendicular to the surface), the same material filling the whole square ' +
  'frame edge to edge at a constant scale. Flat, even, shadowless light-tent lighting: no directional light, no cast shadows, no specular ' +
  'hot spots, no vignetting, like a calibrated albedo scan of a material sample. Uniform density of features across the whole frame, no focal ' +
  'object, no border, no seams of the sample visible, no text, no labels, no logos, no hands, no tools. Sharp focus everywhere, natural muted ' +
  'colours, photorealistic, high detail.';

/** id -> what the frame shows, with its size on the material (the detail layer's tile). */
export const SOURCES: Record<string, string> = {
  paint:
    'Frame covers 50 cm x 50 cm of a flat aluminium aircraft interior panel sprayed with pale grey semi-gloss epoxy paint, years in service: ' +
    'faint orange-peel texture, many fine hairline scratches in random directions, small scuffs and rub marks, a few tiny chips showing ' +
    'yellow-green primer or bare metal, faint smudges and fingerprints, slight uneven sheen. No rivets, no screws, no joints.',
  brushed:
    'Frame covers 40 cm x 40 cm of a flat sheet of bare brushed aluminium, satin finish with a fine straight horizontal grain, years in ' +
    'service: light handling scratches across the grain, faint dull oxidation blotches, a few small scuffs. No holes, no fasteners, no edges.',
  fabric:
    'Frame covers 12 cm x 12 cm of dark navy-grey flame-resistant aramid seat cover fabric, a tight plain weave seen close: individual ' +
    'warp and weft yarns visible, slight pilling and lint, subtle uneven wear and a few lighter rubbed areas. No stitching, no seams, no folds.',
  nomex:
    'Frame covers 20 cm x 20 cm of off-white beta cloth, the woven glass-fibre fabric of spacecraft insulation blankets, laid flat: fine tight ' +
    'basket weave with a faint sheen, very slight soft wrinkles and creases, a few faint grey handling smudges and yellowish age stains. ' +
    'No stitching, no seams, no quilting.',
  webbing:
    'Frame covers 10 cm x 10 cm filled completely with flat woven nylon harness webbing in natural beige, the strap wide enough to fill the ' +
    'frame: tight herringbone twill ribs running vertically, slight fuzz, faint soiling and abrasion along the ribs. No edges of the strap ' +
    'visible, no stitching, no buckles.',
  velcro:
    'Frame covers 6 cm x 6 cm of beige hook-and-loop fastener, the soft loop side, seen very close: a dense mat of tiny curled nylon loops, ' +
    'slightly matted and flattened in places, with a little lint caught in it. No edges, no stitching.',
  rubber:
    'Frame covers 15 cm x 15 cm of a flat sheet of black moulded silicone rubber, matte: very fine pebbled mould texture, faint dust, a few ' +
    'pale scuff marks and light scratches. No edges, no ribs.',
  cast:
    'Frame covers 15 cm x 15 cm of a flat face of a black hard-anodised machined aluminium part, matte: very fine bead-blasted texture, ' +
    'faint machining swirl marks, a few bright hairline scratches and tiny nicks showing bare metal, faint fingerprints. No holes, no edges.',
};

interface ImageResponse {
  data?: { b64_json?: string }[];
  usage?: unknown;
}

function readKey(): string {
  for (const line of fs.readFileSync(path.join(repo, '.env'), 'utf8').split(/\r?\n/)) {
    if (line.startsWith('OPENAI_API_KEY=')) {
      const value = line.slice('OPENAI_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
      if (value) return value;
    }
  }
  throw new Error('OPENAI_API_KEY is not set in .env');
}

async function request(url: string, key: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: body === null ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 600)}`);
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
  };
  const key = readKey();
  if (args.includes('--list-models')) {
    const models = (await request('https://api.openai.com/v1/models', key, null)) as { data?: { id: string }[] };
    for (const id of (models.data ?? []).map((m) => m.id).sort()) if (id.includes('image') || id.includes('dall')) console.log(id);
    return;
  }
  const model = opt('model', 'gpt-image-2');
  const quality = opt('quality', 'high');
  const only = opt('only', '').split(',').filter(Boolean);
  const force = args.includes('--force');
  fs.mkdirSync(outDir, { recursive: true });
  const usageFile = path.join(outDir, 'usage.json');
  const usage: { id: string; model: string; quality: string; at: string; tokens: unknown }[] = fs.existsSync(usageFile) ? JSON.parse(fs.readFileSync(usageFile, 'utf8')) : [];
  for (const id of only.length > 0 ? only : Object.keys(SOURCES)) {
    const prompt = SOURCES[id];
    if (!prompt) throw new Error(`unknown source "${id}"`);
    const out = path.join(outDir, `${id}.png`);
    if (fs.existsSync(out) && !force) continue;
    const t0 = Date.now();
    let res: ImageResponse | null = null;
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      try {
        res = (await request('https://api.openai.com/v1/images/generations', key, { model, prompt: `${prompt} ${COMMON}`, size: '1024x1024', quality, n: 1 })) as ImageResponse;
      } catch (err) {
        console.error(`${id}: attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
    const b64 = res?.data?.[0]?.b64_json;
    if (!b64) throw new Error(`${id}: the response holds no image`);
    const png = Buffer.from(b64, 'base64');
    fs.writeFileSync(out, png);
    usage.push({ id, model, quality, at: new Date().toISOString(), tokens: res?.usage ?? null });
    fs.writeFileSync(usageFile, JSON.stringify(usage, null, 1));
    console.log(`${id}: ${Math.round(png.length / 1024)} KiB in ${Math.round((Date.now() - t0) / 1000)} s, usage ${JSON.stringify(res?.usage ?? null)}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
