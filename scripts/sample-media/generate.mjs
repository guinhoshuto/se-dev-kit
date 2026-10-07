// Draws the code-generated sample media (no AI images): six mirrored 5x5 pixel avatars and the looping
// neon-road WebM. Run once by hand; the output is committed and append-only, so never overwrite a published
// file. Prints each file's manifest metadata. Usage: node scripts/sample-media/generate.mjs <out-dir>
import sharp from 'sharp';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('Usage: node scripts/sample-media/generate.mjs <out-dir>');
await mkdir(join(out, 'avatars'), {recursive: true});
await mkdir(join(out, 'clips'), {recursive: true});

const hex = (stats) => `#${stats.channels.slice(0, 3).map((channel) => Math.round(channel.mean).toString(16).padStart(2, '0')).join('')}`;
const describe = async (file, extra) => {
  const body = await readFile(join(out, file));
  return {file, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'), ...extra};
};
const results = [];

// Avatars: a 5x5 pattern mirrored around its middle column, like a default profile picture.
const AVATAR = 300;
const palettes = [
  ['#ff7ad9', '#7a5cff'], ['#ffd166', '#ef476f'], ['#06d6a0', '#118ab2'],
  ['#8ecae6', '#3a0ca3'], ['#f4a261', '#2a9d8f'], ['#cdb4db', '#ff006e']
];
const pixels = (index) => {
  const [cellColor, background] = palettes[index];
  let seed = 7 + index * 101;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cell = 44, pad = (AVATAR - cell * 5) / 2;
  let rects = '';
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (random() > 0.45) {
    for (const column of new Set([x, 4 - x])) rects += `<rect x="${pad + column * cell}" y="${pad + y * cell}" width="${cell}" height="${cell}" fill="${cellColor}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR}" height="${AVATAR}"><rect width="${AVATAR}" height="${AVATAR}" fill="${background}"/>${rects}</svg>`;
};
for (let index = 0; index < palettes.length; index++) {
  const file = `avatars/pixel-${index + 1}.png`;
  const image = sharp(Buffer.from(pixels(index))).removeAlpha();
  await image.clone().png({compressionLevel: 9}).toFile(join(out, file));
  results.push(await describe(file, {width: AVATAR, height: AVATAR, color: hex(await sharp(join(out, file)).stats())}));
}

// Clip: a synthwave road whose grid lines scroll toward the viewer; frame 120 equals frame 0, so it loops.
const W = 1280, H = 720, FPS = 30, FRAMES = 120;
const neon = (t) => {
  let lines = '';
  for (let k = 0; k < 12; k++) {
    const z = (k + t) / 12; const y = 380 + Math.pow(z, 2.2) * 340;
    lines += `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="#ff4fd8" stroke-opacity="${(0.25 + z * 0.75).toFixed(2)}" stroke-width="${(1 + z * 3).toFixed(1)}"/>`;
  }
  for (let k = -10; k <= 10; k++) lines += `<line x1="${W / 2 + k * 20}" y1="380" x2="${W / 2 + k * 260}" y2="${H}" stroke="#ff4fd8" stroke-opacity="0.55" stroke-width="2"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#120b2e"/><stop offset="1" stop-color="#4b1b6b"/></linearGradient>
  <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd166"/><stop offset="1" stop-color="#ff4f8b"/></linearGradient></defs>
  <rect width="${W}" height="380" fill="url(#sky)"/><rect y="380" width="${W}" height="${H - 380}" fill="#0b0620"/>
  <circle cx="${W / 2}" cy="330" r="150" fill="url(#sun)"/>
  ${[0, 1, 2, 3].map((k) => `<rect x="0" y="${300 + k * 18}" width="${W}" height="${4 + k * 2}" fill="#4b1b6b"/>`).join('')}
  <rect y="372" width="${W}" height="8" fill="#0b0620"/>${lines}</svg>`;
};
const clip = 'clips/neon-road.webm';
const ffmpeg = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
  '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '36', '-row-mt', '1', '-pix_fmt', 'yuv420p',
  '-vf', 'scale=out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-an', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', join(out, clip)], {stdio: ['pipe', 'inherit', 'inherit']});
for (let frame = 0; frame < FRAMES; frame++) {
  const raw = await sharp(Buffer.from(neon(frame / FRAMES))).removeAlpha().raw().toBuffer();
  if (!ffmpeg.stdin.write(raw)) await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
}
ffmpeg.stdin.end();
await new Promise((resolve, reject) => ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))));
results.push(await describe(clip, {width: W, height: H, durationMs: (FRAMES / FPS) * 1000, color: hex(await sharp(Buffer.from(neon(0))).removeAlpha().stats())}));
console.log(JSON.stringify(results, null, 2));
