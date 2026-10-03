import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {buildSnapshot, configCatalog, DEFAULT_ORIGIN, fontIssues, main, normalizeOrigin, originLimits, studioFetch} from '../../skills/se-widget-studio/scripts/studio-client.mjs';

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

test('hosted skill client passes widget.fieldUpdate from the catalog into the snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-field-update-'));
  try {
    await widget(root);
    const catalog = join(root, 'catalog.json');
    await writeFile(catalog, JSON.stringify({widget: {fieldUpdate: 'event'}}));
    assert.equal((await buildSnapshot(root, {catalog})).widget.fieldUpdate, 'event');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('hosted skill client passes built-in sample references through without uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-samples-'));
  try {
    await widget(root);
    const catalog = join(root, 'catalog.json');
    const scene = {schemaVersion: 1, id: 'gallery', name: 'Gallery', fieldData: {image: 'sws-sample:gallery/streamer-1-blur.jpg', galleryImages: ['sws-sample:gallery/streamer-2.jpg', 'sws-sample:backdrops/cute.jpg']}, background: {id: 'blueprint', image: 'sws-sample:backdrops/blueprint.jpg', color: '#0d4474'}};
    await writeFile(catalog, JSON.stringify({scenes: [scene]}));
    const snapshot = await buildSnapshot(root, {catalog});
    assert.deepEqual(snapshot.scenes[0], scene);
    assert.deepEqual(snapshot.assets, []);
  } finally {await rm(root, {recursive: true, force: true});}
});

const SAMPLE_SCENE = {schemaVersion: 1, id: 'gallery', name: 'Gallery', fieldData: {galleryImages: ['sws-sample:gallery/streamer-1-blur.jpg', 'sws-sample:gallery/streamer-2.jpg']}, background: {id: 'blueprint', image: 'sws-sample:backdrops/blueprint.jpg', color: '#0d4474'}};
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
    await assert.rejects(run('a.json'), failure(/Unknown sample media reference\(s\): sws-sample:gallery\/not-a-sample\.jpg\. Valid references: .*sws-sample:gallery\/streamer-1-blur\.jpg.*Nothing was created\./));
    await writeFile(catalog, JSON.stringify({scenes: [{...SAMPLE_SCENE, fieldData: {galleryImages: ['sws-sample:gallery/neon-city.jpg']}}]}));
    await assert.rejects(run('a.json'), failure(/Unknown sample media reference\(s\): sws-sample:gallery\/neon-city\.jpg \(retired on 2026-09-29\)\. Valid references: /));
    assert.deepEqual(studio.requests, [], 'an unknown or retired reference must fail before any request');

    await writeFile(catalog, JSON.stringify({scenes: [SAMPLE_SCENE]}));
    mode.current = 'old';
    await assert.rejects(run('b.json'), failure(/does not support sws-sample: references: GET \/api\/v1\/sample-media returned HTTP 404.*Nothing was created\./));
    mode.current = 'partial';
    await assert.rejects(run('c.json'), failure(/does not serve these sample references: sws-sample:backdrops\/blueprint\.jpg\./));
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

