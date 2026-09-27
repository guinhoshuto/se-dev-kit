#!/usr/bin/env node
/** Explicit, bounded hosted API verification. Creates synthetic data; never deletes remote data. */
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstat, mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {inflateSync} from 'node:zlib';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_ROOT = resolve(ROOT, '.studio-data');
const JOB_LIMIT_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const JOBS = [{kind: 'test', selection: 'all'}, {kind: 'render', selection: 'verification-image'}, {kind: 'render', selection: 'verification-video'}];
// --fonts: the same revision rendered twice (a recipe, then its scene), then a smoke test.
const FONT_JOBS = [{kind: 'render', selection: 'fonts-image'}, {kind: 'render', selection: 'scene:fonts'}, {kind: 'test', selection: 'all'}];
const FONT_MISSING_FAMILY = 'Studio Verification Missing Family';
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const pause = ms => new Promise(done => setTimeout(done, ms));
const check = (condition, message) => {if (!condition) throw new Error(message);};

export function parseOptions(args) {
  const options = {allowHosted: false, pollMs: 5000, ffprobe: process.env.STUDIO_FFPROBE_PATH || 'ffprobe'};
  const values = new Map([['--base-url', 'baseUrl'], ['--resume', 'resume'], ['--ffprobe', 'ffprobe']]);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--allow-hosted') options.allowHosted = true;
    else if (arg === '--fonts') options.fonts = true;
    else if (values.has(arg)) {
      check(args[index + 1] && !args[index + 1].startsWith('--'), `${arg} requires a value.`);
      const key = values.get(arg);
      check(!seen.has(arg), `${arg} may only appear once.`);
      seen.add(arg);
      options[key] = args[++index];
    } else throw new Error('Unknown argument. Run with --help for supported options.');
  }
  if (options.help) return options;
  check(options.baseUrl, '--base-url is required, including when resuming.');
  let url;
  try {url = new URL(options.baseUrl);} catch {throw new Error('--base-url must be an absolute HTTP(S) origin.');}
  check(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', '--base-url must contain only an origin, without credentials, path, query, or fragment.');
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  check(['http:', 'https:'].includes(url.protocol), '--base-url must use HTTP(S).');
  check(loopback || (url.protocol === 'https:' && options.allowHosted), 'Hosted verification requires HTTPS and explicit --allow-hosted.');
  options.origin = url.origin;
  return options;
}

