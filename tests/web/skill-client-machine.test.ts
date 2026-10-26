import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {waitBeforeSubmitting} from '../../skills/se-widget-studio/scripts/studio-client.mjs';
import {fakeMachineCheck} from './fake-machine-check';

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