test('run prints the Google Fonts issues of the manifest it downloads, on one line and in its JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-run-fonts-'));
  const token = 'private_capability_12345678901234567890';
  const issue = 'upstream-4xx: Google Fonts refused "Missing Family" (https://fonts.googleapis.com/css2?family=Missing+Family) with HTTP 400; the text stays in fallback, as in StreamElements.';
  const manifest = Buffer.from(JSON.stringify({schemaVersion: 1, fonts: {mode: 'cache', served: [], issues: [issue]}}));
  const image = Buffer.from([137, 80, 78, 71]);
  const artifact = (id: string, name: string, bytes: Buffer, contentType: string) => ({id, name, key: `k/${id}`, contentType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    if (request.method === 'POST' && request.url === '/api/studio/projects/project-test/jobs') {
      response.statusCode = 202; response.setHeader('Content-Type', 'application/json');
      return response.end(JSON.stringify({id: 'job-test', projectId: 'project-test', revisionId: 'revision-test', kind: 'render', selection: 'stills', status: 'completed', createdAt: new Date().toISOString(), progress: 'Done', artifacts: [artifact('image', 'stills/a.png', image, 'image/png'), artifact('manifest', 'stills/manifest.json', manifest, 'application/json')]}));
    }
    const body = request.url === '/api/studio/projects/project-test/artifacts/manifest' ? manifest : request.url === '/api/studio/projects/project-test/artifacts/image' ? image : undefined;
    if (request.method === 'GET' && body) return response.end(body);
    response.statusCode = 500; response.end('{}');
  });
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const access = join(root, 'access.private.json');
    await writeFile(access, JSON.stringify({schemaVersion: 1, purpose: 'se-widget-studio-access', origin: `http://127.0.0.1:${address.port}`, projectId: 'project-test', token, editorUrl: `/p/project-test#key=${token}`}), {mode: 0o600});
    const output = join(root, 'output');
    const {stdout, stderr} = await exec(process.execPath, [script, 'run', '--access', access, '--kind', 'render', '--selection', 'stills', '--output-dir', output]);
    assert.equal(stderr, `[se-widget-studio] Google Fonts issues: ${issue}\n`);
    assert.deepEqual(JSON.parse(stdout).fontIssues, [issue]);
    assert.deepEqual(JSON.parse(await readFile(join(output, 'job.json'), 'utf8')).fontIssues, [issue]);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, {recursive: true, force: true});
  }
});

async function runAgainst(poll: (respond: (status: number, body: string) => void, job: (status: string, artifacts?: unknown[], id?: string) => string, artifact: unknown) => void) {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-run-poll-'));
  const token = 'private_capability_12345678901234567890';
  const image = Buffer.from([137, 80, 78, 71]);
  const artifact = {id: 'image', name: 'stills/a.png', key: 'k/image', contentType: 'image/png', bytes: image.length, sha256: createHash('sha256').update(image).digest('hex')};
  const job = (status: string, artifacts: unknown[] = [], id = 'job-test') => JSON.stringify({id, projectId: 'project-test', revisionId: 'revision-test', kind: 'render', selection: 'stills', status, createdAt: new Date().toISOString(), progress: status, artifacts});
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    const respond = (status: number, body: string | Buffer) => {response.statusCode = status; response.end(body);};
    if (request.method === 'POST' && request.url === '/api/studio/projects/project-test/jobs') return respond(202, job('queued'));
    if (request.method === 'GET' && request.url === '/api/studio/projects/project-test/jobs/job-test') return poll(respond, job, artifact);
    if (request.method === 'GET' && request.url === '/api/studio/projects/project-test/artifacts/image') return respond(200, image);
    respond(500, '{}');
  });
  try {
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const access = join(root, 'access.private.json');
    await writeFile(access, JSON.stringify({schemaVersion: 1, purpose: 'se-widget-studio-access', origin: `http://127.0.0.1:${address.port}`, projectId: 'project-test', token, editorUrl: `/p/project-test#key=${token}`}), {mode: 0o600});
    const result = await exec(process.execPath, [script, 'run', '--access', access, '--kind', 'render', '--selection', 'stills', '--output-dir', join(root, 'output')]).then(({stdout}) => ({stdout, stderr: ''}), (error: {stdout: string; stderr: string}) => ({stdout: error.stdout, stderr: error.stderr}));
    return {...result, requests};
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, {recursive: true, force: true});
  }
}

test('run polls the accepted job on its own route, never the project job list', async () => {
  const {stdout, stderr, requests} = await runAgainst((respond, job, artifact) => respond(200, job('completed', [artifact])));
  assert.equal(JSON.parse(stdout).status, 'completed', stderr);
  assert.deepEqual(requests, ['POST /api/studio/projects/project-test/jobs', 'GET /api/studio/projects/project-test/jobs/job-test', 'GET /api/studio/projects/project-test/artifacts/image']);
});

