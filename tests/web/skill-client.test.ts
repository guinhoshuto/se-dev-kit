import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
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

test('hosted skill client passes built-in sample references through without uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-samples-'));
  try {
    await widget(root);
    const catalog = join(root, 'catalog.json');
    const scene = {schemaVersion: 1, id: 'gallery', name: 'Gallery', fieldData: {image: 'sws-sample:gallery/neon-city.jpg', galleryImages: ['sws-sample:gallery/ocean-moon.jpg', 'sws-sample:gallery/pixel-forest.jpg']}, background: {id: 'aurora', image: 'sws-sample:backdrops/aurora-mesh.jpg', color: '#2e2b52'}};
    await writeFile(catalog, JSON.stringify({scenes: [scene]}));
    const snapshot = await buildSnapshot(root, {catalog});
    assert.deepEqual(snapshot.scenes[0], scene);
    assert.deepEqual(snapshot.assets, []);
  } finally {await rm(root, {recursive: true, force: true});}
});

const SAMPLE_SCENE = {schemaVersion: 1, id: 'gallery', name: 'Gallery', fieldData: {galleryImages: ['sws-sample:gallery/ocean-moon.jpg', 'sws-sample:gallery/pixel-forest.jpg']}, background: {id: 'aurora', image: 'sws-sample:backdrops/aurora-mesh.jpg', color: '#2e2b52'}};
const TEST_TOKEN = 'private_capability_12345678901234567890';

/** A fake Studio whose sample-media support is selectable: `old` predates the list, `partial` lacks the backdrop. */
async function sampleStudio(mode: {current: 'old' | 'partial' | 'current'}) {
  const manifest = JSON.parse(await readFile(resolve('sample-media/manifest.json'), 'utf8')) as {items: {reference: string; sha256: string}[]};
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    requests.push(`${request.method} ${request.url}`);
    if (request.method === 'GET' && request.url === '/api/v1/sample-media') {
      if (mode.current === 'old') {response.statusCode = 404; response.setHeader('Content-Type', 'text/html'); return response.end('<!doctype html><title>404</title>');}
      const items = manifest.items.filter(item => mode.current === 'current' || !item.reference.includes('backdrops/')).map(({reference, sha256}) => ({reference, sha256}));
      response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({schemaVersion: 1, items}));
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/projects') {
      response.statusCode = 201;
      return response.end(JSON.stringify({projectId: 'project-test', revisionId: 'revision-test', status: 'ready', token: TEST_TOKEN, editorUrl: `/p/project-test#key=${TEST_TOKEN}`, etag: 'etag-test'}));
    }
    if (request.method === 'PUT' && request.url === '/api/v1/projects/project-test') return response.end(JSON.stringify({revision: {id: 'revision-next', status: 'ready', diagnostics: []}}));
    response.statusCode = 500; response.end(JSON.stringify({error: 'Unexpected test route.'}));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return {server, requests, origin: `http://127.0.0.1:${address.port}`};
}
const failure = (pattern: RegExp) => (error: {stderr?: string}) => {assert.match(error.stderr ?? '', pattern); return true;};

test('hosted import checks sample references offline and against the deployment before creating a project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-sample-support-'));
  const mode: {current: 'old' | 'partial' | 'current'} = {current: 'current'};
  const studio = await sampleStudio(mode);
  try {
    await widget(root);
    const catalog = join(root, 'catalog.json');
    const run = (out: string) => exec(process.execPath, [script, 'import', '--widget-root', root, '--catalog', catalog, '--origin', studio.origin, '--access-out', join(root, out)], {env: {...process.env, STUDIO_CREATE_KEY: undefined}});

    await writeFile(catalog, JSON.stringify({scenes: [{...SAMPLE_SCENE, fieldData: {galleryImages: ['sws-sample:gallery/not-a-sample.jpg']}}]}));
    await assert.rejects(run('a.json'), failure(/Unknown sample media reference\(s\): sws-sample:gallery\/not-a-sample\.jpg\. Valid references: .*sws-sample:gallery\/neon-city\.jpg.*Nothing was created\./));
    assert.deepEqual(studio.requests, [], 'an unknown reference must fail before any request');

    await writeFile(catalog, JSON.stringify({scenes: [SAMPLE_SCENE]}));
    mode.current = 'old';
    await assert.rejects(run('b.json'), failure(/does not support sws-sample: references: GET \/api\/v1\/sample-media returned HTTP 404.*Nothing was created\./));
    mode.current = 'partial';
    await assert.rejects(run('c.json'), failure(/does not serve these sample references: sws-sample:backdrops\/aurora-mesh\.jpg\./));
    assert.deepEqual(studio.requests, ['GET /api/v1/sample-media', 'GET /api/v1/sample-media'], 'no project may be created without deployment support');

    mode.current = 'current';
    const {stdout} = await run('d.json');
    assert.equal(JSON.parse(stdout).status, 'ready');
    assert.deepEqual(studio.requests.slice(2), ['GET /api/v1/sample-media', 'POST /api/v1/projects']);
  } finally {
    await new Promise<void>(done => studio.server.close(() => done()));
    await rm(root, {recursive: true, force: true});
  }
});