/** Small, fully synthetic fixture: 320×240, one image variant, ten video frames, and built-in sample media. */
export function verificationSnapshot() {
  return {
    schemaVersion: 1, name: 'Hosted verification — synthetic demo',
    widget: {
      viewport: {width: 320, height: 240}, ready: {selector: '#widget', timeoutMs: 10000},
      html: '<main id="widget"><h1 id="title"></h1><p id="message">Synthetic preview</p><div id="gallery"></div><small>WIDGET STUDIO · SYNTHETIC DATA</small></main>',
      css: '*{box-sizing:border-box}body{margin:0;font:16px Arial,sans-serif;background:#20202a;color:#f6f4ff}main{padding:28px}h1{font-size:24px;color:var(--accent,#ac96ff)}p{line-height:1.5}#gallery img{width:48px;height:27px;margin-right:6px}small{font-size:10px;opacity:.6}',
      js: "const gallery=list=>(Array.isArray(list)?list:[]).map(value=>{const url=new URL(value,window.location.href);const image=document.createElement('img');image.addEventListener('load',()=>{image.dataset.width=String(image.naturalWidth);});image.src=['http:','https:','data:'].includes(url.protocol)?url.href:'';return image;});const apply=({detail})=>{document.querySelector('#title').textContent=detail.fieldData.title;document.documentElement.style.setProperty('--accent',detail.fieldData.accent);document.querySelector('#gallery').replaceChildren(...gallery(detail.fieldData.gallery));};window.addEventListener('onWidgetLoad',apply);window.addEventListener('onWidgetUpdate',apply);window.addEventListener('onEventReceived',({detail})=>{if(detail.listener==='message')document.querySelector('#message').textContent=detail.event.data.text;});",
      fields: {title: {type: 'text', label: 'Title', value: 'Synthetic demo'}, accent: {type: 'colorpicker', label: 'Accent', value: '#ac96ff'}, gallery: {type: 'image-input', label: 'Gallery', multiple: true, value: []}}
    },
    channel: {username: 'synthetic_studio_viewer'},
    themes: [{schemaVersion: 1, id: 'violet', name: 'Violet', fieldData: {accent: '#ac96ff'}}],
    fixtures: [{schemaVersion: 1, id: 'message', name: 'Synthetic message', events: [{atMs: 100, listener: 'message', event: {data: {displayName: 'Synthetic viewer', text: 'Hosted rendering is ready.'}}}]}],
    scenes: [{schemaVersion: 1, id: 'demo', name: 'Synthetic demo', theme: 'violet', fixture: 'message', viewport: {width: 320, height: 240}, output: {width: 320, height: 240, format: 'png'}, captureAtMs: 200, fieldData: {gallery: ['sws-sample:gallery/neon-city.jpg', 'sws-sample:gallery/pixel-forest.jpg']}, background: {id: 'aurora', image: 'sws-sample:backdrops/sunset-mesh.jpg', color: '#a44085'}}],
    scenarios: [{schemaVersion: 1, id: 'verification-smoke', name: 'Synthetic smoke', scene: 'demo', steps: [{action: 'assert', selector: '#widget', visible: true}, {action: 'assert', selector: '#gallery img[data-width="1600"]', count: 2}, {action: 'updateFields', fieldData: {title: 'Synthetic field update'}}, {action: 'assert', selector: '#title', text: 'Synthetic field update'}, {action: 'dispatch', listener: 'message', event: {data: {text: 'Synthetic event verified'}}}, {action: 'assert', selector: '#message', text: 'Synthetic event verified'}]}],
    recipes: [
      {schemaVersion: 1, id: 'verification-image', name: 'Verification PNG', scenes: ['demo'], outputs: {screenshots: true}, limit: 1},
      {schemaVersion: 1, id: 'verification-video', name: 'Verification MP4', scenes: ['demo'], outputs: {screenshots: false, video: {enabled: true, durationMs: 1000, fps: 10, format: 'mp4', codec: 'h264', audio: 'none'}}, limit: 1}
    ],
    assets: []
  };
}

/**
 * Synthetic Google Fonts project (fonts plan, stage 5): a static <link>, an @import, a setFont() that
 * re-points a link at load, and a JS link to a family Google does not have. Nothing is vendored.
 */
export function fontsVerificationSnapshot() {
  return {
    schemaVersion: 1, name: 'Hosted verification — Google Fonts',
    widget: {
      viewport: {width: 320, height: 240}, ready: {selector: '#widget', timeoutMs: 10000},
      html: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap"><link id="runtime-font" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto&display=swap"><main id="widget"><h1 id="title">Studio fonts</h1><p class="imported">Imported Inter</p><p id="runtime">Runtime Archivo</p><p class="missing">Missing family</p></main>',
      css: "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap');*{box-sizing:border-box}body{margin:0;background:#20202a;color:#f6f4ff}main{padding:20px}h1{margin:0 0 12px;font:700 26px Roboto,sans-serif}.imported{font:400 18px Inter,sans-serif}#runtime{font-size:18px}.missing{font:400 18px '" + FONT_MISSING_FAMILY + "',sans-serif}",
      js: "function setFont(name){document.getElementById('runtime-font').href='https://fonts.googleapis.com/css2?family='+encodeURIComponent(name).replace(/%20/g,'+')+'&display=swap';document.getElementById('runtime').style.fontFamily=\"'\"+name+\"',sans-serif\";}window.addEventListener('onWidgetLoad',({detail})=>{setFont(detail.fieldData.font);const link=document.createElement('link');link.rel='stylesheet';link.href='https://fonts.googleapis.com/css2?family=" + FONT_MISSING_FAMILY.replace(/ /g, '+') + "';document.head.append(link);});window.addEventListener('onWidgetUpdate',({detail})=>setFont(detail.fieldData.font));",
      fields: {font: {type: 'googleFont', label: 'Font', value: 'Archivo'}}
    },
    channel: {username: 'synthetic_studio_viewer'},
    themes: [], fixtures: [],
    scenes: [{schemaVersion: 1, id: 'fonts', name: 'Google Fonts', viewport: {width: 320, height: 240}, output: {width: 320, height: 240, format: 'png'}, captureAtMs: 100, background: {id: 'plain', color: '#20202a'}}],
    scenarios: [],
    recipes: [{schemaVersion: 1, id: 'fonts-image', name: 'Google Fonts PNG', scenes: ['fonts'], outputs: {screenshots: true}, limit: 1}],
    assets: []
  };
}

