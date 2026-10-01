import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {LocalStore, readJson, writeJson} from '../../lib/storage';
import {materializeSnapshot, safeAssetPath, relocateProject} from '../../lib/materialize';
import {executionMode, hostedSandboxName, patchJob, remainingJobTime, runJob} from '../../lib/jobs';
import {buildAssetMap} from '../../src/server/assets';
import {prepareSnapshot} from '../../lib/importer';
import type {WidgetSnapshot, Revision, Job, ObjectStore} from '../../lib/model';
import {verificationSnapshot} from '../../scripts/verify-hosted.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {detectBrowser} from '../../src/capture/browser';
import {detectMediaTooling} from '../../src/capture/media';
import {lacksProprietaryCodecs} from '../../src/validation/doctor';

const execFileAsync = promisify(execFile);

function snapshot(): WidgetSnapshot {
  return {schemaVersion: 1, name: 'Worker test', widget: {html: '<div id="ready">Ready</div>', css: 'body{margin:0;background:#182632;color:white}#ready{padding:24px;font:20px sans-serif}', js: 'window.addEventListener("onWidgetLoad",()=>{document.querySelector("#ready").textContent="Loaded";});', fields: {}, viewport: {width: 160, height: 120}, ready: {selector: '#ready', timeoutMs: 5000}}, channel: {username: 'test'}, themes: [], fixtures: [], scenes: [{schemaVersion: 1, id: 'default', name: 'Default', output: {width: 160, height: 120}, captureAtMs: 0}], scenarios: [{schemaVersion: 1, id: 'loaded', name: 'Loaded', steps: [{action: 'assert', selector: '#ready', text: 'Loaded'}]}], recipes: [{schemaVersion: 1, id: 'image', name: 'Image', scenes: ['default'], outputs: {screenshots: true, thumbnails: {width: 80, height: 60}, contactSheet: true}}], assets: []};
}
function revision(): Revision {
  const value = snapshot();
  return {id: 'revision-test', projectId: 'project-test', createdAt: new Date().toISOString(), snapshot: value, status: 'ready', diagnostics: [], prepared: {snapshot: value, assets: [], warnings: []}};
}
function job(kind: Job['kind'], selection: string): Job {
  return {id: `job-${kind}`, projectId: 'project-test', revisionId: 'revision-test', kind, selection, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: 'Queued', artifacts: []};
}
test('materialized snapshots preserve source and verify asset integrity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-materialize-test-'));
  try {
    const store = new LocalStore(join(root, 'store'));
    const content = Buffer.from('example');
    await store.put('projects/test/assets/logo.svg', content);
    const prepared = {snapshot: snapshot(), warnings: [], assets: [{path: 'assets/logo.svg', key: 'projects/test/assets/logo.svg', contentType: 'image/svg+xml', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex')}]};
    const materialized = await materializeSnapshot(prepared, store, join(root, 'job'));
    assert.equal(await readFile(materialized.files.js, 'utf8'), prepared.snapshot.widget.js);
    assert.equal(materialized.configPath, undefined);
    assert.equal(await readFile(join(materialized.widgetRoot, 'assets/logo.svg'), 'utf8'), 'example');
    assert.equal(relocateProject(materialized, await realpath(join(root, 'job')), '/vercel/sandbox/job').widgetRoot, '/vercel/sandbox/job/widget');
    prepared.assets[0]!.sha256 = 'invalid';
    await assert.rejects(materializeSnapshot(prepared, store, join(root, 'bad-job')), /integrity/);
  } finally {await rm(root, {recursive: true, force: true});}
});
test('materialized snapshots carry widget.fieldUpdate into the engine config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-materialize-mode-'));
  try {
    const store = new LocalStore(join(root, 'store'));
    const value = snapshot();
    value.widget.fieldUpdate = 'event';
    assert.equal((await materializeSnapshot({snapshot: value, assets: [], warnings: []}, store, join(root, 'job'))).config.widget.fieldUpdate, 'event');
    assert.equal((await materializeSnapshot({snapshot: snapshot(), assets: [], warnings: []}, store, join(root, 'plain'))).config.widget.fieldUpdate, undefined);
  } finally {await rm(root, {recursive: true, force: true});}
});
test('materialized paths remain allowlisted through a temporary directory symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sws-materialize-alias-'));
  try {
    const actual = join(directory, 'actual');
    const alias = join(directory, 'alias');
    await mkdir(actual);
    await symlink(actual, alias, 'dir');
    const project = await materializeSnapshot(revision().prepared!, new LocalStore(join(directory, 'store')), alias);
    assert.equal(project.widgetRoot, await realpath(join(actual, 'widget')));
    const assets = await buildAssetMap(project);
    assert.deepEqual([...assets.keys()].sort(), ['fields.json', 'widget.css', 'widget.html', 'widget.js']);
  } finally {await rm(directory, {recursive: true, force: true});}
});
test('worker paths reject traversal, production replacement and hidden files', () => {
  for (const path of ['../outside', '/absolute.png', 'a/../b', 'widget.js', 'fields.json', 'catalog/a.json', 'a\\b', '.env', 'assets/*']) assert.throws(() => safeAssetPath(path));
  assert.equal(safeAssetPath('assets/image.png'), 'assets/image.png');
});
test('Vercel execution cannot silently fall back to a local subprocess', () => {
  const previous = {VERCEL: process.env.VERCEL, STUDIO_EXECUTION: process.env.STUDIO_EXECUTION, STUDIO_SANDBOX_SNAPSHOT_ID: process.env.STUDIO_SANDBOX_SNAPSHOT_ID};
  try {
    process.env.VERCEL = '1'; process.env.STUDIO_EXECUTION = 'local';
    assert.throws(executionMode, /require Sandbox/);
    process.env.STUDIO_EXECUTION = 'vercel'; delete process.env.STUDIO_SANDBOX_SNAPSHOT_ID;
    assert.throws(executionMode, /SNAPSHOT_ID is required/);
  } finally {for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;}
});
test('job updates retain completed results when a competing write wins the CAS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sws-job-cas-'));
  try {
    const store = new LocalStore(directory);
    const queued = job('render', 'image');
    const key = `projects/${queued.projectId}/jobs/${queued.id}.json`;
    await writeJson(store, key, queued);
    const completed: Job = {...queued, status: 'completed', progress: 'Media rendered and validated.', artifacts: [{id: 'result', name: 'image.png', key: 'result/image.png', contentType: 'image/png', bytes: 1, sha256: 'digest'}]};
    let interleaved = false;
    const racing: ObjectStore = {
      get: key => store.get(key), list: prefix => store.list(prefix), delete: key => store.delete(key),
      put: async (path, body, options) => {
        if (options?.ifMatch && !interleaved) {interleaved = true; await writeJson(store, key, completed, {overwrite: true});}
        return store.put(path, body, options);
      }
    };
    const result = await patchJob(racing, queued, {status: 'running', progress: 'Stale progress', workflowId: 'workflow-test'});
    assert.ok(interleaved);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.artifacts, completed.artifacts);
    assert.equal(result.progress, completed.progress);
    assert.equal(result.workflowId, 'workflow-test');
    await patchJob(store, queued, {status: 'failed', error: 'Stale workflow failure'});
    assert.deepEqual(await readJson(store, key), result);
  } finally {await rm(directory, {recursive: true, force: true});}
});
// The budget itself, hosted and local, is in limits.test.ts.
test('execution budgets refuse a job without a valid creation time', () => {
  assert.throws(() => remainingJobTime({createdAt: 'invalid'}, Date.now()), /execution budget/);
});
test('hosted workers have a deterministic provider-safe Sandbox name', () => {
  assert.equal(hostedSandboxName('job_ABC-123'), 'sws-job_ABC-123');
});
test('[browser] local worker runs the real browser and publishes verified screenshots and test reports', {timeout: 120_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-worker-test-'));
  try {
    const store = new LocalStore(join(root, 'store'));
    const rendered = await runJob(job('render', 'image'), revision(), store);
    assert.equal(rendered.status, 'completed', rendered.error);
    assert.equal(rendered.artifacts.filter(item => item.contentType === 'image/png').length, 3);
    for (const artifact of rendered.artifacts) {
      const value = await store.get(artifact.key);
      assert.ok(value);
      assert.equal(value.body.byteLength, artifact.bytes);
      assert.equal(createHash('sha256').update(value.body).digest('hex'), artifact.sha256);
    }
    const tested = await runJob(job('test', 'all'), revision(), store);
    assert.equal(tested.status, 'completed', tested.error);
    assert.equal(tested.artifacts[0]?.name, 'test-report.json');
    const report = await store.get(tested.artifacts[0]!.key);
    assert.equal(JSON.parse(Buffer.from(report!.body).toString()).scenarios[0].status, 'passed');
  } finally {await rm(root, {recursive: true, force: true});}
});