test('hosted push refuses sample references the deployment does not serve', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-sample-push-'));
  const mode: {current: 'old' | 'partial' | 'current'} = {current: 'old'};
  const studio = await sampleStudio(mode);
  try {
    const access = join(root, 'access.json');
    await writeFile(access, JSON.stringify({schemaVersion: 1, purpose: 'se-widget-studio-access', origin: studio.origin, projectId: 'project-test', token: TEST_TOKEN, editorUrl: `/p/project-test#key=${TEST_TOKEN}`}), {mode: 0o600});
    const draft = join(root, 'draft.json');
    await writeFile(draft, JSON.stringify({schemaVersion: 1, purpose: 'se-widget-studio-draft', origin: studio.origin, projectId: 'project-test', revisionId: 'revision-test', etag: 'etag-test', snapshot: {schemaVersion: 1, name: 'Draft', scenes: [SAMPLE_SCENE]}}));
    await assert.rejects(main(['push', '--access', access, '--draft', draft]), /does not support sws-sample: references.*Nothing was pushed\./);
    assert.deepEqual(studio.requests, ['GET /api/v1/sample-media']);
    mode.current = 'current';
    await main(['push', '--access', access, '--draft', draft]);
    assert.deepEqual(studio.requests.slice(1), ['GET /api/v1/sample-media', 'PUT /api/v1/projects/project-test']);
  } finally {
    await new Promise<void>(done => studio.server.close(() => done()));
    await rm(root, {recursive: true, force: true});
  }
});

test('hosted import prints the diagnostics of a blocked revision without its capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-blocked-'));
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/projects') {
      response.statusCode = 201;
      return response.end(JSON.stringify({projectId: 'project-test', revisionId: 'revision-test', status: 'blocked', token: TEST_TOKEN, editorUrl: `/p/project-test#key=${TEST_TOKEN}`, etag: 'etag-test'}));
    }
    if (request.method === 'GET' && request.url === '/api/v1/projects/project-test') return response.end(JSON.stringify({etag: 'etag-test', revision: {id: 'revision-test', status: 'blocked', diagnostics: ['Missing asset: logo.png']}}));
    response.statusCode = 500; response.end(JSON.stringify({error: 'Unexpected test route.'}));
  });
  try {
    await widget(root);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const {stdout} = await exec(process.execPath, [script, 'import', '--widget-root', root, '--origin', `http://127.0.0.1:${address.port}`, '--access-out', join(root, 'access.json')], {env: {...process.env, STUDIO_CREATE_KEY: undefined}});
    assert.equal(stdout.includes(TEST_TOKEN), false);
    const printed = JSON.parse(stdout);
    assert.equal(printed.status, 'blocked');
    assert.deepEqual(printed.diagnostics, ['Missing asset: logo.png']);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, {recursive: true, force: true});
  }
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

test('open-editor opens a verify-hosted access file through the system opener without printing the key, and no other command reads it', {skip: process.platform === 'win32'}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-open-editor-'));
  try {
    const bin = join(root, 'bin');
    const opened = join(root, 'opened.txt');
    await mkdir(bin);
    // A system opener that records the address it was given instead of starting a browser.
    for (const name of ['open', 'xdg-open']) await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`, {mode: 0o755});
    const access = join(root, 'access.private.json');
    await writeFile(access, JSON.stringify({schemaVersion: 1, purpose: 'hosted-verification', origin: 'https://studio.example', projectId: 'project-test', revisionId: 'revision-test', token: TEST_TOKEN}), {mode: 0o600});
    const {stdout, stderr} = await exec(process.execPath, [script, 'open-editor', '--access', access], {env: {...process.env, PATH: `${bin}:${process.env.PATH}`}});
    assert.deepEqual(JSON.parse(stdout), {status: 'opened', projectId: 'project-test'});
    assert.ok(!stdout.includes(TEST_TOKEN) && !stderr.includes(TEST_TOKEN), 'the key is never printed');
    // The opener runs detached; give it a moment to write.
    for (let attempt = 0; attempt < 100 && !(await stat(opened).then(() => true, () => false)); attempt += 1) await new Promise(done => setTimeout(done, 50));
    assert.equal(await readFile(opened, 'utf8'), `https://studio.example/p/project-test#key=${TEST_TOKEN}`);
    await assert.rejects(main(['status', '--access', access]), /Access bundle has an unsupported format\./);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('hosted skill client exposes complete English command help', async () => {
  const {stdout} = await exec(process.execPath, [script, '--help']);
  for (const command of ['import', 'status', 'open-editor', 'pull', 'push', 'run']) assert.match(stdout, new RegExp(`\\b${command}\\b`));
  assert.match(stdout, /Capabilities are never printed/);
});

test('hosted skill client runs when invoked through a linked skill directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-link-'));
  try {
    const linked = join(root, 'se-widget-studio');
    await symlink(resolve('skills/se-widget-studio'), linked, 'dir');
    const {stdout} = await exec(process.execPath, [join(linked, 'scripts/studio-client.mjs'), '--help']);
    assert.match(stdout, /^Usage:/m);
  } finally {await rm(root, {recursive: true, force: true});}
});