/** Decodes an 8-bit RGB or RGBA, non-interlaced PNG into RGBA pixels (enough for the Studio's own screenshots). */
export function decodePng(bytes) {
  inspectPng(bytes, false);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), depth = bytes[24], type = bytes[25], interlace = bytes[28];
  check(depth === 8 && (type === 6 || type === 2) && interlace === 0, 'Only 8-bit RGB(A), non-interlaced PNGs can be compared.');
  const channels = type === 6 ? 4 : 3; const idat = [];
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset); const kind = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    if (kind === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)); const stride = width * channels; const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0; const up = previous[x]; const corner = x >= channels ? previous[x - channels] : 0;
      const p = left + up - corner; const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      const predictor = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter];
      check(predictor !== undefined, 'PNG uses an unknown filter.');
      line[x] = (line[x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) pixels[(y * width + x) * 4 + c] = c < channels ? line[x * channels + c] : 255;
    previous = line;
  }
  return {width, height, pixels};
}

/**
 * Share of pixels whose channels differ by more than `threshold`. Two renders in two Sandboxes may
 * rasterize slightly differently (CPU), so they are compared within a tolerance, not by SHA-256.
 */
export function pngDifference(left, right, threshold = 32) {
  const a = decodePng(left), b = decodePng(right);
  check(a.width === b.width && a.height === b.height, 'Compared PNGs have different dimensions.');
  let differing = 0;
  for (let index = 0; index < a.pixels.length; index += 4) {
    for (let c = 0; c < 4; c++) if (Math.abs(a.pixels[index + c] - b.pixels[index + c]) > threshold) { differing++; break; }
  }
  return differing / (a.width * a.height);
}

export function redact(value, secrets = []) {
  let result = String(value);
  for (const secret of secrets.filter(Boolean)) result = result.replaceAll(secret, '[REDACTED]');
  return result.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/#key=[^\s"'<>]+/gi, '#key=[REDACTED]')
    .replace(/(token|authorization|password|secret|signature|credential)(\s*[=:]\s*)[^\s,;}]+/gi, '$1$2[REDACTED]')
    .slice(0, 1500);
}

async function boundedBody(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  check(!Number.isFinite(declared) || declared <= limit, 'Response exceeds the allowed byte count.');
  check(response.body, 'Response body is missing.');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      length += value.byteLength;
      check(length <= limit, 'Response exceeds the allowed byte count.');
      chunks.push(Buffer.from(value));
    }
  } finally {await reader.cancel().catch(() => {});}
  return Buffer.concat(chunks);
}

export function inspectPng(bytes, requireSize = true) {
  check(bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && bytes.subarray(12, 16).toString() === 'IHDR', 'Artifact is not a PNG with an IHDR header.');
  const dimensions = {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
  if (requireSize) check(dimensions.width === 320 && dimensions.height === 240, 'PNG dimensions must be 320×240.');
  return dimensions;
}

async function probeVideo(executable, path) {
  let stdout;
  try {({stdout} = await exec(executable, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], {timeout: 30000, maxBuffer: 1024 * 1024}));}
  catch {throw new Error('ffprobe failed to inspect the downloaded MP4. No tools were downloaded.');}
  const data = JSON.parse(stdout); const streams = data.streams ?? [];
  const video = streams.filter(stream => stream.codec_type === 'video');
  check(video.length === 1 && video[0].codec_name === 'h264', 'MP4 must contain exactly one H.264 video stream.');
  check(video[0].width === 320 && video[0].height === 240, 'MP4 dimensions must be 320×240.');
  check(streams.every(stream => stream.codec_type !== 'audio'), 'MP4 must not contain an audio stream.');
  const duration = Number(data.format?.duration);
  check(duration >= 0.9 && duration <= 1.2, 'MP4 duration must be approximately one second.');
  return {codec: video[0].codec_name, width: video[0].width, height: video[0].height, durationSeconds: duration, audioStreams: 0};
}

async function privateRoot() {
  await mkdir(PRIVATE_ROOT, {recursive: true, mode: 0o700});
  const info = await lstat(PRIVATE_ROOT);
  check(info.isDirectory() && !info.isSymbolicLink(), '.studio-data must be a real directory.');
  return realpath(PRIVATE_ROOT);
}