// Like se-windows: media values are normalized with new URL(value, location.href), so a relative path only
// loads when the runtime hands the widget an absolute URL.
const LOCATION_MEDIA_WIDGET = 'window.addEventListener("onWidgetLoad",({detail})=>{const list=Array.isArray(detail.fieldData.gallery)?detail.fieldData.gallery:[];document.querySelector("#gallery").replaceChildren(...list.map(value=>{const url=new URL(value,window.location.href);const image=document.createElement("img");image.addEventListener("load",()=>{image.dataset.width=String(image.naturalWidth);});image.src=["http:","https:"].includes(url.protocol)?url.href:"";return image;}));});';
const PNG_3X2 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGM4YVMBQQxwFgBbBAjpVFBn5QAAAABJRU5ErkJggg==';

test('[browser] a job loads the widget files a media array names, in a widget that resolves media against its location', {timeout: 120_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-worker-media-'));
  try {
    const store = new LocalStore(join(root, 'store'));
    const source: WidgetSnapshot = {
      schemaVersion: 1, name: 'Media arrays',
      widget: {html: '<main id="widget"><div id="gallery"></div></main>', css: 'body{margin:0}img{width:40px;height:30px}', js: LOCATION_MEDIA_WIDGET, fields: {gallery: {type: 'image-input', multiple: true, value: []}}, viewport: {width: 160, height: 120}, ready: {selector: '#widget', timeoutMs: 5000}},
      channel: {}, themes: [], fixtures: [],
      scenes: [{schemaVersion: 1, id: 'default', name: 'Default', output: {width: 160, height: 120}, fieldData: {gallery: ['./studio/media/a.png', 'studio/media/b.png']}, captureAtMs: 0}],
      scenarios: [{schemaVersion: 1, id: 'media', name: 'Media', steps: [{action: 'assert', selector: '#gallery img[data-width="3"]', count: 2}]}],
      recipes: [],
      assets: [{path: 'studio/media/a.png', content: PNG_3X2, encoding: 'base64'}, {path: 'studio/media/b.png', content: PNG_3X2, encoding: 'base64'}]
    };
    const prepared = await prepareSnapshot(source, store, 'projects/project-test/prepared/revision-media');
    const media: Revision = {id: 'revision-media', projectId: 'project-test', createdAt: new Date().toISOString(), snapshot: source, status: 'ready', diagnostics: [], prepared};
    const tested = await runJob({...job('test', 'all'), id: 'job-media', revisionId: 'revision-media'}, media, store);
    assert.equal(tested.status, 'completed', tested.error);
    const report = JSON.parse(Buffer.from((await store.get(tested.artifacts[0]!.key))!.body).toString());
    assert.equal(report.scenarios[0].status, 'passed', JSON.stringify(report.scenarios[0]));
  } finally {await rm(root, {recursive: true, force: true});}
});

