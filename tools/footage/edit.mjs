#!/usr/bin/env node
/**
 * Cuts the recordings of tools/footage/record.mjs into the final film with ffmpeg.
 *
 *   node tools/footage/edit.mjs shots   [--in=out/footage/mission]                 the director's shots (from the events)
 *   node tools/footage/edit.mjs contact [--in=...] [--every=N] [--from=s --to=s]   one still per recorded shot (or every
 *                                                                                   N s), tiled 4 x 4 with labels, into <in>.contact/
 *   node tools/footage/edit.mjs stills  --edl=<file.json> [--out=dir]              stills of the final cut's scenes
 *   node tools/footage/edit.mjs render  --edl=<file.json> --out=<file.mp4>         cut, ramp, crossfade, encode (one pass)
 *
 * A take is a base path: `<base>.events.jsonl` plus either `<base>.segments.json` (the files of record.mjs, each with
 * its start and end on the take's clock; the director's duty windows leave gaps between them, a rotation makes two
 * overlap by 1.5 s) or a single `<base>.mp4`. Times are seconds on the take's clock.
 *
 * EDL: { "takes": { "m": "out/footage/mission" }, "xfade": 0.5,
 *        "segments": [ { "title": ["MERIDIAN", "..."], "dur": 5 },
 *                      { "take": "m", "from": 123.4, "to": 140.0, "speed": 1, "label": "lift-off",
 *                        "join": "fade" | "fadeblack" | "cut", "gain": 1.0 }, ... ] }
 * `speed` > 1 compresses (audio time-stretched with atempo, so it stays in sync); `join` is the transition INTO the
 * segment (the first fades in from black, the last fades out). A segment must lie inside recorded footage; one that
 * crosses a rotation is cut over to the next file in the middle of their overlap. A `title` segment is a plain card
 * (black, centred lines, silence).
 *
 * In chunks: consecutive segments (split only at hard cuts, about --chunk=7 at a time) are rendered from the raw files
 * (every piece an input of its own, seeked with -ss; each segment exactly `frames` long at 60 fps CFR; joined with
 * xfade / acrossfade / concat) to x264 CRF 12 intermediates with PCM sound; the chunks are then read one after
 * another (concat demuxer) and encoded to H.264 High (x264, CRF 18 by default, preset slow, yuv420p, aq-mode 3 for the
 * dark sky) + AAC 256 kbps, faststart. (One graph with every input ran out of memory: ffmpeg decodes ahead on each.)
 * A chunk whose segments did not change is kept (--force renders all again); --pass1 stops before the final encode.
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
const FONT = 'C\\:/Windows/Fonts/consola.ttf';
const TITLE_FONT = 'C\\:/Windows/Fonts/bahnschrift.ttf';
const HANDOVER = 0.75;
const OUT_W = Number(arg('width', 2560));
const OUT_H = Number(arg('height', 1440));

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    if (opts.quiet) process.stderr.write(r.stderr?.toString() ?? '');
    throw new Error(`${path.basename(bin)} failed (${r.status}): ${args.join(' ').slice(0, 600)}`);
  }
  return r.stdout?.toString() ?? '';
}

function probe(file) {
  const j = JSON.parse(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], { quiet: true }));
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  return { duration: Number(j.format?.duration ?? 0), width: v?.width ?? 0, height: v?.height ?? 0 };
}

/** A take: its files with start offsets and ends, its events, its total length. */
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
  sources = sources.filter((s) => fs.existsSync(s.file) && fs.statSync(s.file).size > 0);
  for (const s of sources) {
    const p = probe(s.file);
    s.duration = p.duration;
    s.width = p.width;
    s.height = p.height;
    s.end = s.offset + s.duration;
  }
  const events = fs.existsSync(`${base}.events.jsonl`)
    ? fs
        .readFileSync(`${base}.events.jsonl`, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return { base, sources, events, total: Math.max(0, ...sources.map((s) => s.end)) };
}

