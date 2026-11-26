import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {mkdir, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fakeMachineCheck} from './fake-machine-check';
import {temporaryDirectory} from './temporary';

// `run` polls a job it already submitted: a poll that loses the connection is asked again, up to 5 in a row, and
// the 6th names the job and the `download --job` command instead of "No Studio is running" (#59). `download --job`
// fetches a job that ended with the same files and job.json as `run`.

const script = resolve('skills/se-widget-studio/scripts/studio-client.mjs');
const PROJECT = '/api/studio/projects/project-test';
const token = 'private_capability_12345678901234567890';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const image = Buffer.from([137, 80, 78, 71]);
const imageArtifact = {id: 'image', name: 'stills/a.png', key: 'k/image', contentType: 'image/png', bytes: image.length, sha256: sha(image)};
const report = Buffer.from(JSON.stringify({smoke: {id: 'smoke', status: 'passed'}, scenarios: [{id: 'chat-burst', status: 'failed', errors: ['Text overflowed']}]}));
const reportArtifact = {id: 'report', name: 'test-report.json', key: 'k/report', contentType: 'application/json', bytes: report.length, sha256: sha(report)};
const files: Record<string, Buffer> = {image, report};

type Options = {artifacts?: unknown[]; kind?: string; selection?: string; error?: string};
const job = (status: string, {artifacts = [], kind = 'render', selection = 'stills', error}: Options = {}) =>
  JSON.stringify({id: 'job-test', projectId: 'project-test', revisionId: 'revision-test', kind, selection, status, createdAt: new Date().toISOString(), progress: status, artifacts, ...(error ? {error} : {})});
const completed = () => job('completed', {artifacts: [imageArtifact]});

type Handler = (count: number, request: IncomingMessage, response: ServerResponse) => void;
const reset: Handler = (_count, request) => request.socket.resetAndDestroy();
const serve = (body: string): Handler => (_count, _request, response) => {response.end(body);};

/** A fake local Studio whose job route answers `poll` (the count of job reads so far) and artifact route `artifact`. */
async function studio({poll, artifact = (_count, request, response) => {response.end(files[String(request.url).split('/').pop() ?? '']);}}: {poll: Handler; artifact?: Handler}) {
  const root = await temporaryDirectory('sws-skill-poll-');
  const requests: string[] = [];
  let polls = 0; let downloads = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/v1/version') return response.end('{}');
    if (request.method === 'POST' && request.url === `${PROJECT}/jobs`) {response.statusCode = 202; return response.end(job('queued'));}
    if (request.method === 'GET' && request.url === `${PROJECT}/jobs/job-test`) return poll(++polls, request, response);
    if (request.method === 'GET' && request.url?.startsWith(`${PROJECT}/jobs/`)) {response.statusCode = 404; return response.end(JSON.stringify({error: 'Job not found.'}));}
    if (request.method === 'GET' && request.url?.startsWith(`${PROJECT}/artifacts/`)) return artifact(++downloads, request, response);
    response.statusCode = 500; response.end('{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const access = join(root, 'access.private.json');
  await writeFile(access, JSON.stringify({schemaVersion: 1, purpose: 'se-widget-studio-access', origin: `http://127.0.0.1:${address.port}`, projectId: 'project-test', token, editorUrl: `/p/project-test#key=${token}`}), {mode: 0o600});
  const check = await fakeMachineCheck(root, 'unused');
  await rm(check.busy);
  const env = {...process.env, MACHINE_CHECK: check.script, SE_WIDGET_STUDIO_MACHINE_POLL_MS: '100', SE_WIDGET_STUDIO_JOB_POLL_MS: '50'};
  const cli = (...args: string[]) => new Promise<{code: number; stdout: string; stderr: string}>(done => {
    execFile(process.execPath, [script, ...args], {env}, (error, stdout, stderr) => done({code: error ? Number(error.code ?? 1) : 0, stdout, stderr}));
  });
  return {
    root, access, requests,
    polls: () => polls,
    artifactReads: () => requests.filter(line => line.includes('/artifacts/')).length,
    run: (output: string, kind = 'render', selection = 'stills') => cli('run', '--access', access, '--kind', kind, '--selection', selection, '--output-dir', output),
    download: (output: string, id = 'job-test') => cli('download', '--job', id, '--access', access, '--output-dir', output),
    close: () => new Promise<void>(done => {server.closeAllConnections(); server.close(() => done());})
  };
}

const absent = (path: string) => assert.rejects(stat(path), {code: 'ENOENT'});

for (const [code, drop] of [['ECONNRESET', reset], ['UND_ERR_SOCKET', ((_count, request) => request.socket.destroy()) as Handler]] as const) {
  test(`run asks again after one poll that loses the connection (${code}) and downloads the job`, async () => {
    const fake = await studio({poll: (count, request, response) => count === 1 ? drop(count, request, response) : serve(completed())(count, request, response)});
    try {
      const output = join(fake.root, 'output');
      const result = await fake.run(output);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, new RegExp(`\\[se-widget-studio\\] The poll of job job-test failed \\(${code}\\); asking again in 0\\.05 s \\(1/5\\)\\.`));
      assert.equal(fake.polls(), 2);
      assert.deepEqual((await readdir(output)).sort(), ['000-a.png', 'job.json']);
      assert.equal(JSON.parse(await readFile(join(output, 'job.json'), 'utf8')).status, 'completed');
    } finally {await fake.close();}
  });
}

