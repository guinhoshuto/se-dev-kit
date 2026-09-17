import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {buildSnapshot, main, normalizeOrigin} from '../../skills/se-widget-studio/scripts/studio-client.mjs';

const exec = promisify(execFile);
const script = resolve('skills/se-widget-studio/scripts/studio-client.mjs');

async function widget(root: string) {
  await mkdir(root, {recursive: true});
  await Promise.all([
    writeFile(join(root, 'widget.html'), '<main id="widget"></main>'),
    writeFile(join(root, 'widget.css'), 'body{margin:0}'),
    writeFile(join(root, 'widget.js'), 'document.querySelector("#widget").textContent="Ready";'),
    writeFile(join(root, 'widget.json'), JSON.stringify({title: {type: 'text', value: 'Ready'}}))
  ]);
}

test('hosted skill client normalizes safe origins and builds source-faithful snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-source-'));
  try {
    await widget(root);
    const catalog = join(root, 'catalog.json');
    await writeFile(catalog, JSON.stringify({name: 'Catalog name', widget: {viewport: {width: 320, height: 240}}, themes: [{schemaVersion: 1, id: 'violet', name: 'Violet', fieldData: {accent: '#a78bfa'}}]}));
    const snapshot = await buildSnapshot(root, {catalog, name: 'Explicit name'});
    assert.equal(snapshot.name, 'Explicit name');
    assert.equal(snapshot.widget.html, '<main id="widget"></main>');
    assert.deepEqual(snapshot.widget.viewport, {width: 320, height: 240});
    assert.equal(snapshot.themes[0].id, 'violet');
    await writeFile(catalog, JSON.stringify({widget: {html: 'replacement'}}));
    await assert.rejects(buildSnapshot(root, {catalog}), /cannot override production/);
    assert.equal(normalizeOrigin('https://studio.example/'), 'https://studio.example');
    assert.equal(normalizeOrigin('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
    assert.throws(() => normalizeOrigin('http://studio.example/'), /HTTPS/);
    assert.throws(() => normalizeOrigin('https://studio.example/path'), /scheme and host/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('hosted import stores the capability privately and never prints it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-import-'));
  let submitted: any; let finalized: any; let uploaded = Buffer.alloc(0); let uploadAuthorization = '';
  const token = 'private_capability_12345678901234567890';
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/projects') {
      submitted = JSON.parse(bytes.toString('utf8')); response.statusCode = 201;
      return response.end(JSON.stringify({projectId: 'project-test', revisionId: 'revision-test', status: 'blocked', token, editorUrl: `/p/project-test#key=${token}`, etag: 'etag-test'}));
    }
    if (request.method === 'POST' && request.url === '/api/v1/projects/project-test/uploads') {
      assert.deepEqual(JSON.parse(bytes.toString('utf8')), {bytes: 4, contentType: 'image/png'}); response.statusCode = 201;
      return response.end(JSON.stringify({uploadId: 'upload-test', url: '/api/v1/projects/project-test/uploads/upload-test', method: 'PUT', headers: {'Content-Type': 'image/png'}, requiresAuthorization: true}));
    }
    if (request.method === 'PUT' && request.url === '/api/v1/projects/project-test/uploads/upload-test') {
      uploaded = bytes; uploadAuthorization = request.headers.authorization ?? ''; response.statusCode = 201; return response.end('{}');
    }
    if (request.method === 'GET' && request.url === '/api/v1/projects/project-test') {
      return response.end(JSON.stringify({etag: 'etag-test', revision: {id: 'revision-test', status: 'blocked', snapshot: submitted}}));
    }
    if (request.method === 'PUT' && request.url === '/api/v1/projects/project-test') {
      finalized = JSON.parse(bytes.toString('utf8')); return response.end(JSON.stringify({revision: {id: 'revision-ready', status: 'ready', diagnostics: []}}));
    }
    response.statusCode = 500; response.end(JSON.stringify({error: 'Unexpected test route.'}));
  });
  try {
    await widget(root);
    await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets', 'logo.png'), Buffer.from([1, 2, 3, 4]));
    const catalog = join(root, 'catalog.json');
    await writeFile(catalog, JSON.stringify({assets: [{path: 'assets/logo.png', file: 'assets/logo.png', contentType: 'image/png'}]}));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const access = join(root, 'access.private.json');
    const {stdout, stderr} = await exec(process.execPath, [script, 'import', '--widget-root', root, '--catalog', catalog, '--origin', `http://127.0.0.1:${address.port}`, '--access-out', access], {env: {...process.env, STUDIO_CREATE_KEY: undefined}});
    assert.equal(stderr, '');
    assert.equal(stdout.includes(token), false);
    assert.deepEqual(JSON.parse(stdout), {status: 'ready', projectId: 'project-test', revisionId: 'revision-ready', accessFile: access, uploadedAssets: 1, editorAvailable: true});
    assert.equal(submitted.widget.html, '<main id="widget"></main>');
    assert.deepEqual(submitted.assets, []);
    assert.deepEqual(finalized.assets, [{path: 'assets/logo.png', contentType: 'image/png', uploadId: 'upload-test'}]);
    assert.deepEqual(uploaded, Buffer.from([1, 2, 3, 4]));
    assert.equal(uploadAuthorization, `Bearer ${token}`);
    const saved = JSON.parse(await readFile(access, 'utf8'));
    assert.equal(saved.token, token);
    if (process.platform !== 'win32') assert.equal((await stat(access)).mode & 0o077, 0);
    const existing = join(root, 'existing-output'); await mkdir(existing);
    await assert.rejects(main(['run', '--access', access, '--kind', 'test', '--selection', 'all', '--output-dir', existing]), /already exists/);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, {recursive: true, force: true});
  }
});

test('hosted skill client exposes complete English command help', async () => {
  const {stdout} = await exec(process.execPath, [script, '--help']);
  for (const command of ['import', 'status', 'open-editor', 'pull', 'push', 'run']) assert.match(stdout, new RegExp(`\\b${command}\\b`));
  assert.match(stdout, /Capabilities are never printed/);
});