/** Index of the file that serves take time g (in a rotation's overlap: the later file after the handover), or -1. */
function fileIndexAt(take, g) {
  let k = -1;
  for (let i = 0; i < take.sources.length; i++) {
    const s = take.sources[i];
    if (g >= s.offset - 1e-6 && g < s.end - 0.02) {
      if (k < 0 || g >= s.offset + HANDOVER) k = i;
    }
  }
  return k;
}

/** [from, to] of a take as pieces of files: { file, a, b } in file-local seconds. Throws on a gap. */
function piecesOf(take, from, to) {
  const out = [];
  let t = from;
  while (t < to - 1e-6) {
    const k = fileIndexAt(take, t);
    if (k < 0) throw new Error(`no footage at ${t.toFixed(2)} s of ${path.basename(take.base)} (segment ${from.toFixed(2)}-${to.toFixed(2)})`);
    const s = take.sources[k];
    // The next file that starts inside this one (a rotation) takes over in the middle of the overlap.
    const next = take.sources.find((x, i) => i !== k && x.offset > s.offset && x.offset < s.end && x.offset + HANDOVER > t);
    let end = Math.min(to, s.end - 0.02);
    if (next) end = Math.min(end, next.offset + HANDOVER);
    if (end <= t + 1e-6) throw new Error(`footage ends at ${t.toFixed(2)} s`);
    out.push({ file: s.file, a: t - s.offset, b: end - s.offset, src: s });
    t = end;
  }
  return out;
}

const covered = (take, a, b) => {
  try {
    piecesOf(take, a, b);
    return true;
  } catch {
    return false;
  }
};

/** Shots from the events: { i, shot, phase, start, end (s), alt, warp, met, milestones, rec: recorded share }. */
function shotsOf(take) {
  const shots = [];
  let phase = null;
  const milestones = [];
  const marks = [];
  for (const e of take.events) {
    if (e.type === 'phase') phase = e.phase;
    if (e.type === 'milestone') milestones.push({ t: e.t / 1000, id: e.id });
    if (e.type === 'peak' || e.type === 'key' || e.type === 'pilot') marks.push({ t: e.t / 1000, id: e.type === 'peak' ? `peak:${e.what}` : e.type === 'key' ? `key:${e.code}` : `pilot:${e.action}` });
    if (e.type === 'hudWant') marks.push({ t: e.t / 1000, id: `hud:${e.hud ? 'on' : 'off'}` });
    if (e.type === 'shot') {
      if (shots.length) shots[shots.length - 1].end = e.t / 1000;
      shots.push({ i: shots.length, shot: e.shot, phase: e.phase ?? phase, start: e.t / 1000, end: take.total, alt: e.alt, warp: e.warp, met: e.met });
    }
  }
  for (const s of shots) {
    s.milestones = milestones.filter((m) => m.t >= s.start && m.t < s.end).map((m) => `${m.id}@${m.t.toFixed(1)}`);
    s.marks = marks.filter((m) => m.t >= s.start && m.t < s.end).map((m) => `${m.id}@${m.t.toFixed(1)}`);
    // Recorded share of the shot, in 0.25 s steps.
    let n = 0;
    let c = 0;
    for (let t = s.start; t < s.end; t += 0.25, n++) if (fileIndexAt(take, t) >= 0) c++;
    s.rec = n ? c / n : 0;
  }
  return shots;
}

const fmt = (s) => `${s < 0 ? '-' : ''}${Math.floor(Math.abs(s) / 60)}:${(Math.abs(s) % 60).toFixed(1).padStart(4, '0')}`;

