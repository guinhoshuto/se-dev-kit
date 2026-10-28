import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {waitBeforeSubmitting} from '../../skills/se-widget-studio/scripts/studio-client.mjs';
import {fakeMachineCheck} from './fake-machine-check';
import {cedingChain, productStep, RENDER_SLOT, slotCheck, steps} from '../unit/ceding-chain.mjs';

// `run` on a local Studio waits for the machine before it submits the job, so a long wait happens before the
// job exists and never eats the job's two hours (SDK-46). It never asks the check of a remote Studio.

const script = resolve('skills/se-widget-studio/scripts/studio-client.mjs');

async function until(condition: () => boolean | Promise<boolean>, limitMs: number): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise(done => setTimeout(done, 50));
  }
  return condition();
}

test('run on a local Studio submits the job only once the machine check says free, and says why it waits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-run-machine-'));
  const token = 'private_capability_12345678901234567890';
  const check = await fakeMachineCheck(root, 'a render of another session runs');
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/studio/projects/project-test/jobs') {
      response.statusCode = 202;
      return response.end(JSON.stringify({id: 'job-test', projectId: 'project-test', revisionId: 'revision-test', kind: 'render', selection: 'stills', status: 'completed', createdAt: new Date().toISOString(), progress: 'Done', artifacts: []}));
    }
    response.statusCode = 500; response.end('{}');
  });
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const access = join(root, 'access.private.json');
    await writeFile(access, JSON.stringify({schemaVersion: 1, purpose: 'se-widget-studio-access', origin: `http://127.0.0.1:${address.port}`, projectId: 'project-test', token, editorUrl: `/p/project-test#key=${token}`}), {mode: 0o600});
    const child = spawn(process.execPath, [script, 'run', '--access', access, '--kind', 'render', '--selection', 'stills', '--output-dir', join(root, 'output')], {
      env: {...process.env, MACHINE_CHECK: check.script, SE_WIDGET_STUDIO_MACHINE_POLL_MS: '100'}, stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => { child.kill('SIGKILL'); });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    let ended = false;
    const exited = new Promise<number | null>(done => child.once('close', code => { ended = true; done(code); }));
    const calls = async () => { try { return (await readFile(check.calls, 'utf8')).split('\n').filter(Boolean); } catch { return []; } };
    // Busy: the check is asked again and again, and nothing reaches the Studio.
    await until(async () => ended || (await calls()).length >= 3, 20_000);
    assert.equal(ended, false, `run ended while the machine was busy: ${stderr}`);
    assert.ok((await calls()).length >= 3);
    assert.deepEqual(requests, []);
    await rm(check.busy);
    assert.equal(await until(() => ended, 20_000), true);
    assert.equal(await exited, 0, stderr);
    assert.deepEqual(requests, ['POST /api/studio/projects/project-test/jobs']);
    for (const line of await calls()) assert.match(line, new RegExp(`^--json --familia ${child.pid} slot=`));
    assert.equal(stderr.split('[se-widget-studio] Waiting for the machine before submitting: a render of another session runs\n').length, 2, stderr);
    assert.match(stderr, /\[se-widget-studio\] The machine is free; submitting the job\.\n/);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, {recursive: true, force: true});
  }
});