test('run starts the count of lost polls again after a poll that answers', async () => {
  // Six lost polls, never two in a row, then the job completes: a count that never starts again gives up at the 6th.
  const fake = await studio({poll: (count, request, response) => count > 12 ? serve(completed())(count, request, response) : count % 2 ? reset(count, request, response) : serve(job('running'))(count, request, response)});
  try {
    const result = await fake.run(join(fake.root, 'output'));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.polls(), 13);
    assert.equal(result.stderr.match(/\(1\/5\)\./g)?.length, 6);
    assert.doesNotMatch(result.stderr, /\(2\/5\)/);
  } finally {await fake.close();}
});

test('run gives up after 6 lost polls in a row, naming the job and how to download it', async () => {
  const fake = await studio({poll: reset});
  try {
    const output = join(fake.root, 'output');
    const result = await fake.run(output);
    assert.equal(result.code, 1);
    assert.equal(fake.polls(), 6);
    for (let n = 1; n <= 5; n++) assert.match(result.stderr, new RegExp(`The poll of job job-test failed \\(ECONNRESET\\); asking again in 0\\.05 s \\(${n}/5\\)\\.`));
    const last = result.stderr.trim().split('\n').at(-1) ?? '';
    assert.equal(last, `The Studio at ${new URL(JSON.parse(await readFile(fake.access, 'utf8')).origin).origin} stopped answering while job job-test ran (ECONNRESET, 6 polls in a row). The job was submitted and may still be running: check it with \`status --access ${fake.access}\`, and once it is completed download it with \`download --job job-test --access ${fake.access} --output-dir <new-dir>\` instead of submitting it again.`);
    assert.doesNotMatch(result.stderr, /Nothing was changed|No Studio is running/);
    await absent(output);
  } finally {await fake.close();}
});

test('run does not ask again after a poll answered with HTTP 500 or with data that is not JSON', async () => {
  for (const [status, body, message] of [[500, '{}', /Job poll failed with HTTP 500\./], [200, 'not json', /Studio returned non-JSON data \(HTTP 200\)\./]] as const) {
    const fake = await studio({poll: (_count, _request, response) => {response.statusCode = status; response.end(body);}});
    try {
      const result = await fake.run(join(fake.root, 'output'));
      assert.equal(result.code, 1);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stderr, /asking again/);
      assert.equal(fake.polls(), 1);
    } finally {await fake.close();}
  }
});