test('run stops when the job route answers 404 or returns another job', async () => {
  const missing = await runAgainst(respond => respond(404, JSON.stringify({error: 'Job not found.'})));
  assert.match(missing.stderr, /Accepted job disappeared from the project\./);
  const other = await runAgainst((respond, job) => respond(200, job('completed', [], 'other-job')));
  assert.match(other.stderr, /Job poll returned a different job\./);
  assert.equal(other.requests.some(line => line.includes('/artifacts/')), false);
});

test('fontIssues reads only a manifest or test report, and tolerates what is not one', () => {
  const issues = {fonts: {issues: ['one', 2, 'two']}};
  assert.deepEqual(fontIssues('stills/manifest.json', Buffer.from(JSON.stringify(issues))), ['one', 'two']);
  assert.deepEqual(fontIssues('test-report.json', Buffer.from(JSON.stringify(issues))), ['one', 'two']);
  assert.deepEqual(fontIssues('stills/a-manifest.json.png', Buffer.from(JSON.stringify(issues))), []);
  assert.deepEqual(fontIssues('stills/manifest.json', Buffer.from('not json')), []);
  assert.deepEqual(fontIssues('stills/manifest.json', Buffer.from('{"fonts":{}}')), []);
});

const PNG_3X2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGM4YVMBQQxwFgBbBAjpVFBn5QAAAABJRU5ErkJggg==', 'base64');

/** A widget with a local Studio config shaped like se-windows: catalog and media under studio/, scenes with /__sws/widget/ media. */
async function configuredWidget(root: string, scenes = 2) {
  const files: Record<string, string | Buffer> = {
    'index.html': '<main id="stage"></main>', 'style.css': 'body{margin:0}', 'script.js': 'window.ready = true;',
    'fields.json': JSON.stringify({gallery: {type: 'image-input', multiple: true, value: []}}),
    'se-widget-studio.config.mjs': `export default {schemaVersion: 1, widget: {root: ".", assets: ["studio/media/**/*"], viewport: {width: 640, height: 360}}, themes: {glob: "studio/themes/*.json"}, scenes: {glob: "studio/scenes/*.json"}, recipes: {glob: "studio/recipes/*.json"}, output: {root: "thumb-assets"}};\n`,
    'studio/themes/night.json': JSON.stringify({schemaVersion: 1, id: 'night', name: 'Night', fieldData: {accent: '#123456'}}),
    'studio/recipes/stills.json': JSON.stringify({schemaVersion: 1, id: 'stills', name: 'Stills', scenes: ['scene-0'], outputs: {screenshots: true}}),
    'studio/media/a.png': PNG_3X2, 'studio/media/b.png': PNG_3X2
  };
  for (let index = 0; index < scenes; index += 1) {
    files[`studio/scenes/scene-${index}.json`] = JSON.stringify({schemaVersion: 1, id: `scene-${index}`, name: `Scene ${index}`, theme: 'night', fieldData: {gallery: ['/__sws/widget/studio/media/a.png', 'studio/media/b.png']}});
  }
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), body);
  }
  return join(root, 'se-widget-studio.config.mjs');
}

test('catalog flattens a local Studio config with the checkout engine, and refuses what a hosted revision cannot hold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-catalog-'));
  try {
    const config = await configuredWidget(join(root, 'widget'));
    const out = join(root, 'catalog.json');
    const {stdout} = await exec(process.execPath, [script, 'catalog', '--config', config, '--out', out]);
    assert.deepEqual(JSON.parse(stdout).counts, {themes: 1, fixtures: 0, scenes: 2, scenarios: 0, recipes: 1, assets: 2});
    const catalog = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(catalog.scenes[0].fieldData.gallery, ['studio/media/a.png', 'studio/media/b.png']);
    assert.deepEqual(catalog.assets, [{path: 'studio/media/a.png', file: 'studio/media/a.png', contentType: 'image/png'}, {path: 'studio/media/b.png', file: 'studio/media/b.png', contentType: 'image/png'}]);
    // The written catalog is what import --catalog takes.
    const snapshot = await buildSnapshot(join(root, 'widget'), {catalog: out}).catch((error: Error) => error);
    assert.match(String(snapshot), /Catalog contains local file assets\. Use the import command/);
    await assert.rejects(exec(process.execPath, [script, 'catalog', '--config', config, '--out', out]), failure(/Catalog output already exists\. Nothing was overwritten\./));

    const large = await configuredWidget(join(root, 'large'), 49);
    await assert.rejects(exec(process.execPath, [script, 'catalog', '--config', large, '--out', join(root, 'large.json')]), failure(/holds at most 48 of each catalog kind, and this config has 49 scenes\. Pass --recipes <id,\.\.\.>/));
    const {stdout: narrowed} = await exec(process.execPath, [script, 'catalog', '--config', large, '--recipes', 'stills', '--out', join(root, 'stills.json')]);
    assert.deepEqual(JSON.parse(narrowed).counts, {themes: 1, fixtures: 0, scenes: 1, scenarios: 0, recipes: 1, assets: 2});
    await assert.rejects(exec(process.execPath, [script, 'catalog', '--config', large, '--recipes', 'stills,nope', '--out', join(root, 'nope.json')]), failure(/Recipe not found: nope/));
    await assert.rejects(stat(join(root, 'large.json')), {code: 'ENOENT'});
  } finally {await rm(root, {recursive: true, force: true});}
});

