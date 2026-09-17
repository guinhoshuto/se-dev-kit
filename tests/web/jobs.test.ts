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
import type {WidgetSnapshot, Revision, Job, ObjectStore} from '../../lib/model';

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
test('execution budgets include queue time and cannot outlive concurrency reservations', () => {
  const now = Date.now();
  assert.equal(remainingJobTime({createdAt: new Date(now - 60_000).toISOString()}, now), 9 * 60_000);
  assert.throws(() => remainingJobTime({createdAt: new Date(now - 10 * 60_000).toISOString()}, now), /execution budget/);
  assert.throws(() => remainingJobTime({createdAt: 'invalid'}, now), /execution budget/);
});
test('hosted workers have a deterministic provider-safe Sandbox name', () => {
  assert.equal(hostedSandboxName('job_ABC-123'), 'sws-job_ABC-123');
});
test('local worker runs the real browser and publishes verified screenshots and test reports', {timeout: 120_000}, async () => {
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