function still(take, t, label, outFile, width = 640) {
  const k = fileIndexAt(take, t);
  if (k < 0) return false;
  const s = take.sources[k];
  const lab = label.replace(/\\/g, '').replace(/:/g, '\\:').replace(/'/g, '');
  run(FFMPEG, ['-v', 'error', '-y', '-ss', Math.max(0, t - s.offset).toFixed(3), '-i', s.file, '-frames:v', '1', '-vf', `scale=${width}:-2,drawtext=fontfile='${FONT}':text='${lab}':x=6:y=6:fontsize=${Math.round(width / 40)}:fontcolor=yellow:box=1:boxcolor=black@0.6`, '-q:v', '3', outFile], { quiet: true });
  return true;
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

const escText = (s) => String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%');

if (cmd === 'draft') {
  // A first EDL: every recorded shot as a segment (its longest recorded stretch, from 0.8 s after the cut and
  // after any HUD key press, at most --max s), a fade to black across a jump of more than a minute of take time.
  const inArg = String(arg('in', 'out/footage/mission'));
  const take = loadTake(inArg);
  const shots = shotsOf(take);
  const keys = take.events.filter((e) => e.type === 'key').map((e) => e.t / 1000);
  const max = Number(arg('max', 12));
  const segments = [];
  let prevEnd = -1e9;
  for (const s of shots) {
    if (s.rec < 0.2) continue;
    let best = null;
    let cur = null;
    for (let t = s.start; t < s.end; t += 0.25) {
      const ok = fileIndexAt(take, t) >= 0 && fileIndexAt(take, Math.min(t + 0.25, s.end - 0.01)) >= 0;
      if (ok) cur = cur ? { a: cur.a, b: t + 0.25 } : { a: t, b: t + 0.25 };
      else cur = null;
      if (cur && (!best || cur.b - cur.a > best.b - best.a)) best = { ...cur };
    }
    if (!best) continue;
    let from = Math.max(best.a + 0.8, s.start + 0.8);
    for (const k of keys) if (k >= s.start - 0.2 && k < best.b && k + 0.25 > from) from = k + 0.25;
    const to = Math.min(best.b - 0.1, s.end - 0.05, from + max);
    if (to - from < 1.5) continue;
    segments.push({ take: 'm', from: +from.toFixed(2), to: +to.toFixed(2), speed: 1, label: `${s.phase} ${s.shot}`, join: from - prevEnd > 60 ? 'fadeblack' : 'cut' });
    prevEnd = to;
  }
  const edl = { takes: { m: inArg }, xfade: 0.5, segments: [{ title: ['MERIDIAN', 'Lunar Flight Simulator'], dur: 5 }, ...segments] };
  const outFile = path.resolve(String(arg('out', `${take.base}.draft.json`)));
  fs.writeFileSync(outFile, JSON.stringify(edl, null, 1));
  const len = segments.reduce((a, s) => a + (s.to - s.from), 0);
  console.log(`${outFile}: ${segments.length} segments, ${len.toFixed(1)} s`);
} else if (cmd === 'shots' || cmd === 'contact') {
  const take = loadTake(String(arg('in', 'out/footage/mission')));
  const shots = shotsOf(take);
  if (cmd === 'shots') {
    for (const s of shots)
      console.log(
        `${String(s.i).padStart(3)} ${fmt(s.start).padStart(7)} - ${fmt(s.end).padStart(7)} (${(s.end - s.start).toFixed(1).padStart(5)} s) rec ${(s.rec * 100).toFixed(0).padStart(3)}% ${String(s.phase).padEnd(22)} ${s.shot.padEnd(20)} alt ${(s.alt / 1000).toFixed(1).padStart(9)} km warp ${String(s.warp).padStart(5)} met ${Math.round(s.met)} ${s.milestones.join(' ')} ${s.marks.join(' ')}`,
      );
    console.log(`total ${fmt(take.total)} (${take.total.toFixed(1)} s), ${shots.length} shots, ${take.sources.length} files, recorded ${take.sources.reduce((a, s) => a + s.duration, 0).toFixed(1)} s`);
  } else {
    const dir = `${take.base}.contact`;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    const every = Number(arg('every', 0));
    const picks = [];
    if (every > 0) for (let t = 0.5; t < take.total - 0.3; t += every) picks.push({ t, label: `${fmt(t)}` });
    else
      for (const s of shots) {
        if (s.rec < 0.05) continue;
        // The middle of the recorded part of the shot.
        const ts = [];
        for (let t = s.start + 0.6; t < s.end - 0.3; t += 0.25) if (fileIndexAt(take, t) >= 0) ts.push(t);
        if (ts.length) picks.push({ t: ts[Math.floor(ts.length / 2)], label: `#${s.i} ${fmt(s.start)} ${s.shot} ${s.phase}` });
      }
    const from = Number(arg('from', 0));
    const to = Number(arg('to', 1e9));
    const files = [];
    let k = 0;
    for (const p of picks.filter((p) => p.t >= from && p.t <= to)) {
      const f = path.join(dir, `still-${String(k).padStart(4, '0')}.jpg`);
      if (still(take, p.t, p.label, f)) {
        files.push(f);
        k++;
      }
    }
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
    const isTitle = Array.isArray(s.title);
    const frames = Math.round((isTitle ? s.dur : (s.to - s.from) / speed) * 60);
    const dur = frames / 60;
    if (k > 0) t -= joinD(s.join ?? 'fade');
    const p = { k, title: isTitle ? s.title : null, take: isTitle ? null : takes[s.take ?? takeIds[0]], seg: s, speed, frames, dur, at: t, join: s.join ?? 'fade', label: s.label ?? (isTitle ? 'title' : '') };
    t += dur;
    return p;
  });
  const total = t;
  // Every segment must lie in recorded footage.
  for (const p of parts) if (!p.title) p.pieces = piecesOf(p.take, p.seg.from, p.seg.to);

  if (cmd === 'stills') {
    // Three stills per scene (start, middle, end) of the SOURCE, labelled with the final-cut time.
    const dir = path.resolve(String(arg('out', path.join(repoRoot, 'out/footage/edl-stills'))));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    const files = [];
    for (const p of parts) {
      if (p.title) continue;
      for (const [q, name] of [[0.06, 'a'], [0.5, 'b'], [0.94, 'c']]) {
        const src = p.seg.from + (p.seg.to - p.seg.from) * q;
        const f = path.join(dir, `s-${String(p.k).padStart(3, '0')}${name}.jpg`);
        if (still(p.take, src, `${p.k} ${fmt(p.at + p.dur * q)} ${p.label} x${p.speed}`, f)) files.push(f);
      }
    }
    for (const s of tile(files, dir, 'scenes')) console.log(s);
    console.log(`final length ${fmt(total)} (${total.toFixed(1)} s), ${parts.length} segments`);
    process.exit(0);
  }

  const out = path.resolve(String(arg('out')));
  const work = path.resolve(repoRoot, String(arg('work', 'out/footage/work')));
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, path.basename(out).replace(/\.mp4$/, '.scenes.json')), JSON.stringify(parts.map((p) => ({ k: p.k, at: +p.at.toFixed(2), dur: +p.dur.toFixed(2), label: p.label, take: p.seg.take, from: p.seg.from, to: p.seg.to, speed: p.speed })), null, 1));

  /** The filter graph of consecutive parts `list` (the first one's own join is ignored): inputs, graph, length. */
  function graphOf(list) {
    const inputs = [];
    const chains = [];
    let nIn = 0;
    for (const p of list) {
      const s = p.seg;
      const vOut = `[sv${p.k}]`;
      const aOut = `[sa${p.k}]`;
      if (p.title) {
        const vi = nIn++;
        const ai = nIn++;
        inputs.push('-f', 'lavfi', '-t', (p.dur + 0.5).toFixed(3), '-i', `color=c=black:s=${OUT_W}x${OUT_H}:r=60`);
        inputs.push('-f', 'lavfi', '-t', (p.dur + 0.5).toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
        const lines = p.title;
        const sizes = lines.map((_, i) => (i === 0 ? Math.round(OUT_H * 0.075) : Math.round(OUT_H * 0.03)));
        const gap = Math.round(OUT_H * 0.03);
        const heights = sizes.reduce((a, h) => a + h, 0) + gap * (lines.length - 1);
        let y = Math.round((OUT_H - heights) / 2);
        const dt = lines.map((line, i) => {
          const f = `drawtext=fontfile='${TITLE_FONT}':text='${escText(line)}':fontsize=${sizes[i]}:fontcolor=${i === 0 ? 'white' : '0xC8CCD2'}:x=(w-text_w)/2:y=${y}`;
          y += sizes[i] + gap;
          return f;
        });
        chains.push(`[${vi}:v]${dt.join(',')},format=yuv420p,trim=end_frame=${p.frames},setpts=PTS-STARTPTS,settb=1/60${vOut}`);
        chains.push(`[${ai}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end=${p.dur.toFixed(4)},asetpts=PTS-STARTPTS${aOut}`);
        continue;
      }
      const atempo = [];
      let r = p.speed;
      while (r > 2.0001) {
        atempo.push('atempo=2');
        r /= 2;
      }
      if (Math.abs(r - 1) > 1e-6) atempo.push(`atempo=${r.toFixed(6)}`);
      const first = nIn;
      p.pieces.forEach((pc, i) => {
        const extra = i === p.pieces.length - 1 ? 0.5 : 0;
        inputs.push('-threads', '4', '-ss', pc.a.toFixed(3), '-t', (pc.b - pc.a + extra).toFixed(3), '-i', pc.file);
        nIn++;
      });
      let head;
      if (p.pieces.length === 1) head = `[${first}:v]null[cv${p.k}];[${first}:a]anull[ca${p.k}]`;
      else {
        // Exact piece lengths, then join: the overlap of the two files makes this a seamless cut.
        const trims = p.pieces.map((pc, i) =>
          i === p.pieces.length - 1
            ? `[${first + i}:v]setpts=PTS-STARTPTS[pv${p.k}_${i}];[${first + i}:a]asetpts=PTS-STARTPTS[pa${p.k}_${i}]`
            : `[${first + i}:v]trim=duration=${(pc.b - pc.a).toFixed(4)},setpts=PTS-STARTPTS[pv${p.k}_${i}];[${first + i}:a]atrim=duration=${(pc.b - pc.a).toFixed(4)},asetpts=PTS-STARTPTS[pa${p.k}_${i}]`,
        );
        head = `${trims.join(';')};${p.pieces.map((_, i) => `[pv${p.k}_${i}][pa${p.k}_${i}]`).join('')}concat=n=${p.pieces.length}:v=1:a=1[cv${p.k}][ca${p.k}]`;
      }
      const src = p.pieces[0].src;
      const scale = src.width !== OUT_W || src.height !== OUT_H ? [`scale=${OUT_W}:${OUT_H}:flags=lanczos`] : [];
      const vf = [`setpts=(PTS-STARTPTS)/${p.speed}`, 'fps=60', `trim=end_frame=${p.frames}`, 'setpts=PTS-STARTPTS', ...scale, ...(s.vf ? [s.vf] : []), 'format=yuv420p', 'settb=1/60'].join(',');
      const af = ['asetpts=PTS-STARTPTS', 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'aresample=48000', ...atempo, ...(s.gain ? [`volume=${s.gain}`] : []), `apad=whole_dur=${p.dur.toFixed(4)}`, `atrim=end=${p.dur.toFixed(4)}`].join(',');
      chains.push(`${head};[cv${p.k}]${vf}${vOut};[ca${p.k}]${af}${aOut}`);
    }
    // The chain. Output length after joining k: L_k = L_{k-1} + d_k - D (D = 0 for a cut).
    const fv = [];
    const fa = [];
    let vPrev = `[sv${list[0].k}]`;
    let aPrev = `[sa${list[0].k}]`;
    let L = list[0].dur;
    for (let j = 1; j < list.length; j++) {
      const p = list[j];
      const vOut = `[v${p.k}]`;
      const aOut = `[a${p.k}]`;
      if (p.join === 'cut') {
        // (concat hands out a microsecond timebase; xfade wants both inputs on the same one)
        fv.push(`${vPrev}[sv${p.k}]concat=n=2:v=1:a=0,settb=1/60${vOut}`);
        fa.push(`${aPrev}[sa${p.k}]concat=n=2:v=0:a=1${aOut}`);
        L += p.dur;
      } else {
        const Dj = joinD(p.join);
        fv.push(`${vPrev}[sv${p.k}]xfade=transition=${p.join}:duration=${Dj}:offset=${(L - Dj).toFixed(4)}${vOut}`);
        fa.push(`${aPrev}[sa${p.k}]acrossfade=d=${Dj}:c1=tri:c2=tri${aOut}`);
        L += p.dur - Dj;
      }
      vPrev = vOut;
      aPrev = aOut;
    }
    fv.push(`${vPrev}format=yuv420p[vout]`);
    fa.push(`${aPrev}anull[aout]`);
    return { inputs, graph: [...chains, ...fv, ...fa].join(';\n'), length: L, nIn };
  }

  // Chunks of consecutive segments, split only where the join is a hard cut (so the chunks simply follow one
  // another), each at most CHUNK segments when a cut allows it: a graph of every input at once decodes ahead on
  // all of them and ran out of memory (42 GB for 67 inputs). Intermediates: x264 CRF 12, PCM, in Matroska.
  const CHUNK = Number(arg('chunk', 7));
  const chunks = [];
  let cur = [];
  for (const p of parts) {
    if (cur.length >= CHUNK && p.join === 'cut') {
      chunks.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) chunks.push(cur);
  const files = [];
  let total2 = 0;
  chunks.forEach((list, c) => {
    const g = graphOf(list);
    total2 += g.length;
    const file = path.join(work, `chunk-${String(c).padStart(2, '0')}.mkv`);
    files.push(file);
    const key = JSON.stringify(list.map((p) => [p.seg, p.join]));
    const keyFile = `${file}.key`;
    if (!arg('force', false) && fs.existsSync(file) && fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8') === key) {
      console.log(`chunk ${c}: segments ${list[0].k}-${list[list.length - 1].k} (kept)`);
      return;
    }
    const graphFile = path.join(work, `graph-${String(c).padStart(2, '0')}.txt`);
    fs.writeFileSync(graphFile, g.graph);
    console.log(`chunk ${c}: segments ${list[0].k}-${list[list.length - 1].k}, ${g.nIn} inputs, ${g.length.toFixed(2)} s`);
    run(FFMPEG, ['-v', 'error', '-stats', '-y', ...g.inputs, '-/filter_complex', graphFile, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', '60', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', file]);
    fs.writeFileSync(keyFile, key);
  });
  if (arg('pass1', false)) process.exit(0);

  // The final encode: the chunks one after another (concat demuxer, read in turn), fade in and out, H.264 + AAC.
  const listFile = path.join(work, 'chunks.txt');
  fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n') + '\n');
  const L = total2;
  const fadeOut = Math.max(0, L - 2.5);
  console.log(`final: ${chunks.length} chunks, ${L.toFixed(1)} s`);
  const crf = String(arg('crf', 18));
  run(FFMPEG, [
    '-v', 'error', '-stats', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `fade=t=in:st=0:d=1.0,fade=t=out:st=${fadeOut.toFixed(3)}:d=2.5,format=yuv420p`,
    '-af', `afade=t=in:st=0:d=1.0,afade=t=out:st=${fadeOut.toFixed(3)}:d=2.5`,
    '-c:v', 'libx264', '-preset', String(arg('preset', 'slow')), '-crf', crf, '-x264-params', 'aq-mode=3',
    '-profile:v', 'high', '-level:v', '5.1', '-pix_fmt', 'yuv420p', '-r', '60', '-g', '120',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', out,
  ]);
  console.log(`wrote ${out}`);
} else {
  console.error('usage: node tools/footage/edit.mjs shots|contact|stills|render ...');
  process.exit(2);
}