test('import --config uploads the widget files and submits the flattened catalog with widget-relative media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-import-config-'));
  let submitted: any; let finalized: any;
  const uploads = new Map<string, Buffer>(); const reservations: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/projects') {
      submitted = JSON.parse(bytes.toString('utf8')); response.statusCode = 201;
      return response.end(JSON.stringify({projectId: 'project-test', revisionId: 'revision-test', status: 'blocked', token: TEST_TOKEN, editorUrl: `/p/project-test#key=${TEST_TOKEN}`, etag: 'etag-test'}));
    }
    if (request.method === 'POST' && request.url === '/api/v1/projects/project-test/uploads') {
      reservations.push(JSON.parse(bytes.toString('utf8'))); response.statusCode = 201;
      const uploadId = `upload-${reservations.length}`;
      return response.end(JSON.stringify({uploadId, url: `/api/v1/projects/project-test/uploads/${uploadId}`, method: 'PUT', headers: {}, requiresAuthorization: true}));
    }
    if (request.method === 'PUT' && request.url?.startsWith('/api/v1/projects/project-test/uploads/')) {uploads.set(request.url.split('/').at(-1)!, bytes); response.statusCode = 201; return response.end('{}');}
    if (request.method === 'GET' && request.url === '/api/v1/projects/project-test') return response.end(JSON.stringify({etag: 'etag-test', revision: {id: 'revision-test', status: 'blocked', snapshot: submitted}}));
    if (request.method === 'PUT' && request.url === '/api/v1/projects/project-test') {finalized = JSON.parse(bytes.toString('utf8')); return response.end(JSON.stringify({revision: {id: 'revision-ready', status: 'ready', diagnostics: []}}));}
    response.statusCode = 500; response.end(JSON.stringify({error: 'Unexpected test route.'}));
  });
  try {
    const config = await configuredWidget(join(root, 'widget'), 3);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const access = join(root, 'access.private.json');
    const {stdout} = await exec(process.execPath, [script, 'import', '--config', config, '--recipes', 'stills', '--origin', origin, '--access-out', access], {env: {...process.env, STUDIO_CREATE_KEY: undefined}});
    assert.deepEqual(JSON.parse(stdout), {status: 'ready', projectId: 'project-test', revisionId: 'revision-ready', accessFile: access, uploadedAssets: 2, editorAvailable: true});
    assert.equal(submitted.name, 'widget');
    assert.equal(submitted.widget.html, '<main id="stage"></main>');
    assert.deepEqual(submitted.widget.viewport, {width: 640, height: 360});
    assert.deepEqual(submitted.scenes.map((scene: {id: string}) => scene.id), ['scene-0']);
    assert.deepEqual(submitted.scenes[0].fieldData.gallery, ['studio/media/a.png', 'studio/media/b.png']);
    assert.deepEqual(submitted.themes.map((theme: {id: string}) => theme.id), ['night']);
    assert.deepEqual(submitted.assets, []);
    assert.deepEqual(reservations, [{bytes: PNG_3X2.length, contentType: 'image/png'}, {bytes: PNG_3X2.length, contentType: 'image/png'}]);
    assert.deepEqual([...uploads.values()], [PNG_3X2, PNG_3X2]);
    assert.deepEqual(finalized.assets, [{path: 'studio/media/a.png', contentType: 'image/png', uploadId: 'upload-1'}, {path: 'studio/media/b.png', contentType: 'image/png', uploadId: 'upload-2'}]);

    await assert.rejects(main(['import', '--config', config, '--widget-root', join(root, 'widget'), '--origin', origin]), /--config replaces --widget-root and --catalog/);
    await assert.rejects(main(['import', '--widget-root', join(root, 'widget'), '--recipes', 'stills', '--origin', origin]), /--recipes needs --config\./);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, {recursive: true, force: true});
  }
});