// The hosted Sandbox's Chromium could not decode H.264 (SDK-20); the local Studio runs the system Chrome, which can.
test('[browser] a local job plays an H.264 MP4 the widget loads, in a test and in a render', {timeout: 120_000}, async t => {
  const [browser, tooling] = await Promise.all([detectBrowser(), detectMediaTooling({})]);
  if (!browser.executablePath || lacksProprietaryCodecs(browser)) {t.skip('Needs the system Google Chrome; a Chromium build has no H.264.'); return;}
  if (!tooling.ffmpegPath) {t.skip('FFmpeg is optional and is not installed.'); return;}
  const root = await mkdtemp(join(tmpdir(), 'sws-worker-mp4-'));
  try {
    const clip = join(root, 'clip.mp4');
    await execFileAsync(tooling.ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x16:d=1:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip]);
    const store = new LocalStore(join(root, 'store'));
    const source: WidgetSnapshot = {
      schemaVersion: 1, name: 'MP4 playback',
      widget: {html: '<video id="clip" muted playsinline src="media/clip.mp4"></video>', css: 'body{margin:0}', js: 'const clip=document.querySelector("#clip");const mark=()=>{clip.dataset.size=`${clip.videoWidth}x${clip.videoHeight}`;};if(clip.readyState>=2)mark();else clip.addEventListener("loadeddata",mark);', fields: {}, viewport: {width: 160, height: 120}, ready: {selector: '#clip', timeoutMs: 5000}},
      channel: {}, themes: [], fixtures: [],
      scenes: [{schemaVersion: 1, id: 'default', name: 'Default', output: {width: 160, height: 120}, captureAtMs: 0}],
      scenarios: [{schemaVersion: 1, id: 'plays', name: 'Plays', steps: [{action: 'assert', selector: '#clip[data-size="32x16"]', count: 1}]}],
      recipes: [{schemaVersion: 1, id: 'image', name: 'Image', scenes: ['default'], outputs: {screenshots: true}}],
      assets: [{path: 'media/clip.mp4', content: (await readFile(clip)).toString('base64'), encoding: 'base64'}]
    };
    const prepared = await prepareSnapshot(source, store, 'projects/project-test/prepared/revision-mp4');
    const revision: Revision = {id: 'revision-mp4', projectId: 'project-test', createdAt: new Date().toISOString(), snapshot: source, status: 'ready', diagnostics: [], prepared};
    const tested = await runJob({...job('test', 'all'), id: 'job-mp4-test', revisionId: 'revision-mp4'}, revision, store);
    assert.equal(tested.status, 'completed', tested.error);
    const report = JSON.parse(Buffer.from((await store.get(tested.artifacts[0]!.key))!.body).toString());
    assert.equal(report.scenarios[0].status, 'passed', JSON.stringify(report.scenarios[0]));
    // A render waits for every <video> to load and fails the job with "Video failed to load" when it cannot.
    const rendered = await runJob({...job('render', 'image'), id: 'job-mp4-render', revisionId: 'revision-mp4'}, revision, store);
    assert.equal(rendered.status, 'completed', rendered.error);
  } finally {await rm(root, {recursive: true, force: true});}
});

