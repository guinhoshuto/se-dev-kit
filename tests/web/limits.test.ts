import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {hostedLimits, jobBudgetMs} from '../../lib/limits';
import {localWorkerEnvironment, remainingJobTime} from '../../lib/jobs';
import {createProject, dailyBudget} from '../../lib/projects';
import {POST as preview} from '../../app/api/studio/projects/[id]/preview/route';
import {randomBytes} from 'node:crypto';
import {parseSnapshot} from '../../lib/schema';
import {LocalStore} from '../../lib/storage';
import {temporaryDirectory} from './temporary';
import {fakeMachineCheck} from './fake-machine-check';

/** Runs `task` as the hosted deployment (STUDIO_EXECUTION=vercel) or as a local Studio, and restores the environment. */
async function as<T>(mode: 'hosted' | 'local', task: () => T | Promise<T>): Promise<T> {
  const saved = {VERCEL: process.env.VERCEL, STUDIO_EXECUTION: process.env.STUDIO_EXECUTION};
  delete process.env.VERCEL;
  if (mode === 'hosted') process.env.STUDIO_EXECUTION = 'vercel'; else delete process.env.STUDIO_EXECUTION;
  try {return await task();} finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

const input = {schemaVersion: 1, name: 'Example', widget: {html: '<div></div>', css: '', js: '', fields: {}}};
const video = (durationMs: number, fps: number, themes = 1) => ({...input,
  themes: Array.from({length: themes}, (_, index) => ({schemaVersion: 1, id: `t${index}`, name: `T${index}`, fieldData: {}})),
  recipes: [{schemaVersion: 1, id: 'film', name: 'Film', scenes: ['default'], ...(themes > 1 ? {matrix: {themes: Array.from({length: themes}, (_, index) => `t${index}`)}} : {}), outputs: {video: {enabled: true, durationMs, fps}}}]});

test('the hosted limits apply on Vercel only', async () => {
  assert.equal(await as('hosted', hostedLimits), true);
  assert.equal(await as('local', hostedLimits), false);
  assert.equal(await as('hosted', jobBudgetMs), 10 * 60_000);
  assert.equal(await as('local', jobBudgetMs), 120 * 60_000);
});

test('a job budget is ten minutes hosted and two hours in a local Studio', async () => {
  const now = Date.now();
  const minuteOld = {createdAt: new Date(now - 60_000).toISOString()};
  const hourOld = {createdAt: new Date(now - 60 * 60_000).toISOString()};
  await as('hosted', () => {
    assert.equal(remainingJobTime(minuteOld, now), 9 * 60_000);
    assert.throws(() => remainingJobTime(hourOld, now), /execution budget/);
  });
  await as('local', () => {
    assert.equal(remainingJobTime(minuteOld, now), 119 * 60_000);
    assert.equal(remainingJobTime(hourOld, now), 60 * 60_000);
  });
});

test('video length, frame rate, variants and capture time are capped only on Vercel', async () => {
  await as('hosted', () => {
    assert.throws(() => parseSnapshot(video(16_000, 30)), /15 seconds/);
    assert.throws(() => parseSnapshot(video(10_000, 60)), /15 seconds at 30 fps/);
    assert.throws(() => parseSnapshot(video(5_000, 30, 5)), /four variants/);
    assert.throws(() => parseSnapshot({...input, scenes: [{schemaVersion: 1, id: 'late', name: 'Late', captureAtMs: 20_000}]}), /15 seconds/);
  });
  await as('local', () => {
    assert.equal(parseSnapshot(video(30_000, 60)).recipes[0].outputs?.video?.durationMs, 30_000);
    assert.equal(parseSnapshot(video(5_000, 30, 6)).recipes.length, 1);
    assert.equal(parseSnapshot({...input, scenes: [{schemaVersion: 1, id: 'late', name: 'Late', captureAtMs: 20_000}]}).scenes[0].captureAtMs, 20_000);
    // Structural limits stay: they bound a revision, not a quota.
    assert.throws(() => parseSnapshot({...input, widget: {...input.widget, viewport: {width: 4097, height: 640}}}), /4096/);
  });
});

test('the daily project, job and upload budgets count only on Vercel', async () => {
  const store = new LocalStore(await temporaryDirectory('sws-limits-budget-'));
  await as('local', async () => {for (let index = 0; index < 60; index++) await dailyBudget(store, 'jobs');});
  await as('hosted', async () => {
    for (let index = 0; index < 50; index++) await dailyBudget(store, 'jobs');
    await assert.rejects(dailyBudget(store, 'jobs'), /daily jobs limit/);
  });
});

/** Starts the job worker on a job of an unknown kind, which fails right after the slot and the font package. */
async function worker(root: string, environment: NodeJS.ProcessEnv) {
  const directory = join(root, 'job');
  await mkdir(directory, {recursive: true});
  const input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify({job: {id: 'slot-test', kind: 'unknown'}, project: {outputRoot: join(directory, 'output')}, sampleMedia: {}}));
  const child = spawn(process.execPath, [resolve('scripts/job-worker.mjs'), input, '1'], {env: {PATH: process.env.PATH, ...environment}, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {stdout += String(chunk);});
  child.stderr.on('data', chunk => {stderr += String(chunk);});
  const exited = new Promise<number | null>(done => child.once('close', done));
  const result = join(directory, 'result-1.json');
  const written = async () => {try {await stat(result); return true;} catch {return false;}};
  return {exited, written, stdout: () => stdout, stderr: () => stderr, result: async () => JSON.parse(await readFile(result, 'utf8')) as {error?: string}};
}

async function holdSlot(dir: string) {
  await mkdir(dir);
  await writeFile(join(dir, 'owner.json'), JSON.stringify({pid: process.pid, repo: 'limits-test', command: 'hold', startedAt: new Date().toISOString()}));
}

test('a local Studio job waits for the machine render slot and releases it', async () => {
  const root = await temporaryDirectory('sws-limits-slot-');
  const slot = join(root, 'render-slot');
  await holdSlot(slot);
  // A missing machine check leaves the slot alone to decide (the next test covers the check).
  const job = await worker(root, {STUDIO_EXECUTION: 'local', RENDER_SLOT_DIR: slot, MACHINE_CHECK: join(root, 'no-machine-check.py')});
  await new Promise(done => setTimeout(done, 2500));
  assert.equal(await job.written(), false, 'the worker must not run while another render holds the slot');
  assert.match(job.stderr(), /Waiting for the render slot, held by .*limits-test/);
  const {rm} = await import('node:fs/promises');
  await rm(slot, {recursive: true});
  assert.equal(await job.exited, 0);
  assert.match((await job.result()).error ?? '', /Unknown job kind/);
  await assert.rejects(stat(slot), {code: 'ENOENT'}, 'the worker releases the slot when it ends');
});

// SDK-42: holding the slot, a local job also waits for the machine check, as a CLI render does since SDK-41.
test('a local Studio job holding the slot waits while the machine check says busy, and gives the reason as its progress', {timeout: 90_000}, async () => {
  const root = await temporaryDirectory('sws-limits-machine-');
  const check = await fakeMachineCheck(root, 'the game (Client-Mac-Shipping) is open');
  const job = await worker(root, {STUDIO_EXECUTION: 'local', RENDER_SLOT_DIR: join(root, 'render-slot'), MACHINE_CHECK: check.script});
  const progress = () => job.stdout().split('\n').filter(Boolean).map(line => (JSON.parse(line) as {progress: string}).progress);
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && !progress().length;) await new Promise(done => setTimeout(done, 100));
  assert.deepEqual(progress(), ['Waiting for the machine: the game (Client-Mac-Shipping) is open']);
  assert.match(job.stderr(), /Waiting for the machine: the game \(Client-Mac-Shipping\) is open/);
  await new Promise(done => setTimeout(done, 1500));
  assert.equal(await job.written(), false, 'the worker must not run while the machine check says busy');
  // The worker asks again 20 seconds after its first answer, and then goes on.
  const {rm} = await import('node:fs/promises');
  await rm(check.busy);
  assert.equal(await job.exited, 0);
  assert.match((await job.result()).error ?? '', /Unknown job kind/);
  assert.deepEqual(progress(), ['Waiting for the machine: the game (Client-Mac-Shipping) is open', 'The machine is free; rendering.']);
  const [first] = (await readFile(check.calls, 'utf8')).trim().split('\n');
  const [, family, holder] = /^--json --familia (\d+) slot=(\S+)$/.exec(first ?? '') ?? [];
  assert.ok(Number(family) > 1, `the worker asks for its own family: ${first}`);
  assert.equal(holder, family, 'the worker asks while it holds the render slot');
});