async function readAccess(path, root, origin) {
  const full = resolve(path); const rel = relative(root, await realpath(full));
  check(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Resume access files must remain inside this repository\'s .studio-data directory.');
  const info = await lstat(full);
  check(info.isFile() && !info.isSymbolicLink() && info.size < 16384 && (info.mode & 0o077) === 0, 'Resume access must be a private, bounded regular file (mode 0600).');
  const value = JSON.parse(await readFile(full, 'utf8'));
  check(value.schemaVersion === 1 && value.origin === origin && ID.test(value.projectId) && ID.test(value.revisionId) && typeof value.token === 'string' && /^[a-zA-Z0-9_-]{24,256}$/.test(value.token), 'Resume access file has an invalid shape or different origin.');
  check(value.purpose === 'hosted-verification', 'Resume access must belong to this verification script.');
  return value;
}

export async function verify(options) {
  // Resolve media validation before spending a project or job reservation.
  try {await exec(options.ffprobe, ['-version'], {timeout: 10000, maxBuffer: 1024 * 1024});}
  catch {throw new Error('ffprobe is required for this complete verification. Provide an installed executable with --ffprobe; no downloads were attempted.');}
  const privateDirectory = await privateRoot();
  const output = await mkdtemp(resolve(privateDirectory, 'hosted-verification-'));
  const report = {schemaVersion: 1, origin: options.origin, startedAt: new Date().toISOString(), status: 'running', checks: [], jobs: [], limitations: ['API verification does not replace an interactive editor or real StreamElements/OBS check.']};
  const snapshot = options.fonts ? fontsVerificationSnapshot() : verificationSnapshot();
  const jobs = options.fonts ? FONT_JOBS : JOBS;
  if (options.fonts) report.mode = 'fonts';
  /** Font evidence per job selection: parsed manifest or test report, and the PNG bytes. */
  const fontEvidence = new Map();
  let access; let phase = 'preflight'; let requestDeadline = Infinity;
  const secrets = [process.env.STUDIO_CREATE_KEY];
  const addCheck = value => {if (!report.checks.includes(value)) report.checks.push(value);};
  const fetchSafe = async (url, init = {}, attempts = 1) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      check(Date.now() < requestDeadline, 'Job verification reached its ten-minute deadline.');
      try {
        const response = await fetch(url, {...init, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(30000, requestDeadline - Date.now())))});
        if ([502, 503, 504].includes(response.status) && attempt < attempts) {await response.body?.cancel(); await pause(Math.min(1000 * attempt, Math.max(0, requestDeadline - Date.now()))); continue;}
        return response;
      } catch {
        if (attempt === attempts) throw new Error('Request failed or timed out; no mutation was automatically retried. Resume to inspect previously accepted jobs.');
        await pause(Math.min(1000 * attempt, Math.max(0, requestDeadline - Date.now())));
      }
    }
  };
  const api = async (path, {method = 'GET', body, authorization = true, headers = {}} = {}) => {
    const url = new URL(path, options.origin);
    check(url.origin === options.origin && url.pathname.startsWith('/api/'), 'API target must stay on the explicitly supplied origin.');
    const response = await fetchSafe(url, {method, headers: {'Content-Type': 'application/json', ...(authorization && access ? {Authorization: `Bearer ${access.token}`} : {}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}, method === 'GET' ? 3 : 1);
    check(response.status < 300 || response.status >= 400, 'Unexpected API redirect was blocked.');
    const bytes = await boundedBody(response, MAX_RESPONSE_BYTES);
    let data;
    try {data = JSON.parse(bytes.toString('utf8'));} catch {throw new Error(`API returned non-JSON data (HTTP ${response.status}).`);}
    return {status: response.status, data};
  };
  const expect = (result, status, operation) => check(result.status === status, `${operation} returned HTTP ${result.status}; expected ${status}. ${redact(result.data?.error ?? '', secrets)}`);
  try {
    phase = 'sample media support';
    // Read-only and capability-free: an older deployment answers 404 here before any project is spent.
    const samples = await api('/api/v1/sample-media', {authorization: false}); expect(samples, 200, 'Sample media list');
    const served = new Map((samples.data?.items ?? []).map(item => [item?.reference, item?.sha256]));
    const localManifest = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../sample-media/manifest.json'), 'utf8'));
    for (const reference of new Set(JSON.stringify(snapshot).match(/sws-sample:[a-z0-9/.-]+/g) ?? [])) {
      check(served.get(reference) === localManifest.items.find(item => item.reference === reference)?.sha256, `Deployment does not serve ${reference} with the manifest hash.`);
    }
    addCheck('sample media list served with manifest hashes before project creation');
    phase = 'project creation or resume';
    if (options.resume) access = await readAccess(options.resume, privateDirectory, options.origin);
    else {
      const result = await api('/api/v1/projects', {method: 'POST', authorization: false, body: snapshot, headers: process.env.STUDIO_CREATE_KEY ? {'X-Studio-Key': process.env.STUDIO_CREATE_KEY} : {}});
      if (typeof result.data?.token === 'string') secrets.push(result.data.token);
      expect(result, 201, 'Project creation');
      check(ID.test(result.data.projectId) && typeof result.data.token === 'string', 'Project creation did not return a valid editing capability.');
      check(ID.test(result.data.revisionId), 'Project creation did not return a valid revision identifier.');
      access = {schemaVersion: 1, purpose: 'hosted-verification', origin: options.origin, projectId: result.data.projectId, revisionId: result.data.revisionId, token: result.data.token};
      await writeFile(resolve(output, 'access.private.json'), JSON.stringify(access), {flag: 'wx', mode: 0o600});
      check(result.data.status === 'ready', 'Synthetic revision was created but is not ready.');
      addCheck('synthetic project creation');
    }
    secrets.push(access.token); report.projectId = access.projectId;
    const projectPath = `/api/v1/projects/${access.projectId}`;
    const studioPath = `/api/studio/projects/${access.projectId}`;
    phase = 'project and preview checks';
    const current = await api(projectPath); expect(current, 200, 'Project reload');
    check(current.data.revision.status === 'ready' && current.data.revision.id === access.revisionId && current.data.revision.snapshot.name === snapshot.name, 'Resume project is not the unchanged, ready synthetic verification project.');
    report.revisionId = current.data.revision.id; addCheck('authorized project reload');
    expect(await api(projectPath, {authorization: false}), 403, 'Unauthorized project read'); addCheck('unauthorized project read rejected');
    expect(await api(projectPath, {method: 'PUT', headers: {'If-Match': '"verification-stale-revision"'}, body: current.data.revision.snapshot}), 409, 'Stale full replacement');
    const unchanged = await api(projectPath); expect(unchanged, 200, 'Reload after stale replacement');
    check(unchanged.data.revision.id === report.revisionId, 'Stale replacement changed the immutable revision.'); addCheck('stale full replacement rejected without revision change');
    if (!options.fonts) {
    const preview = await api(`${studioPath}/preview`, {method: 'POST', body: {sceneId: 'demo', fieldData: {title: 'Synthetic API preview'}}}); expect(preview, 200, 'Preview');
    const previewText = JSON.stringify(preview.data);
    check(!previewText.includes(access.token), 'Preview response exposed the editing capability.');
    check(typeof preview.data.html === 'string' && preview.data.html.includes('Content-Security-Policy') && preview.data.html.includes("connect-src 'none'") && preview.data.html.includes("frame-src 'none'"), 'Preview is missing its restrictive content policy.');
    check(preview.data.state?.fieldData?.title === 'Synthetic API preview' && typeof preview.data.nonce === 'string' && typeof preview.data.sessionId === 'string', 'Preview state or bridge values are missing.');
    check(preview.data.html.includes('sws-sample:gallery/neon-city.jpg') && /^data:image\/jpeg;base64,/.test(preview.data.backgroundImage ?? ''), 'Preview did not embed the deployed sample media.');
    addCheck('preview response, field overrides, embedded sample media, restrictive CSP, and capability isolation');
    }

    for (const requested of jobs) {
      phase = `${requested.kind} job: ${requested.selection}`;
      requestDeadline = Date.now() + JOB_LIMIT_MS;
      const listed = await api(`${studioPath}/jobs`); expect(listed, 200, 'Job listing');
      check(Array.isArray(listed.data) && listed.data.length <= 3, 'Verification project exceeds its three-job budget.');
      const matching = listed.data.filter(job => job.kind === requested.kind && job.selection === requested.selection);
      check(matching.length <= 1, 'More than one job exists for this verification selection.');
      let job = matching[0];
      if (!job) {
        check(listed.data.length < 3, 'Verification refuses to create more than three jobs.');
        const created = await api(`${studioPath}/jobs`, {method: 'POST', body: requested});
        if (created.data?.id && ID.test(created.data.id)) report.jobs.push({id: created.data.id, ...requested, status: created.data.status, artifacts: []});
        expect(created, 202, 'Job submission'); job = created.data;
      } else report.jobs.push({id: job.id, ...requested, status: job.status, artifacts: []});
      const jobReport = report.jobs.at(-1);
      check(jobReport && ID.test(job.id), 'Job response did not contain a valid identifier.');
      console.log(JSON.stringify({event: 'job', projectId: access.projectId, jobId: job.id, ...requested, status: job.status}));
      const deadline = Math.min(Date.now() + JOB_LIMIT_MS, Date.parse(job.createdAt) + JOB_LIMIT_MS);
      check(Number.isFinite(deadline), 'Job creation time is invalid.');
      if (!['completed', 'failed', 'cancelled'].includes(job.status)) requestDeadline = Math.min(requestDeadline, deadline);
      while (!['completed', 'failed', 'cancelled'].includes(job.status)) {
        check(Date.now() < deadline, 'Job polling reached its ten-minute deadline. Resume later to inspect the accepted job.');
        await pause(Math.min(options.pollMs, Math.max(0, deadline - Date.now())));
        const polled = await api(`${studioPath}/jobs`); expect(polled, 200, 'Job poll');
        job = polled.data.find(candidate => candidate.id === job.id);
        check(job, 'Accepted job disappeared from the project.'); jobReport.status = job.status;
      }
      check(job.status === 'completed', `Job ${job.id} ended with ${job.status}. ${redact(job.error ?? '', secrets)}`);
      check(job.revisionId === report.revisionId, 'Job did not pin the verified immutable revision.');
      check(Array.isArray(job.artifacts) && job.artifacts.length <= 256, 'Job artifact list is invalid.');
      for (const [index, artifact] of job.artifacts.entries()) {
        check(typeof artifact.id === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(artifact.id) && /^[a-f0-9]{64}$/.test(artifact.sha256) && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= MAX_ARTIFACT_BYTES, 'Artifact metadata is invalid.');
        let response = await fetchSafe(new URL(`${studioPath}/artifacts/${artifact.id}`, options.origin), {headers: {Authorization: `Bearer ${access.token}`} }, 3);
        if (response.status === 307) {
          const destination = new URL(response.headers.get('location') ?? '', options.origin);
          check(destination.protocol === 'https:' && !destination.username && !destination.password, 'Artifact download redirect must be HTTPS without URL credentials.');
          // A private Blob redirect is a separate request. Never forward the project bearer header.
          response = await fetchSafe(destination, {}, 3);
        }
        check(response.status === 200, `Artifact download returned HTTP ${response.status}.`);
        const bytes = await boundedBody(response, artifact.bytes);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        check(bytes.length === artifact.bytes && sha256 === artifact.sha256, 'Downloaded artifact length or SHA-256 does not match its metadata.');
        const name = basename(String(artifact.name)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'artifact';
        const file = `${job.id}-${index}-${name}`; const path = resolve(output, file);
        await writeFile(path, bytes, {flag: 'wx', mode: 0o600});
        const item = {id: artifact.id, file, contentType: artifact.contentType, bytes: bytes.length, sha256};
        if (artifact.contentType === 'image/png') item.png = inspectPng(bytes);
        if (options.fonts) {
          const evidence = fontEvidence.get(requested.selection) ?? {fontPass: job.fontPass ?? 1};
          if (artifact.contentType === 'image/png') evidence.png = bytes;
          if (artifact.contentType === 'application/json') evidence.json = JSON.parse(bytes.toString('utf8'));
          fontEvidence.set(requested.selection, evidence);
        }
        if (artifact.contentType === 'video/mp4') item.video = await probeVideo(options.ffprobe, path);
        jobReport.artifacts.push(item);
      }
      if (requested.selection === 'verification-image') check(jobReport.artifacts.filter(item => item.png).length === 1, 'Image job must produce one verified PNG.');
      if (requested.selection === 'verification-video') check(jobReport.artifacts.filter(item => item.video).length === 1, 'Video job must produce one verified MP4.');
      if (!options.fonts) addCheck(requested.kind === 'test' ? 'synthetic smoke job' : requested.selection === 'verification-image' ? 'PNG download, SHA-256, and 320×240 dimensions' : 'MP4 download, SHA-256, H.264, one-second duration, and no audio');
    }
    if (options.fonts) {
      phase = 'Google Fonts checks';
      const first = fontEvidence.get('fonts-image'); const second = fontEvidence.get('scene:fonts'); const smoke = fontEvidence.get('all');
      const served = first?.json?.fonts?.served ?? [];
      check(first?.json?.fonts?.mode === 'cache' && served.some(item => item.url?.startsWith('https://fonts.googleapis.com/') && item.status === 200 && /^[a-f0-9]{64}$/.test(item.sha256)) && served.some(item => /^https:\/\/fonts\.gstatic\.com\/.+\.woff2$/.test(item.url ?? '') && item.status === 200 && /^[a-f0-9]{64}$/.test(item.sha256)), 'The first render did not serve a Google stylesheet and a woff2 with SHA-256 from the cache.');
      report.fonts = {firstPasses: first.fontPass, secondPasses: second?.fontPass, servedDigest: first.json.fonts.servedDigest, userAgent: first.json.fonts.userAgent, served: served.length, issues: first.json.fonts.issues};
      addCheck(`first render completed in ${first.fontPass} pass(es), serving ${served.length} Google Fonts URLs from the cache`);
      check(second?.fontPass === 1, `The second render of the same revision needed a refill (${second?.fontPass} passes).`);
      check(second.json?.fonts?.servedDigest === first.json.fonts.servedDigest, 'The second render served different fonts (servedDigest differs).');
      const difference = pngDifference(first.png, second.png);
      report.fonts.pngDifference = difference; report.fonts.pngIdentical = createHash('sha256').update(first.png).digest('hex') === createHash('sha256').update(second.png).digest('hex');
      check(difference <= 0.01, `The second render's PNG differs from the first in ${(difference * 100).toFixed(2)}% of pixels.`);
      addCheck('second render: no refill, identical servedDigest, PNG within pixel tolerance (SHA-256 equality is informational)');
      const warnings = smoke?.json?.smoke?.warnings ?? [];
      check(smoke?.json?.smoke?.status === 'passed' && warnings.some(warning => warning.startsWith('upstream-4xx:') && warning.includes(FONT_MISSING_FAMILY)), 'The smoke test did not complete with an upstream-4xx warning for the missing family.');
      addCheck('smoke test completed with a warning for the family Google does not have');
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.phase = phase; report.error = redact(error instanceof Error ? error.message : 'Verification failed.', secrets);
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    console.log(JSON.stringify({status: report.status, output, projectId: report.projectId, report: resolve(output, 'report.json'), ...(report.error ? {phase: report.phase, error: report.error} : {})}));
  }
  return report;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/verify-hosted.mjs --base-url <origin> [--allow-hosted] [--fonts] [--resume <private-file>] [--ffprobe <executable>]

Creates one synthetic project and at most three jobs: smoke, 320×240 PNG, and one-second MP4.
With --fonts, a synthetic Google Fonts project instead: a render, a second render of the same
revision (no refill, same servedDigest, PNG within a pixel tolerance), and a smoke test whose
missing family completes with a warning.
Hosted origins require HTTPS and --allow-hosted. Loopback HTTP is allowed.
Uses STUDIO_CREATE_KEY from the environment only when creating a project.
Requires an already installed ffprobe (PATH, STUDIO_FFPROBE_PATH, or --ffprobe).
Evidence and a private mode-0600 resume access file are saved under ignored .studio-data/.
Use --resume .studio-data/hosted-verification-.../access.private.json to reuse the project and jobs.
Existing artifacts are never overwritten; resumed evidence goes into a new directory.
No remote data is deleted. Do not publish access.private.json. Project tokens and signed URLs are never logged.
This verifies the API and media pipeline, not interactive editor behavior or real StreamElements/OBS.`);
    return;
  }
  const report = await verify(options);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {console.error(redact(error instanceof Error ? error.message : 'Verification failed.', [process.env.STUDIO_CREATE_KEY])); process.exitCode = 1;});
}
