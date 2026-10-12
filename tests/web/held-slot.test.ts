import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {localWorkerEnvironment} from '../../lib/jobs';
import {fakeMachineCheck} from './fake-machine-check';

// A local Studio started under a held render slot (`render-slot.ts hold`, then the server with
// RENDER_SLOT_HELD=<hold pid>) runs its jobs under that hold; a job that waits for the slot says so on
// its progress (SDK-46). The worker here is the real scripts/job-worker.mjs, started with the
// environment the Studio gives it; its job kind is unknown, so it ends right after its waits.

const WORKER = resolve('scripts/job-worker.mjs');

/** localWorkerEnvironment() as a Studio started with `variables` in its environment builds it. */
function studioWorkerEnvironment(variables: Record<string, string>): NodeJS.ProcessEnv {
  const saved = Object.fromEntries(Object.keys(variables).map(name => [name, process.env[name]]));
  Object.assign(process.env, variables);
  try {
    return localWorkerEnvironment();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function until(condition: () => boolean | Promise<boolean>, limitMs: number): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise(done => setTimeout(done, 50));
  }
  return condition();
}

type Started = {child: ChildProcess; out: {stdout: string; stderr: string}; exited: Promise<number | null>; done: () => boolean};
function start(t: test.TestContext, command: string, args: string[], options: {env?: NodeJS.ProcessEnv; cwd?: string} = {}): Started {
  const child = spawn(command, args, {...options, stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => { child.kill('SIGKILL'); });
  const out = {stdout: '', stderr: ''};
  child.stdout?.on('data', chunk => { out.stdout += String(chunk); });
  child.stderr?.on('data', chunk => { out.stderr += String(chunk); });
  let ended = false;
  const exited = new Promise<number | null>(done => child.once('close', code => { ended = true; done(code); }));
  return {child, out, exited, done: () => ended};
}

/** A temporary render slot held by a live `sleep`, a dead pid, and a job folder for one worker. */
async function heldSlot(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sws-held-slot-'));
  const holder = start(t, 'sleep', ['60']);
  const gone = start(t, process.execPath, ['-e', '']);
  await gone.exited;
  const holderPid = holder.child.pid!;
  const deadPid = gone.child.pid!;
  assert.ok(Number.isInteger(holderPid) && holderPid > 1 && Number.isInteger(deadPid) && deadPid > 1 && deadPid !== holderPid);
  const slot = join(root, 'render-slot');
  const startedAt = new Date().toISOString();
  await mkdir(slot);
  await writeFile(join(slot, 'owner.json'), JSON.stringify({protocol: 2, pid: holderPid, repo: 'other-repo', command: 'hold: other-session', startedAt}));
  const jobDirectory = join(root, 'job');
  await mkdir(jobDirectory);
  const input = join(jobDirectory, 'input.json');
  await writeFile(input, JSON.stringify({job: {id: 'job-held', kind: 'none'}, project: {outputRoot: join(jobDirectory, 'output')}, sampleMedia: {}}));
  const tickets = async () => { try { return (await readdir(`${slot}.queue`)).filter(name => name.endsWith('.json')); } catch { return []; } };
  const cleanup = async (...started: Started[]) => {
    for (const item of [holder, ...started]) { item.child.kill('SIGKILL'); await item.exited; }
    await rm(root, {recursive: true, force: true});
  };
  return {root, slot, holderPid, deadPid, startedAt, input, jobDirectory, tickets, cleanup, machineCheck: join(root, 'no-machine-check')};
}

test('the local worker environment carries RENDER_SLOT_HELD when the Studio has it, and only then', () => {
  assert.equal(studioWorkerEnvironment({RENDER_SLOT_HELD: '4242'}).RENDER_SLOT_HELD, '4242');
  const saved = process.env.RENDER_SLOT_HELD;
  delete process.env.RENDER_SLOT_HELD;
  try {
    assert.equal('RENDER_SLOT_HELD' in localWorkerEnvironment(), false);
  } finally {
    if (saved !== undefined) process.env.RENDER_SLOT_HELD = saved;
  }
});

test('a job of a Studio started under a live hold runs under it, without a ticket in the slot queue', async t => {
  const slot = await heldSlot(t);
  const environment = studioWorkerEnvironment({RENDER_SLOT_DIR: slot.slot, RENDER_SLOT_HELD: String(slot.holderPid), MACHINE_CHECK: slot.machineCheck});
  const worker = start(t, process.execPath, [WORKER, slot.input, '1'], {env: environment, cwd: process.cwd()});
  try {
    let ticketSeen = false;
    await until(async () => { if ((await slot.tickets()).length) ticketSeen = true; return worker.done() || /render slot/.test(worker.out.stderr); }, 30_000);
    assert.doesNotMatch(worker.out.stderr, /render slot/, 'the worker waited for the slot its Studio holds');
    assert.equal(await worker.exited, 0, worker.out.stderr);
    assert.equal(ticketSeen, false);
    assert.deepEqual(await slot.tickets(), []);
    const result = JSON.parse(await readFile(join(slot.jobDirectory, 'result-1.json'), 'utf8')) as {error?: string};
    // Past both waits: the job then fails on its unknown kind, not on the slot.
    assert.equal(result.error, 'Unknown job kind.');
    assert.equal(JSON.parse(await readFile(join(slot.slot, 'owner.json'), 'utf8')).pid, slot.holderPid);
  } finally {
    await slot.cleanup(worker);
  }
});

test('a job whose hold is gone queues behind the live holder, and its progress names who holds the slot and since when', async t => {
  const slot = await heldSlot(t);
  const environment = studioWorkerEnvironment({RENDER_SLOT_DIR: slot.slot, RENDER_SLOT_HELD: String(slot.deadPid), MACHINE_CHECK: slot.machineCheck});
  assert.equal(environment.RENDER_SLOT_HELD, String(slot.deadPid));
  const worker = start(t, process.execPath, [WORKER, slot.input, '1'], {env: environment, cwd: process.cwd()});
  try {
    assert.equal(await until(() => worker.done() || /Waiting for the render slot/.test(worker.out.stderr), 30_000), true);
    assert.equal(worker.done(), false, `the worker ended instead of waiting: ${worker.out.stderr}`);
    const tickets = await slot.tickets();
    assert.equal(tickets.length, 1);
    assert.match(tickets[0]!, new RegExp(`^\\d{15}-0*${worker.child.pid}\\.json$`));
    // The stdout line follows the stderr one at once; a short grace covers the pipe.
    await until(() => worker.out.stdout.includes('\n'), 2000);
    const progress = worker.out.stdout.split('\n').filter(Boolean).map(line => (JSON.parse(line) as {progress?: unknown}).progress);
    assert.deepEqual(progress, [`Waiting for the render slot, held by pid ${slot.holderPid} (other-repo: hold: other-session) since ${slot.startedAt}.`]);
  } finally {
    await slot.cleanup(worker);
  }
});

test('a job waiting for the machine says why on its progress, under the hold of its Studio', async t => {
  const slot = await heldSlot(t);
  const check = await fakeMachineCheck(slot.root, 'the game is open');
  const environment = studioWorkerEnvironment({RENDER_SLOT_DIR: slot.slot, RENDER_SLOT_HELD: String(slot.holderPid), MACHINE_CHECK: check.script});
  const worker = start(t, process.execPath, [WORKER, slot.input, '1'], {env: environment, cwd: process.cwd()});
  try {
    assert.equal(await until(() => worker.done() || /Waiting for the machine/.test(worker.out.stderr), 30_000), true);
    assert.equal(worker.done(), false, `the worker ended instead of waiting: ${worker.out.stderr}`);
    await until(() => worker.out.stdout.includes('\n'), 2000);
    const progress = worker.out.stdout.split('\n').filter(Boolean).map(line => (JSON.parse(line) as {progress?: unknown}).progress);
    assert.deepEqual(progress, ['Waiting for the machine: the game is open']);
    assert.deepEqual(await slot.tickets(), []);
  } finally {
    await slot.cleanup(worker);
  }
});