test('the local Studio starts its workers in local execution, with the slot directory and the machine check it was given', () => {
  const saved = {RENDER_SLOT_DIR: process.env.RENDER_SLOT_DIR, MACHINE_CHECK: process.env.MACHINE_CHECK};
  process.env.RENDER_SLOT_DIR = '/tmp/slot-for-test';
  process.env.MACHINE_CHECK = '/tmp/machine-check-for-test.py';
  try {
    const environment = localWorkerEnvironment();
    assert.equal(environment.STUDIO_EXECUTION, 'local');
    assert.equal(environment.RENDER_SLOT_DIR, '/tmp/slot-for-test');
    assert.equal(environment.MACHINE_CHECK, '/tmp/machine-check-for-test.py');
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('a hosted job does not take the render slot', async () => {
  const root = await temporaryDirectory('sws-limits-hosted-');
  const slot = join(root, 'render-slot');
  await holdSlot(slot);
  const job = await worker(root, {RENDER_SLOT_DIR: slot});
  assert.equal(await job.exited, 0);
  assert.match((await job.result()).error ?? '', /Unknown job kind/);
  assert.doesNotMatch(job.stderr(), /render slot/);
});

// The embedded assets follow the response cap: 3 MiB fit in 4 MB of base64, 8 MiB in 10 MB.
test('the preview embeds up to 3 MiB of assets on Vercel and up to 8 MiB in a local Studio', async () => {
  const directory = await temporaryDirectory('sws-limits-assets-');
  const keys = ['STUDIO_STORAGE', 'STUDIO_DATA_DIR', 'STUDIO_CREATE_KEY'] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.STUDIO_STORAGE = 'local';
  process.env.STUDIO_DATA_DIR = directory;
  delete process.env.STUDIO_CREATE_KEY;
  try {
    const store = new LocalStore(directory);
    // Files of 1.7 MB: one inline asset of 3.5 MB overflows the stack while the revision is prepared.
    const project = async (files: number) => as('local', () => createProject(store, {...input, assets: Array.from({length: files}, (_, index) => ({path: `media/blob-${index}.bin`, content: randomBytes(1_700_000).toString('base64'), encoding: 'base64', contentType: 'application/octet-stream'}))}));
    const call = ({project: {id}, token}: Awaited<ReturnType<typeof project>>) => preview(new Request(`http://127.0.0.1:4310/api/studio/projects/${id}/preview`, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: '{}'}), {params: Promise.resolve({id})});
    // 3.4 MB: over the hosted budget, its base64 (4.5 MB) inside the local response cap.
    const medium = await project(2);
    const local = await as('local', () => call(medium));
    assert.equal(local.status, 200, await local.clone().text());
    const hosted = await as('hosted', () => call(medium));
    assert.equal(hosted.status, 422);
    assert.match(await hosted.text(), /up to 3 MiB of captured assets/);
    // 8.5 MB: over the local budget too, refused before its base64 (11.3 MB) could reach the response cap.
    const heavy = await project(5);
    const large = await as('local', () => call(heavy));
    assert.equal(large.status, 422);
    assert.match(await large.text(), /up to 8 MiB of captured assets/);
  } finally {
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
  }
});

// A Vercel Function answers at most about 4.5 MB; the local Studio has no such cap (SDK-34, the se-windows preview).
test('the preview response is capped at 4 MB on Vercel and at 10 MB in a local Studio', async () => {
  const directory = await temporaryDirectory('sws-limits-preview-');
  const keys = ['STUDIO_STORAGE', 'STUDIO_DATA_DIR', 'STUDIO_CREATE_KEY'] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.STUDIO_STORAGE = 'local';
  process.env.STUDIO_DATA_DIR = directory;
  delete process.env.STUDIO_CREATE_KEY;
  try {
    // 3,000,000 bytes stay inside the 3 MiB asset budget; with 300 KB of source the page passes 4 MiB too.
    const media = randomBytes(3_000_000).toString('base64');
    const {project, token} = await as('local', () => createProject(new LocalStore(directory), {...input, widget: {...input.widget, js: `/*${'x'.repeat(300_000)}*/`}, assets: [{path: 'media/blob.bin', content: media, encoding: 'base64', contentType: 'application/octet-stream'}]}));
    const call = () => preview(new Request(`http://127.0.0.1:4310/api/studio/projects/${project.id}/preview`, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: '{}'}), {params: Promise.resolve({id: project.id})});
    const local = await as('local', call);
    assert.equal(local.status, 200, await local.clone().text());
    const body = await local.text();
    assert.ok(Buffer.byteLength(body) > 4_000_000 && Buffer.byteLength(body) < 10_000_000, String(Buffer.byteLength(body)));
    const hosted = await as('hosted', call);
    // The preview document check (422) or the route's response check (413) refuses it first, both at 4 MB.
    assert.ok([413, 422].includes(hosted.status), String(hosted.status));
    assert.match(await hosted.text(), /exceeds (the )?4 MB/);
  } finally {
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
  }
});