// verify-hosted checks production with this scenario: it must pass whichever way fields reach the widget.
test('[browser] the verify-hosted verification scenario passes with reload and with event', {timeout: 240_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-verification-modes-'));
  try {
    const store = new LocalStore(join(root, 'store'));
    for (const mode of ['reload', 'event'] as const) {
      const value = verificationSnapshot() as WidgetSnapshot;
      value.widget.fieldUpdate = mode;
      const prepared = await prepareSnapshot(value, store, `projects/project-test/prepared/verification-${mode}`);
      const verification: Revision = {id: `verification-${mode}`, projectId: 'project-test', createdAt: new Date().toISOString(), snapshot: value, status: 'ready', diagnostics: [], prepared};
      const tested = await runJob({...job('test', 'all'), id: `job-verification-${mode}`, revisionId: verification.id}, verification, store);
      assert.equal(tested.status, 'completed', tested.error);
      const report = JSON.parse(Buffer.from((await store.get(tested.artifacts[0]!.key))!.body).toString());
      assert.equal(report.scenarios[0].status, 'passed', `${mode}: ${JSON.stringify(report.scenarios[0])}`);
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

// Google Fonts in jobs (fonts plan, stage 5) -----------------------------------------------------
// A mocked Sandbox provider and a fake Google: nothing here reaches the network, and every hosted
// Sandbox must stay `deny-all`. The fake worker behaves like scripts/job-worker.mjs as far as the
// host can see: it reads lock-<pass>.json, reports the URLs outside it as needsFonts, or writes an
// artifact under output/pass-<pass>/ and result-<pass>.json.
import {FontMemory, lockForRevision} from '../../lib/fonts';
import {refillHostedJob, launchHostedJob, pollHostedJob, type SandboxHandle, type SandboxProvider} from '../../lib/jobs';
import {restoreGoogleFontReferences} from '../../lib/materialize';
import type {PublicLookup, PublicTransport} from '../../lib/importer';
import {GOOGLE_FONTS_UA} from '../../src/runtime/google-fonts-url';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';

const FONT_FIXTURES = join(process.cwd(), 'tests/fixtures/fonts');
const gfCss = (family: string) => `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}`;
const gfFile = (family: string) => `https://fonts.gstatic.com/s/${family.toLowerCase().replace(/ /g, '')}/v1/${family.toLowerCase().replace(/ /g, '-')}.woff2`;
const fakeLookup: PublicLookup = async () => [{address: '8.8.8.8', family: 4}];
/** Google as the fixture font knows it: two families, 400 for any other, 503 when `down`. */
async function fakeGoogle(options: {down?: boolean} = {}) {
  const faces: Record<string, Buffer> = {'Unbounded': await readFile(join(FONT_FIXTURES, 'Unbounded-400.woff2')), 'Studio Display': await readFile(join(FONT_FIXTURES, 'Unbounded-700.woff2'))};
  const calls: string[] = [];
  const transport: PublicTransport = async ({url}) => {
    calls.push(url.href);
    let status = 200; let body: Buffer; let type = 'font/woff2';
    const family = url.searchParams.getAll('family')[0]?.split(':')[0];
    if (options.down) { status = 503; body = Buffer.from('unavailable'); }
    else if (url.hostname === 'fonts.googleapis.com') {
      if (family && faces[family]) { type = 'text/css; charset=utf-8'; body = Buffer.from(`@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: 400;\n  src: url(${gfFile(family)}) format('woff2');\n}\n`); }
      else { status = 400; body = Buffer.from('<!doctype html><title>Error 400</title>'); type = 'text/html'; }
    } else {
      const face = Object.entries(faces).find(([name]) => gfFile(name) === url.href)?.[1];
      if (face) body = face; else { status = 404; body = Buffer.from('not found'); type = 'text/html'; }
    }
    return {status, headers: {'content-type': type, 'content-length': String(body.byteLength)}, body: (async function* () { yield body; })(), close() {}};
  };
  return {calls, fonts: {lookup: fakeLookup, transport, memory: new FontMemory()}};
}

const REMOTE = '/vercel/sandbox/studio/job';
type FakeWorker = (lockUrls: Set<string>, pass: number) => {needsFonts: string[]} | {artifact: Buffer};
/** Needs every URL in `urls`; with `oneAtATime`, reports only the first missing one per pass. */
const needing = (urls: string[], oneAtATime = false): FakeWorker => lockUrls => {
  const missing = urls.filter(url => !lockUrls.has(url));
  if (missing.length) return {needsFonts: oneAtATime ? missing.slice(0, 1) : missing};
  return {artifact: Buffer.from(`rendered with ${urls.join(' ')}`)};
};
class FakeSandbox implements SandboxHandle {
  files = new Map<string, Buffer>();
  commands: {cmdId: string; pass: number}[] = [];
  reads: string[] = [];
  created: unknown[] = [];
  stopped = 0;
  failNextRun?: number;
  constructor(public worker: FakeWorker) {}
  writes = 0;
  async writeFiles(files: {path: string; content: Uint8Array}[]) { this.writes++; for (const file of files) this.files.set(file.path, Buffer.from(file.content)); }
  async runCommand(params: {args: string[]}) {
    const pass = Number(params.args[2]);
    const cmdId = `cmd-${this.commands.length + 1}`;
    this.commands.push({cmdId, pass});
    this.execute(pass);
    if (this.failNextRun === pass) { this.failNextRun = undefined; throw new Error('Simulated crash after runCommand.'); }
    return {cmdId};
  }
  /** Like the pass lock: a second worker for a pass that already has a result writes nothing. */
  execute(pass: number) {
    const resultPath = `${REMOTE}/result-${pass}.json`;
    if (this.files.has(resultPath)) return;
    const lock = JSON.parse(this.files.get(`${REMOTE}/fonts/lock-${pass}.json`)?.toString() ?? '{"entries":[]}') as {entries: {url: string; sha256?: string}[]};
    // Only entries whose object was uploaded count, as the real resolver checks each object.
    const present = new Set(lock.entries.filter(entry => !entry.sha256 || this.files.has(`${REMOTE}/fonts/objects/${entry.sha256}`)).map(entry => entry.url));
    const outcome = this.worker(present, pass);
    if ('needsFonts' in outcome) { this.files.set(resultPath, Buffer.from(JSON.stringify({ok: false, artifacts: [], progress: '', pass, needsFonts: outcome.needsFonts}))); return; }
    this.files.set(`${REMOTE}/output/pass-${pass}/image/default.png`, outcome.artifact);
    this.files.set(resultPath, Buffer.from(JSON.stringify({ok: true, progress: 'Media rendered and validated.', pass, artifacts: [{name: 'image/default.png', bytes: outcome.artifact.byteLength, sha256: createHash('sha256').update(outcome.artifact).digest('hex')}]})));
  }
  async getCommand() { return {wait: async () => ({exitCode: 0, stderr: async () => ''})}; }
  async readFileToBuffer({path}: {path: string}) { this.reads.push(path); return this.files.get(path) ?? null; }
  async stop() { this.stopped++; }
}
function provider(sandbox: FakeSandbox): SandboxProvider {
  return {get: async () => sandbox, getOrCreate: async params => { sandbox.created.push(params); return sandbox; }};
}

async function hostedFixture(t: {after: (fn: () => Promise<void>) => void}) {
  const root = await mkdtemp(join(tmpdir(), 'sws-hosted-fonts-'));
  const previous = {STUDIO_EXECUTION: process.env.STUDIO_EXECUTION, STUDIO_SANDBOX_SNAPSHOT_ID: process.env.STUDIO_SANDBOX_SNAPSHOT_ID, VERCEL: process.env.VERCEL};
  process.env.STUDIO_EXECUTION = 'vercel'; process.env.STUDIO_SANDBOX_SNAPSHOT_ID = 'snapshot-test'; delete process.env.VERCEL;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, {recursive: true, force: true});
  });
  const store = new LocalStore(join(root, 'store'));
  const value = revision();
  value.prepared!.googleFonts = {epoch: 'v1', userAgent: GOOGLE_FONTS_UA, static: []};
  await writeJson(store, `projects/${value.projectId}/revisions/${value.id}.json`, value);
  let count = 0;
  const newJob = async (kind: Job['kind'] = 'render') => {
    const created: Job = {...job(kind, kind === 'render' ? 'image' : 'all'), id: `job-fonts-${++count}`};
    await writeJson(store, `projects/${created.projectId}/jobs/${created.id}.json`, created);
    return created;
  };
  const read = async (created: Job) => (await readJson<Job>(store, `projects/${created.projectId}/jobs/${created.id}.json`))!;
  return {store, revision: value, newJob, read};
}
/** Drives the workflow's loop directly: launch, then poll and refill until done (at most 8 rounds). */
async function driveWorkflow(created: Job, deps: Parameters<typeof pollHostedJob>[2]) {
  await launchHostedJob(created.projectId, created.id, deps);
  for (let round = 0; round < 8; round++) {
    const outcome = await pollHostedJob(created.projectId, created.id, deps);
    if (outcome.state === 'done') return;
    if (outcome.state === 'refill') await refillHostedJob(created.projectId, created.id, outcome.pass, deps);
  }
  throw new Error('The workflow did not finish in 8 rounds.');
}

test('hosted jobs keep the Sandbox deny-all and refill discovered fonts into pass 2 of the same Sandbox', async t => {
  const {store, newJob, read, revision: value} = await hostedFixture(t);
  const google = await fakeGoogle();
  // As in Chromium, the font file is requested only once its stylesheet loaded.
  const sandbox = new FakeSandbox(needing([gfCss('Unbounded'), gfFile('Unbounded')], true));
  const deps = {store, sandbox: provider(sandbox), fonts: google.fonts};
  const first = await newJob();
  await driveWorkflow(first, deps);
  const done = await read(first);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(sandbox.created.length, 1, 'one Sandbox for every pass');
  assert.equal((sandbox.created[0] as {networkPolicy: string}).networkPolicy, 'deny-all');
  assert.deepEqual(sandbox.commands.map(command => command.pass), [1, 2]);
  assert.equal(done.fontPass, 2);
  assert.equal(done.commandId, 'cmd-2');
  assert.deepEqual(JSON.parse(sandbox.files.get(`${REMOTE}/fonts/lock-1.json`)!.toString()).entries, [], 'nothing was known before pass 1');
  assert.deepEqual(JSON.parse(sandbox.files.get(`${REMOTE}/fonts/lock-2.json`)!.toString()).entries.map((entry: {url: string}) => entry.url), [gfCss('Unbounded'), gfFile('Unbounded')]);
  assert.deepEqual(google.calls, [gfCss('Unbounded'), gfFile('Unbounded')], 'the stylesheet, then its file eagerly, once each');
  // Published from output/pass-2, never from output/ or pass 1.
  assert.ok(sandbox.reads.includes(`${REMOTE}/output/pass-2/image/default.png`));
  const artifact = await store.get(done.artifacts[0]!.key);
  assert.equal(Buffer.from(artifact!.body).toString(), `rendered with ${gfCss('Unbounded')} ${gfFile('Unbounded')}`);
  assert.deepEqual((await lockForRevision(store, value.projectId, value.id)).map(entry => entry.url), [gfCss('Unbounded')], 'the revision lock records what the pass missed');

  // A second render of the same revision is served from the lock and the cache in one pass.
  const second = await newJob();
  const secondSandbox = new FakeSandbox(needing([gfCss('Unbounded'), gfFile('Unbounded')]));
  await driveWorkflow(second, {...deps, sandbox: provider(secondSandbox)});
  assert.equal((await read(second)).status, 'completed');
  assert.deepEqual(secondSandbox.commands.map(command => command.pass), [1]);
  assert.equal(google.calls.length, 2, 'the second render never calls upstream');
});

test('a refill retry after the next pass was recorded runs no duplicate command', async t => {
  const {store, newJob, read} = await hostedFixture(t);
  const google = await fakeGoogle();
  const sandbox = new FakeSandbox(needing([gfCss('Unbounded')]));
  const deps = {store, sandbox: provider(sandbox), fonts: google.fonts};
  const created = await newJob();
  await launchHostedJob(created.projectId, created.id, deps);
  assert.deepEqual(await pollHostedJob(created.projectId, created.id, deps), {state: 'refill', pass: 1});
  await refillHostedJob(created.projectId, created.id, 1, deps);
  const writes = sandbox.writes; const progress = (await read(created)).updatedAt;
  await refillHostedJob(created.projectId, created.id, 1, deps);
  assert.deepEqual(sandbox.commands.map(command => command.pass), [1, 2]);
  assert.equal(sandbox.writes, writes, 'the stale retry uploads nothing');
  assert.equal((await read(created)).updatedAt, progress, 'and writes nothing to the job');
  assert.equal((await read(created)).fontPass, 2);
  assert.deepEqual(await pollHostedJob(created.projectId, created.id, deps), {state: 'done'});
  assert.equal((await read(created)).status, 'completed');
});

test('a crash between runCommand and patchJob in a refill still ends completed', async t => {
  const {store, newJob, read} = await hostedFixture(t);
  const google = await fakeGoogle();
  const sandbox = new FakeSandbox(needing([gfCss('Unbounded')]));
  sandbox.failNextRun = 2;
  const deps = {store, sandbox: provider(sandbox), fonts: google.fonts};
  const created = await newJob();
  await launchHostedJob(created.projectId, created.id, deps);
  await pollHostedJob(created.projectId, created.id, deps);
  await assert.rejects(refillHostedJob(created.projectId, created.id, 1, deps), /Simulated crash/);
  assert.equal((await read(created)).fontPass ?? 1, 1, 'the new pass was not recorded');
  // The workflow retries the step: the second worker for pass 2 finds the first one's result.
  await refillHostedJob(created.projectId, created.id, 1, deps);
  const retried = await read(created);
  assert.equal(retried.fontPass, 2);
  assert.equal(retried.commandId, 'cmd-3', 'the retry records its own command, with the higher pass');
  assert.deepEqual(await pollHostedJob(created.projectId, created.id, deps), {state: 'done'});
  assert.equal((await read(created)).status, 'completed');
  assert.equal(google.calls.length, 2, 'the retry resolved from the lock and the cache');
});

test('discovery stops after four passes with FONT_DISCOVERY_LIMIT, and when job time runs short', async t => {
  const {store, newJob, read} = await hostedFixture(t);
  const google = await fakeGoogle();
  const families = ['Unbounded', 'Studio Display', 'Nope One', 'Nope Two', 'Nope Three'];
  const sandbox = new FakeSandbox(needing(families.map(gfCss), true));
  const deps = {store, sandbox: provider(sandbox), fonts: google.fonts};
  const created = await newJob();
  await launchHostedJob(created.projectId, created.id, deps);
  let limit: unknown;
  for (let round = 0; round < 8 && !limit; round++) {
    const outcome = await pollHostedJob(created.projectId, created.id, deps);
    assert.equal(outcome.state, 'refill');
    if (outcome.state !== 'refill') break;
    await refillHostedJob(created.projectId, created.id, outcome.pass, deps).catch(error => { limit = error; });
  }
  assert.match(String(limit), /^Error: FONT_DISCOVERY_LIMIT: after 4 passes .*Nope\+Two/);
  assert.deepEqual(sandbox.commands.map(command => command.pass), [1, 2, 3, 4]);
  assert.equal((await read(created)).fontPass, 4);

  const late = await newJob();
  const lateSandbox = new FakeSandbox(needing([gfCss('Nope Four')]));
  const lateDeps = {...deps, sandbox: provider(lateSandbox)};
  await launchHostedJob(late.projectId, late.id, lateDeps);
  await writeJson(store, `projects/${late.projectId}/jobs/${late.id}.json`, {...await read(late), createdAt: new Date(Date.now() - 9.5 * 60_000).toISOString()}, {overwrite: true});
  await assert.rejects(refillHostedJob(late.projectId, late.id, 1, lateDeps), /^Error: FONT_DISCOVERY_LIMIT: not enough job time is left for font pass 2/);
  assert.deepEqual(lateSandbox.commands.map(command => command.pass), [1]);
});

test('a family Google refuses completes in two passes, and a second render never calls upstream', async t => {
  const {store, newJob, read} = await hostedFixture(t);
  const google = await fakeGoogle();
  const refused = gfCss('Nope Family');
  const deps = {store, sandbox: provider(new FakeSandbox(needing([refused]))), fonts: google.fonts};
  const first = await newJob();
  await driveWorkflow(first, deps);
  assert.equal((await read(first)).status, 'completed');
  assert.equal((await read(first)).fontPass, 2);
  assert.deepEqual(google.calls, [refused]);
  const secondSandbox = new FakeSandbox(needing([refused]));
  const second = await newJob();
  await driveWorkflow(second, {...deps, sandbox: provider(secondSandbox)});
  assert.equal((await read(second)).status, 'completed');
  assert.deepEqual(JSON.parse(secondSandbox.files.get(`${REMOTE}/fonts/lock-1.json`)!.toString()).entries, [{url: refused, status: 400}]);
  assert.equal(google.calls.length, 1, 'the 4xx is replayed from the lock');
});

test('Google down for an uncached font fails the refill with FONT_UNAVAILABLE naming family, URL and reason', async t => {
  const {store, newJob} = await hostedFixture(t);
  const google = await fakeGoogle({down: true});
  const deps = {store, sandbox: provider(new FakeSandbox(needing([gfCss('Unbounded')]))), fonts: google.fonts};
  const created = await newJob();
  await launchHostedJob(created.projectId, created.id, deps);
  await pollHostedJob(created.projectId, created.id, deps);
  await assert.rejects(refillHostedJob(created.projectId, created.id, 1, deps), /^Error: FONT_UNAVAILABLE: Google Fonts could not be loaded: "Unbounded" \(https:\/\/fonts\.googleapis\.com\/css2\?family=Unbounded\): upstream\./);
});

test('needsFonts from the Sandbox is canonicalized again: other hosts and spellings never reach upstream', async t => {
  const {store, newJob} = await hostedFixture(t);
  const google = await fakeGoogle();
  const sandbox = new FakeSandbox(() => ({needsFonts: ['https://evil.example/css2?family=Unbounded', 'http://fonts.googleapis.com/css2?family=Unbounded&text=abc', 'http://fonts.googleapis.com/css2?family=Unbounded', 'not a url', 42 as unknown as string]}));
  const deps = {store, sandbox: provider(sandbox), fonts: google.fonts};
  const created = await newJob();
  await launchHostedJob(created.projectId, created.id, deps);
  await pollHostedJob(created.projectId, created.id, deps);
  await refillHostedJob(created.projectId, created.id, 1, deps);
  assert.deepEqual(google.calls, [gfCss('Unbounded'), gfFile('Unbounded')]);
});

test('patchJob replaces the recorded command only together with a higher font pass', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sws-job-pass-'));
  try {
    const store = new LocalStore(directory);
    const created = {...job('render', 'image'), commandId: 'cmd-1'};
    await writeJson(store, `projects/${created.projectId}/jobs/${created.id}.json`, created);
    assert.equal((await patchJob(store, created, {commandId: 'cmd-late'})).commandId, 'cmd-1');
    assert.equal((await patchJob(store, created, {commandId: 'cmd-late', fontPass: 1})).commandId, 'cmd-1');
    const second = await patchJob(store, created, {commandId: 'cmd-2', fontPass: 2});
    assert.deepEqual([second.commandId, second.fontPass], ['cmd-2', 2]);
    const stale = await patchJob(store, created, {commandId: 'cmd-old', fontPass: 2, progress: 'late'});
    assert.deepEqual([stale.commandId, stale.fontPass], ['cmd-2', 2]);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('jobs point Google Fonts captured into _import/ back at their Google URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-import-migration-'));
  try {
    const store = new LocalStore(join(root, 'store'));
    const css = Buffer.from("@font-face{font-family:'Old';src:url(ab12.ttf)}");
    const local = Buffer.from("@import url(../_import/0123456789abcdef01234567.css);");
    const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
    await store.put('p/css', css); await store.put('p/local', local);
    const value = snapshot();
    value.widget.html = '<link rel="stylesheet" href="_import/0123456789abcdef01234567.css"><div id="ready">Ready</div>';
    value.widget.css = '@import url(_import/0123456789abcdef01234567.css);';
    const source = 'https://fonts.googleapis.com/css2?family=Old&display=swap';
    const project = await materializeSnapshot({snapshot: value, warnings: [], assets: [
      {path: '_import/0123456789abcdef01234567.css', key: 'p/css', contentType: 'text/css', bytes: css.length, sha256: digest(css), sourceUrl: source},
      {path: 'styles/local.css', key: 'p/local', contentType: 'text/css', bytes: local.length, sha256: digest(local)}
    ]}, store, join(root, 'job'));
    assert.equal(await readFile(project.files.html, 'utf8'), `<link rel="stylesheet" href="${source}"><div id="ready">Ready</div>`);
    assert.equal(await readFile(project.files.css, 'utf8'), `@import url(${source});`);
    assert.equal(await readFile(join(project.widgetRoot, 'styles/local.css'), 'utf8'), `@import url(${source});`);
    assert.equal(restoreGoogleFontReferences('_import/0123456789abcdef01234567.cssx', []), '_import/0123456789abcdef01234567.cssx');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('a second worker for the same pass waits for the first one\'s result instead of exiting without one', {timeout: 30_000}, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sws-pass-lock-')));
  try {
    await writeFile(join(directory, 'input.json'), JSON.stringify({job: job('render', 'image'), project: {outputRoot: join(directory, 'output')}, sampleMedia: {}}));
    await writeFile(join(directory, 'pass-1.lock'), '1');
    const child = spawn(process.execPath, [join(process.cwd(), 'scripts/job-worker.mjs'), join(directory, 'input.json'), '1'], {stdio: 'ignore'});
    const exited = new Promise<number | null>(done => child.once('close', done));
    let early = false;
    const timer = setTimeout(() => { early = child.exitCode === null; }, 1500);
    await new Promise(done => setTimeout(done, 2000));
    clearTimeout(timer);
    assert.ok(early, 'the second worker is still waiting');
    const first = JSON.stringify({ok: true, artifacts: [], progress: 'first worker', pass: 1});
    await writeFile(join(directory, 'result-1.json'), first);
    assert.equal(await exited, 0);
    assert.equal(await readFile(join(directory, 'result-1.json'), 'utf8'), first, 'the first result stays');
  } finally {await rm(directory, {recursive: true, force: true});}
});

function googleFontRevision(id: string): Revision {
  const value = snapshot();
  value.name = 'Google Fonts worker test';
  value.widget = {
    html: `<link id="gf" rel="stylesheet" href="${gfCss('Unbounded')}"><h1 id="t">Studio</h1>`,
    css: "body{margin:0;background:#182632;color:white}h1{margin:0;padding:12px;font:400 28px/1 'Unbounded',monospace}",
    js: `function setFont(name){document.getElementById("gf").href="https://fonts.googleapis.com/css2?family="+name.replace(/ /g,"+");document.getElementById("t").style.fontFamily="'"+name+"',monospace";}
window.addEventListener("onWidgetLoad",e=>setFont(e.detail.fieldData.font));
window.addEventListener("onWidgetUpdate",e=>setFont(e.detail.fieldData.font));`,
    fields: {font: {type: 'googleFont', label: 'Font', value: 'Unbounded'}}, viewport: {width: 320, height: 120}, ready: {selector: '#t', timeoutMs: 5000}
  };
  value.scenes = [{schemaVersion: 1, id: 'default', name: 'Default', output: {width: 320, height: 120}, captureAtMs: 0}];
  value.recipes = [{schemaVersion: 1, id: 'image', name: 'Image', scenes: ['default'], outputs: {screenshots: true}}];
  value.scenarios = [{schemaVersion: 1, id: 'switch-font', name: 'Switch font', steps: [{action: 'updateFields', fieldData: {font: 'Studio Display'}}, {action: 'assert', selector: '#t', text: 'Studio'}]}];
  return {id, projectId: 'project-fonts', createdAt: new Date().toISOString(), snapshot: value, status: 'ready', diagnostics: [], prepared: {snapshot: value, assets: [], warnings: [], googleFonts: {epoch: 'v1', userAgent: GOOGLE_FONTS_UA, static: [gfCss('Unbounded')]}}};
}
const artifactJson = async (store: ObjectStore, done: Job, name: string) => JSON.parse(Buffer.from((await store.get(done.artifacts.find(item => item.name.endsWith(name))!.key))!.body).toString());

test('[browser] the local runJob renders Google Fonts in two passes, and re-renders from the lock without upstream', {timeout: 240_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-local-fonts-'));
  try {
    const store = new LocalStore(join(root, 'store'));
    const google = await fakeGoogle();
    const value = googleFontRevision('revision-fonts');
    const first = await runJob({...job('render', 'image'), projectId: value.projectId, revisionId: value.id, id: 'job-local-fonts-1'}, value, store, {fonts: google.fonts});
    assert.equal(first.status, 'completed', first.error);
    assert.equal(first.fontPass, 2);
    assert.deepEqual(google.calls, [gfCss('Unbounded'), gfFile('Unbounded')]);
    const manifest = await artifactJson(store, first, 'manifest.json');
    assert.equal(manifest.fonts.mode, 'cache');
    assert.equal(manifest.fonts.userAgent, GOOGLE_FONTS_UA);
    assert.deepEqual(manifest.fonts.served.map((entry: {url: string; status: number}) => [entry.url, entry.status]), [[gfCss('Unbounded'), 200], [gfFile('Unbounded'), 200]]);
    assert.ok(manifest.fonts.served.every((entry: {sha256: string}) => /^[0-9a-f]{64}$/.test(entry.sha256)));
    assert.equal(manifest.artifacts[0].fonts.families.find((entry: {family: string}) => entry.family === 'Unbounded')?.status, 'loaded');

    const second = await runJob({...job('render', 'image'), projectId: value.projectId, revisionId: value.id, id: 'job-local-fonts-2'}, value, store, {fonts: google.fonts});
    assert.equal(second.status, 'completed', second.error);
    assert.equal(second.fontPass, undefined, 'one pass');
    assert.equal(google.calls.length, 2, 'the re-render never calls upstream');
    const again = await artifactJson(store, second, 'manifest.json');
    assert.equal(again.fonts.servedDigest, manifest.fonts.servedDigest);
    assert.equal(again.artifacts[0].hashes.screenshot, manifest.artifacts[0].hashes.screenshot);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('[browser] a test job whose scenario switches googleFont through updateFields discovers the font and passes', {timeout: 240_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-local-font-test-'));
  try {
    const store = new LocalStore(join(root, 'store'));
    const google = await fakeGoogle();
    const value = googleFontRevision('revision-font-test');
    const tested = await runJob({...job('test', 'all'), projectId: value.projectId, revisionId: value.id, id: 'job-local-font-test'}, value, store, {fonts: google.fonts});
    assert.equal(tested.status, 'completed', tested.error);
    assert.equal(tested.fontPass, 2, 'the smoke run and the scenario missed both families in one pass');
    const report = await artifactJson(store, tested, 'test-report.json');
    assert.equal(report.smoke.status, 'passed', JSON.stringify(report.smoke));
    assert.equal(report.scenarios[0].status, 'passed', JSON.stringify(report.scenarios[0]));
    assert.deepEqual(report.fonts.served.map((entry: {url: string}) => entry.url), [gfCss('Studio Display'), gfCss('Unbounded'), gfFile('Studio Display'), gfFile('Unbounded')]);
    assert.deepEqual((await lockForRevision(store, value.projectId, value.id)).map(entry => entry.url), [gfCss('Studio Display'), gfCss('Unbounded')]);
  } finally {await rm(root, {recursive: true, force: true});}
});