test('run on a local Studio waits in the render slot queue with a ticket, and a chain that cedes lets its job in between two of its steps', {timeout: 90_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-run-chain-'));
  const token = 'private_capability_12345678901234567890';
  const log = join(root, 'steps.log');
  const {RENDER_SLOT_HELD: _held, ...rest} = process.env;
  const env = {...rest, RENDER_SLOT_DIR: join(root, 'slot'), RENDER_SLOT_CHECK: 'off', MACHINE_CHECK: await slotCheck(root), SE_WIDGET_STUDIO_MACHINE_POLL_MS: '100'};
  const status = () => JSON.parse(execFileSync(process.execPath, [RENDER_SLOT, 'status', '--json'], {env, encoding: 'utf8'}));
  // A Studio whose job's worker takes the render slot as a product, as scripts/job-worker.mjs does.
  const requests: string[] = [];
  let worker: Promise<unknown> | undefined;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/studio/projects/project-test/jobs') {
      worker = productStep(env, log, 'job');
      response.statusCode = 202;
      return response.end(JSON.stringify({id: 'job-test', projectId: 'project-test', revisionId: 'revision-test', kind: 'render', selection: 'stills', status: 'completed', createdAt: new Date().toISOString(), progress: 'Done', artifacts: []}));
    }
    response.statusCode = 500; response.end('{}');
  });
  // A step of the chain holds the slot until the test has seen the client's ticket in the queue.
  let gate = true;
  const chain = cedingChain({env, log, gate: () => gate});
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const access = join(root, 'access.private.json');
    await writeFile(access, JSON.stringify({schemaVersion: 1, purpose: 'se-widget-studio-access', origin: `http://127.0.0.1:${address.port}`, projectId: 'project-test', token, editorUrl: `/p/project-test#key=${token}`}), {mode: 0o600});
    assert.ok(await until(() => status().holder?.command.startsWith('hold: chain-'), 20_000), 'the chain holds the slot');
    child = spawn(process.execPath, [script, 'run', '--access', access, '--kind', 'render', '--selection', 'stills', '--output-dir', join(root, 'output')], {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>(done => child!.once('close', code => done(code)));
    // 2026-10-27: a capture waited 1 h 12 min behind the vault's chain, polling, and the queue named nobody (#15).
    const ticket = () => status().queue.find((waiting: {command: string}) => waiting.command === 'vez: se-widget-studio.job');
    assert.ok(await until(ticket, 20_000), `render-slot status lists the client's ticket while the chain holds the slot: ${stderr}`);
    assert.equal(ticket().cede, false, 'a product ticket, which goes ahead of the chain\'s');
    assert.deepEqual(requests, [], 'no job before its turn');
    gate = false;
    assert.equal(await exited, 0, stderr);
    assert.deepEqual(requests, ['POST /api/studio/projects/project-test/jobs']);
    assert.match(stderr, /\[se-widget-studio\] Waiting for the machine before submitting, in the render slot queue as "vez: se-widget-studio\.job": the render slot is held\n/);
    assert.match(stderr, /\[se-widget-studio\] The machine is free at its turn in the render slot queue; submitting the job\.\n/);
    // The job takes the slot that the chain leaves it, and the chain goes on after it.
    await worker;
    const job = () => steps(log).find(step => step.who === 'job')!;
    assert.ok(await until(() => steps(log).some(step => step.who === 'chain' && step.from > job().to), 20_000), 'the chain takes the slot again after the job');
    const chainSteps = steps(log).filter(step => step.who === 'chain');
    assert.ok(chainSteps.some(step => step.to < job().from), 'a step of the chain held the slot before the job');
    assert.ok(chainSteps.every(step => step.to < job().from || step.from > job().to), 'no step of the chain overlaps the job');
  } finally {
    // SIGTERM, which takes its ticket out of the queue with it.
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(done => child!.once('close', done)); }
    await chain.stop();
    await worker?.catch(() => {});
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, {recursive: true, force: true});
  }
});

test('the wait before submitting asks the machine check only for a loopback Studio', async () => {
  let asked = 0;
  const check = async () => { asked++; return null; };
  await waitBeforeSubmitting('https://studio.example', {check});
  assert.equal(asked, 0);
  await waitBeforeSubmitting('http://127.0.0.1:4310', {check});
  assert.equal(asked, 1);
});

test('a client without dist/ next to it asks the machine check through the live checkout\'s build, and with no build anywhere says it skipped the check', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sws-skill-no-dist-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  // A worktree without a build, and the live checkout the global skill links to, built: this repository's dist/.
  const worktree = join(root, 'worktree', 'dist');
  const checkout = join(root, 'checkout');
  await mkdir(join(checkout, 'skills', 'se-widget-studio'), {recursive: true});
  await symlink(join(checkout, 'skills', 'se-widget-studio'), join(root, 'skill-link'));
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  t.after(() => { process.stderr.write = write; });
  let asked = 0;
  const check = async () => { asked++; return null; };
  const wait = (liveSkill: string) => waitBeforeSubmitting('http://127.0.0.1:4310', {engineDist: worktree, liveSkill, check});

  await wait(join(root, 'skill-link'));
  assert.deepEqual([asked, written], [0, [`[se-widget-studio] machine check skipped: no engine build at ${worktree} or ${join(checkout, 'dist')}\n`]], 'a live checkout without a build either');
  await symlink(resolve('dist'), join(checkout, 'dist'));
  await wait(join(root, 'skill-link'));
  assert.deepEqual([asked, written.length], [1, 1], 'the check ran through the live checkout\'s build, without a word');
  await wait(join(root, 'no-skill'));
  assert.deepEqual([asked, written.slice(1)], [1, [`[se-widget-studio] machine check skipped: no engine build at ${worktree}\n`]], 'no skill link: only the path next to the client');
});