test('--config warns when the checkout engine it reads the config with is dirty or older than its source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sws-skill-engine-'));
  const stderr: string[] = [];
  const write = process.stderr.write;
  try {
    const config = await configuredWidget(join(root, 'widget'));
    // A checkout whose dist/ re-exports the real engine but records its own build: dirty, and older than src/.
    const dist = join(root, 'checkout/dist');
    await mkdir(join(dist, 'config'), {recursive: true});
    await mkdir(join(root, 'checkout/src'), {recursive: true});
    await writeFile(join(dist, 'build-info.js'), `export {buildFreshness} from ${JSON.stringify(resolve('dist/build-info.js'))};\n`);
    await writeFile(join(dist, 'config/hosted-catalog.js'), `export {hostedCatalogFromConfig} from ${JSON.stringify(resolve('dist/config/hosted-catalog.js'))};\n`);
    await writeFile(join(dist, 'build-info.json'), JSON.stringify({version: '0.2.0', commit: 'c'.repeat(40), dirty: true}));
    await writeFile(join(root, 'checkout/src/index.ts'), '// newer than the build\n');
    const past = new Date(Date.now() - 60_000);
    const {utimes} = await import('node:fs/promises');
    await utimes(join(dist, 'build-info.json'), past, past);
    process.stderr.write = ((chunk: string) => {stderr.push(String(chunk)); return true;}) as typeof process.stderr.write;
    const result = await configCatalog(config, {engineDist: dist});
    process.stderr.write = write;
    assert.equal(result.catalog.scenes.length, 2);
    assert.match(stderr.join(''), /Warning BUILD_DIRTY: dist\/ was built from uncommitted changes on top of cccccccccccc/);
    assert.match(stderr.join(''), /Warning BUILD_STALE: dist\/ is older than src\/: src\/index\.ts changed after the build/);
    await assert.rejects(configCatalog(config, {engineDist: join(root, 'no-checkout/dist')}), /--config reads the config with the engine of the SE Widget Studio checkout this skill runs from, and .* is missing\. Run npm run build:engine in that checkout\. A copied skill has no engine/);
  } finally {
    process.stderr.write = write;
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

test('the client defaults to the local Studio and names it when nothing listens there', async () => {
  assert.equal(DEFAULT_ORIGIN, 'http://127.0.0.1:4310');
  const {stdout} = await exec(process.execPath, [script, '--help']);
  assert.match(stdout, /default origin is http:\/\/127\.0\.0\.1:4310, the local Studio that `npm run serve` starts/);
  // A port that was just free: nothing listens there.
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const {port} = server.address() as {port: number};
  await new Promise(done => server.close(done));
  await assert.rejects(studioFetch(`http://127.0.0.1:${port}/api/v1/version`), new RegExp(`No Studio is running at http://127\\.0\\.0\\.1:${port}\\. Start the local Studio in the Studio checkout with \`npm run serve\``));
});

test('the client waits for a local job and accepts its artifacts within the local limits', () => {
  assert.deepEqual(originLimits('http://127.0.0.1:4310'), {jobMs: 125 * 60_000, artifact: 512 * 1024 * 1024});
  assert.deepEqual(originLimits('https://se-dev-kit.vercel.app'), {jobMs: 10 * 60_000, artifact: 100 * 1024 * 1024});
});
