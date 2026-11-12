#!/usr/bin/env node
/**
 * Cuts the recordings of tools/footage/record.mjs into the final film with ffmpeg.
 *
 *   node tools/footage/edit.mjs shots   [--in=out/footage/mission]                 the director's shots (from the events)
 *   node tools/footage/edit.mjs contact [--in=...] [--every=N] [--from=s --to=s]   one still per shot (or every N s),
 *                                                                                   tiled 4 x 4 with labels, into <in>.contact/
 *   node tools/footage/edit.mjs stills  --edl=<file.json> [--out=dir]              stills of the final cut's scenes
 *   node tools/footage/edit.mjs render  --edl=<file.json> --out=<file.mp4>         cut, ramp, crossfade, encode
 *
 * A take is a base path: `<base>.events.jsonl` plus either `<base>.segments.json` (the rotated files of
 * record.mjs, each with its start offset) or a single `<base>.mp4`. Times are seconds from the take's first file.
 *
 * EDL: { "takes": { "t1": "out/footage/take1", "t2": "out/footage/mission" }, "xfade": 0.5,
 *        "segments": [ { "take": "t2", "from": 123.4, "to": 140.0, "speed": 1, "label": "lift-off",
 *                        "join": "fade" | "fadeblack" | "cut", "gain": 1.0 }, ... ] }
 * `speed` > 1 compresses (audio time-stretched with atempo, so it stays in sync); `join` is the transition INTO the
 * segment (the first fades in from black, the last fades out). A segment that crosses a file boundary is cut over
 * to the next file in the middle of their 1.5 s overlap.
 *
 * Pass 1 renders every segment to a constant-60-fps intermediate (x264 CRF 10, PCM audio) of exactly known length;
 * pass 2 chains them with xfade / acrossfade and encodes H.264 High (CRF 17, yuv420p) + AAC 256 kbps, faststart.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FFDIR = process.env.FFMPEG_DIR ?? 'C:/Users/Shriv/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build/bin';
const FFMPEG = path.join(FFDIR, 'ffmpeg.exe');
const FFPROBE = path.join(FFDIR, 'ffprobe.exe');
const arg = (name, def) => {
  const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return def;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
const cmd = process.argv[2];
const THREADS = String(arg('threads', 0));
const FONT = 'C\\:/Windows/Fonts/consola.ttf';
const HANDOVER = 0.75;

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    if (opts.quiet) process.stderr.write(r.stderr?.toString() ?? '');
    throw new Error(`${path.basename(bin)} failed (${r.status}): ${args.join(' ').slice(0, 600)}`);
  }
  return r.stdout?.toString() ?? '';
}

function probeDuration(file) {
  return Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { quiet: true }).trim());
}

/** A take: its files with start offsets, its events, its total length. */
function loadTake(baseArg) {
  const base = path.resolve(repoRoot, baseArg);
  const dir = path.dirname(base);
  let sources;
  if (fs.existsSync(`${base}.segments.json`)) {
    sources = JSON.parse(fs.readFileSync(`${base}.segments.json`, 'utf8')).map((s) => ({ file: path.join(dir, s.file), offset: s.offset }));
  } else {
    const f = [`${base}.mp4`, `${base}.webm`, `${base}.partial`].find((x) => fs.existsSync(x));
    if (!f) throw new Error(`no recording for ${base}`);
    sources = [{ file: f, offset: 0 }];
  }
  sources = sources.filter((s) => fs.existsSync(s.file));
  for (const s of sources) s.duration = probeDuration(s.file);
  const lastS = sources[sources.length - 1];
  const events = fs.existsSync(`${base}.events.jsonl`)
    ? fs
        .readFileSync(`${base}.events.jsonl`, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return { base, sources, events, total: lastS.offset + lastS.duration };
}

/** Index of the file that serves take time g (switching to the next file in the middle of the overlap). */
function fileIndexAt(take, g) {
  let k = 0;
  for (let i = 1; i < take.sources.length; i++) if (g >= take.sources[i].offset + HANDOVER) k = i;
  return k;
}

/** [from, to] of a take as pieces of files: { file, a, b } in file-local seconds. */
function piecesOf(take, from, to) {
  const out = [];
  let t = from;
  while (t < to - 1e-6) {
    const k = fileIndexAt(take, t);
    const next = take.sources[k + 1];
    const end = next ? Math.min(to, next.offset + HANDOVER) : to;
    const s = take.sources[k];
    out.push({ file: s.file, a: t - s.offset, b: end - s.offset });
    t = end;
  }
  return out;
}

/** Shots from the events: { i, shot, phase, start, end (s), alt, warp, milestones }. */
function shotsOf(take) {
  const shots = [];
  let phase = null;
  const milestones = [];
  for (const e of take.events) {
    if (e.type === 'phase') phase = e.phase;
    if (e.type === 'milestone') milestones.push({ t: e.t / 1000, id: e.id });
    if (e.type === 'shot') {
      if (shots.length) shots[shots.length - 1].end = e.t / 1000;
      shots.push({ i: shots.length, shot: e.shot, phase: e.phase ?? phase, start: e.t / 1000, end: take.total, alt: e.alt, warp: e.warp, met: e.met });
    }
  }
  for (const s of shots) s.milestones = milestones.filter((m) => m.t >= s.start && m.t < s.end).map((m) => `${m.id}@${m.t.toFixed(1)}`);
  return shots;
}

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function still(take, t, label, outFile, width = 640) {
  const k = fileIndexAt(take, t);
  const s = take.sources[k];
  const lab = label.replace(/\\/g, '').replace(/:/g, '\\:').replace(/'/g, '');
  run(FFMPEG, ['-v', 'error', '-y', '-ss', Math.max(0, t - s.offset).toFixed(3), '-i', s.file, '-frames:v', '1', '-vf', `scale=${width}:-2,drawtext=fontfile='${FONT}':text='${lab}':x=6:y=6:fontsize=${Math.round(width / 40)}:fontcolor=yellow:box=1:boxcolor=black@0.6`, '-q:v', '3', outFile], { quiet: true });
}

function tile(files, dir, prefix) {
  const per = 16;
  const sheets = [];
  for (let s = 0; s * per < files.length; s++) {
    const list = files.slice(s * per, (s + 1) * per);
    const out = path.join(dir, `${prefix}-${String(s).padStart(2, '0')}.jpg`);
    const inputs = list.flatMap((f) => ['-i', f]);
    const n = list.length;
    const layout = list.map((_, k) => `${(k % 4) * 640}_${Math.floor(k / 4) * 360}`).join('|');
    const filter = n === 1 ? '[0:v]null[o]' : `${list.map((_, k) => `[${k}:v]`).join('')}xstack=inputs=${n}:layout=${layout}:fill=black[o]`;
    run(FFMPEG, ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[o]', '-q:v', '3', out], { quiet: true });
    sheets.push(out);
  }
  for (const f of files) fs.rmSync(f);
  return sheets;
}

if (cmd === 'shots' || cmd === 'contact') {
  const take = loadTake(String(arg('in', 'out/footage/mission')));
  const shots = shotsOf(take);
  if (cmd === 'shots') {
    for (const s of shots) console.log(`${String(s.i).padStart(3)} ${fmt(s.start).padStart(7)} - ${fmt(s.end).padStart(7)} (${(s.end - s.start).toFixed(1).padStart(5)} s) ${s.phase.padEnd(24)} ${s.shot.padEnd(20)} alt ${(s.alt / 1000).toFixed(1).padStart(9)} km warp ${String(s.warp).padStart(5)} ${s.milestones.join(' ')}`);
    console.log(`total ${fmt(take.total)} (${take.total.toFixed(1)} s), ${shots.length} shots, ${take.sources.length} files`);
  } else {
    const dir = `${take.base}.contact`;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    const every = Number(arg('every', 0));
    const picks = [];
    if (every > 0) for (let t = 1; t < take.total - 0.5; t += every) picks.push({ t, label: `${fmt(t)}` });
    else for (const s of shots) picks.push({ t: Math.min(s.end - 0.3, s.start + Math.max(1.2, Math.min(6, (s.end - s.start) / 2))), label: `#${s.i} ${fmt(s.start)} ${s.shot} ${s.phase}` });
    const from = Number(arg('from', 0));
    const to = Number(arg('to', 1e9));
    const files = [];
    picks
      .filter((p) => p.t >= from && p.t <= to)
      .forEach((p, k) => {
        const f = path.join(dir, `still-${String(k).padStart(4, '0')}.jpg`);
        still(take, p.t, p.label, f);
        files.push(f);
      });
    for (const s of tile(files, dir, 'sheet')) console.log(s);
  }
} else if (cmd === 'render' || cmd === 'stills') {
  const edl = JSON.parse(fs.readFileSync(path.resolve(repoRoot, String(arg('edl'))), 'utf8'));
  const takes = {};
  const takeIds = Object.keys(edl.takes);
  for (const id of takeIds) takes[id] = loadTake(edl.takes[id]);
  const X = edl.xfade ?? 0.5;
  const segs = edl.segments;
  const joinD = (j) => (j === 'cut' ? 0 : j === 'fadeblack' ? Math.max(X, 0.8) : X);
  // Lengths and where every segment starts in the final cut.
  let t = 0;
  const parts = segs.map((s, k) => {
    const speed = s.speed ?? 1;
    const frames = Math.round(((s.to - s.from) / speed) * 60);
    const dur = frames / 60;
    if (k > 0) t -= joinD(s.join ?? 'fade');
    const p = { k, take: takes[s.take ?? takeIds[0]], seg: s, speed, frames, dur, at: t, join: s.join ?? 'fade', label: s.label };
    t += dur;
    return p;
  });
  const total = t;

  if (cmd === 'stills') {
    // Three stills per scene (start, middle, end) of the SOURCE, labelled with the final-cut time.
    const dir = path.resolve(String(arg('out', path.join(repoRoot, 'out/footage/edl-stills'))));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    const files = [];
    for (const p of parts) {
      for (const [q, name] of [[0.12, 'a'], [0.5, 'b'], [0.88, 'c']]) {
        const src = p.seg.from + (p.seg.to - p.seg.from) * q;
        const f = path.join(dir, `s-${String(p.k).padStart(3, '0')}${name}.jpg`);
        still(p.take, src, `${p.k} ${fmt(p.at + p.dur * q)} ${p.label} x${p.speed}`, f);
        files.push(f);
      }
    }
    for (const s of tile(files, dir, 'scenes')) console.log(s);
    console.log(`final length ${fmt(total)} (${total.toFixed(1)} s), ${parts.length} segments`);
    process.exit(0);
  }

  const out = path.resolve(String(arg('out')));
  const work = path.resolve(repoRoot, String(arg('work', 'out/footage/work')));
  fs.mkdirSync(work, { recursive: true });
  const only = arg('only', null);

  // Pass 1: one intermediate per segment, CFR 60, exact length.
  for (const p of parts) {
    const s = p.seg;
    p.file = path.join(work, `seg-${String(p.k).padStart(3, '0')}.mkv`);
    if (only !== null && !String(only).split(',').map(Number).includes(p.k)) continue;
    if (!arg('force', false) && fs.existsSync(p.file) && fs.statSync(p.file).size > 0 && Math.abs(probeDuration(p.file) - p.dur) < 0.05) continue;
    const atempo = [];
    let r = p.speed;
    while (r > 2.0001) {
      atempo.push('atempo=2');
      r /= 2;
    }
    if (Math.abs(r - 1) > 1e-6) atempo.push(`atempo=${r.toFixed(6)}`);
    const pieces = piecesOf(p.take, s.from, s.to);
    const inputs = [];
    pieces.forEach((pc, i) => {
      const extra = i === pieces.length - 1 ? 0.5 : 0;
      inputs.push('-ss', pc.a.toFixed(3), '-t', (pc.b - pc.a + extra).toFixed(3), '-i', pc.file);
    });
    const vf = [`setpts=(PTS-STARTPTS)/${p.speed}`, 'fps=60', `trim=end_frame=${p.frames}`, 'setpts=PTS-STARTPTS', ...(s.vf ? [s.vf] : [])].join(',');
    const af = ['asetpts=PTS-STARTPTS', ...atempo, ...(s.gain ? [`volume=${s.gain}`] : []), 'aresample=48000', `apad=whole_dur=${p.dur.toFixed(4)}`, `atrim=end=${p.dur.toFixed(4)}`].join(',');
    let head;
    if (pieces.length === 1) head = '[0:v]null[cv];[0:a]anull[ca]';
    else {
      // Exact piece lengths, then join: the overlap of the two files makes this a seamless cut.
      const trims = pieces.map((pc, i) => `[${i}:v]trim=duration=${(pc.b - pc.a).toFixed(4)},setpts=PTS-STARTPTS[v${i}];[${i}:a]atrim=duration=${(pc.b - pc.a).toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`);
      if (pieces.length > 1) trims[pieces.length - 1] = `[${pieces.length - 1}:v]setpts=PTS-STARTPTS[v${pieces.length - 1}];[${pieces.length - 1}:a]asetpts=PTS-STARTPTS[a${pieces.length - 1}]`;
      head = `${trims.join(';')};${pieces.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${pieces.length}:v=1:a=1[cv][ca]`;
    }
    console.log(`seg ${p.k}: ${p.label} ${s.take ?? takeIds[0]} ${s.from.toFixed(2)}-${s.to.toFixed(2)} x${p.speed} -> ${p.dur.toFixed(2)} s (${pieces.length} file${pieces.length > 1 ? 's' : ''})`);
    run(FFMPEG, ['-v', 'error', '-y', ...inputs, '-filter_complex', `${head};[cv]${vf}[v];[ca]${af}[a]`, '-map', '[v]', '-map', '[a]', '-threads', THREADS, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', p.file]);
  }
  if (arg('pass1', false)) process.exit(0);

  // Pass 2: crossfade chain. Output length after joining k: L_k = L_{k-1} + d_k - D (D = 0 for a cut).
  const inputs = parts.flatMap((p) => ['-i', p.file]);
  const fv = [];
  const fa = [];
  let vPrev = '[0:v]';
  let aPrev = '[0:a]';
  let L = parts[0].dur;
  for (let k = 1; k < parts.length; k++) {
    const p = parts[k];
    const vOut = `[v${k}]`;
    const aOut = `[a${k}]`;
    if (p.join === 'cut') {
      fv.push(`${vPrev}[${k}:v]concat=n=2:v=1:a=0${vOut}`);
      fa.push(`${aPrev}[${k}:a]concat=n=2:v=0:a=1${aOut}`);
      L += p.dur;
    } else {
      const D = joinD(p.join);
      fv.push(`${vPrev}[${k}:v]xfade=transition=${p.join}:duration=${D}:offset=${(L - D).toFixed(4)}${vOut}`);
      fa.push(`${aPrev}[${k}:a]acrossfade=d=${D}:c1=tri:c2=tri${aOut}`);
      L += p.dur - D;
    }
    vPrev = vOut;
    aPrev = aOut;
  }
  const fadeOut = Math.max(0, L - 2);
  fv.push(`${vPrev}fade=t=in:st=0:d=1.0,fade=t=out:st=${fadeOut.toFixed(3)}:d=2,format=yuv420p[vout]`);
  fa.push(`${aPrev}afade=t=in:st=0:d=1.0,afade=t=out:st=${fadeOut.toFixed(3)}:d=2[aout]`);
  const graphFile = path.join(work, 'graph.txt');
  fs.writeFileSync(graphFile, [...fv, ...fa].join(';\n'));
  console.log(`pass 2: ${parts.length} segments, ${L.toFixed(1)} s`);
  fs.writeFileSync(out.replace(/\.mp4$/, '.scenes.json'), JSON.stringify(parts.map((p) => ({ k: p.k, at: +p.at.toFixed(2), dur: +p.dur.toFixed(2), label: p.label, take: p.seg.take, from: p.seg.from, to: p.seg.to, speed: p.speed })), null, 1));
  run(FFMPEG, ['-v', 'error', '-stats', '-y', ...inputs, '-/filter_complex', graphFile, '-map', '[vout]', '-map', '[aout]', '-threads', THREADS, '-c:v', 'libx264', '-preset', String(arg('preset', 'slow')), '-crf', String(arg('crf', 17)), '-profile:v', 'high', '-level:v', '5.1', '-pix_fmt', 'yuv420p', '-r', '60', '-g', '120', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', out]);
  console.log(`wrote ${out}`);
} else {
  console.error('usage: node tools/footage/edit.mjs shots|contact|stills|render ...');
  process.exit(2);
}