test('download --job writes the same files and job.json as run, with the kind and selection of the job record', async () => {
  const fake = await studio({poll: (count, request, response) => serve(count === 1 ? job('running') : completed())(count, request, response)});
  try {
    const ran = join(fake.root, 'ran'); const downloaded = join(fake.root, 'downloaded');
    assert.equal((await fake.run(ran)).code, 0);
    const before = fake.requests.length;
    const result = await fake.download(downloaded);
    assert.equal(result.code, 0, result.stderr);
    // One read of the job and its artifact: no machine wait and no submission.
    assert.deepEqual(fake.requests.slice(before), [`GET ${PROJECT}/jobs/job-test`, `GET ${PROJECT}/artifacts/image`]);
    assert.deepEqual(await readdir(downloaded), await readdir(ran));
    const record = JSON.parse(await readFile(join(downloaded, 'job.json'), 'utf8'));
    assert.deepEqual(record, JSON.parse(await readFile(join(ran, 'job.json'), 'utf8')));
    assert.equal(`${record.kind} ${record.selection}`, 'render stills');
    assert.deepEqual(await readFile(join(downloaded, '000-a.png')), image);
    assert.equal(JSON.parse(result.stdout).output, downloaded);
  } finally {await fake.close();}
});

test('download --job refuses a running job, a missing job, an existing output directory, and an invalid ID', async () => {
  const fake = await studio({poll: serve(job('running', {artifacts: [imageArtifact]}))});
  try {
    const output = join(fake.root, 'output');
    const running = await fake.download(output);
    assert.equal(running.code, 1);
    assert.equal(running.stderr.trim(), `Job job-test is running (running). Nothing was downloaded: check it with \`status --access ${fake.access}\` and download it once it is completed.`);
    assert.equal(fake.artifactReads(), 0);
    await absent(output);
    const missing = await fake.download(output, 'job-gone');
    assert.equal(missing.code, 1);
    assert.equal(missing.stderr.trim(), 'Job job-gone is not in this project.');
    await absent(output);
    const before = fake.requests.length;
    await mkdir(output);
    assert.match((await fake.download(output)).stderr, /Output directory already exists/);
    assert.match((await fake.download(join(fake.root, 'other'), 'job/../x')).stderr, /--job must be a job ID\./);
    assert.equal(fake.requests.length, before);
  } finally {await fake.close();}
});

test('download --job of a failed test downloads its report and fails with its checks, as run does', async () => {
  const failed = job('failed', {kind: 'test', selection: 'all', artifacts: [reportArtifact], error: 'One or more browser checks failed.'});
  const fake = await studio({poll: serve(failed)});
  try {
    const ran = join(fake.root, 'ran'); const downloaded = join(fake.root, 'downloaded');
    const run = await fake.run(ran, 'test', 'all');
    const result = await fake.download(downloaded);
    for (const [outcome, output] of [[run, ran], [result, downloaded]] as const) {
      assert.equal(outcome.code, 1);
      assert.match(outcome.stderr, /\[se-widget-studio\] Failed check chat-burst: Text overflowed\n/);
      assert.match(outcome.stderr, new RegExp(`Job ended with failed\\. One or more browser checks failed\\. The report was downloaded to ${output.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
      assert.deepEqual(await readFile(join(output, '000-test-report.json')), report);
    }
    assert.deepEqual(JSON.parse(await readFile(join(downloaded, 'job.json'), 'utf8')), JSON.parse(await readFile(join(ran, 'job.json'), 'utf8')));
  } finally {await fake.close();}
});

test('a connection lost while an artifact downloads names the job and download --job, without asking again', async () => {
  const fake = await studio({poll: serve(completed()), artifact: reset});
  try {
    for (const command of ['run', 'download'] as const) {
      const before = fake.artifactReads();
      const output = join(fake.root, command);
      const result = command === 'run' ? await fake.run(output) : await fake.download(output);
      assert.equal(result.code, 1);
      assert.equal(fake.artifactReads() - before, 1);
      assert.match(result.stderr, /stopped answering while the artifacts of job job-test downloaded \(ECONNRESET\)\. The job is completed: download it with `download --job job-test --access .+ --output-dir <new-dir>` into a new directory/);
      assert.doesNotMatch(result.stderr, /Nothing was changed|No Studio is running/);
    }
  } finally {await fake.close();}
});
