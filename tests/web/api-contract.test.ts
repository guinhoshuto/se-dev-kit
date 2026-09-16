import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {POST as create} from '../../app/api/v1/projects/route';
import {GET as get, PUT as replace} from '../../app/api/v1/projects/[id]/route';
import {POST as reserveUpload} from '../../app/api/v1/projects/[id]/uploads/route';
import {PUT as upload} from '../../app/api/v1/projects/[id]/uploads/[uploadId]/route';
import {POST as restore} from '../../app/api/studio/projects/[id]/restore/route';
import {GET as revision} from '../../app/api/studio/projects/[id]/revisions/[revisionId]/route';
import {GET as download} from '../../app/api/studio/projects/[id]/artifacts/[artifactId]/route';
import {LocalStore, writeJson} from '../../lib/storage';
import type {ProjectView} from '../../lib/model';

const source = {schemaVersion: 1, name: 'API fixture', widget: {html: '<main>Ready</main>', css: 'body{margin:0}', js: '', fields: {}}, themes: [{schemaVersion: 1, id: 'paper', name: 'Paper', fieldData: {title: 'Paper'}}]};
const origin = 'http://127.0.0.1:3000';
interface Created {projectId: string; revisionId: string; status: string; editorUrl: string; token: string; etag: string}
interface ReservedUpload {uploadId: string; url: string; method: string; headers: Record<string, string>; requiresAuthorization: boolean}
async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sws-api-contract-'));
  const keys = ['VERCEL', 'STUDIO_STORAGE', 'STUDIO_DATA_DIR', 'STUDIO_CREATE_KEY'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.VERCEL;
  delete process.env.STUDIO_CREATE_KEY;
  process.env.STUDIO_STORAGE = 'local';
  process.env.STUDIO_DATA_DIR = directory;
  t.after(async () => {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    await rm(directory, {recursive: true, force: true});
  });
  return new LocalStore(directory);
}
function request(path: string, method = 'GET', token?: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(origin + path, {method, headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
}
function context(id: string) {return {params: Promise.resolve({id})};}
async function newProject(input: unknown = source): Promise<Created> {
  const response = await create(request('/api/v1/projects', 'POST', undefined, input));
  assert.equal(response.status, 201, await response.clone().text());
  return response.json() as Promise<Created>;
}

test('public API keeps the editing capability in the fragment and enforces full replacement with CAS', async t => {
  await setup(t);
  const created = await newProject();
  assert.equal(created.status, 'ready');
  const link = new URL(created.editorUrl, origin);
  assert.equal(link.pathname, `/p/${created.projectId}`);
  assert.equal(link.search, '');
  assert.equal(link.hash, `#key=${created.token}`);
  for (const token of [undefined, 'wrong']) {
    assert.equal((await get(request(`/api/v1/projects/${created.projectId}`, 'GET', token), context(created.projectId))).status, 403);
  }
  const valid = await get(request(`/api/v1/projects/${created.projectId}`, 'GET', created.token), context(created.projectId));
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('cache-control'), 'no-store');
  const visible = await valid.json() as ProjectView;
  assert.equal(visible.etag, created.etag);
  assert.equal('accessHash' in visible.project, false);
  assert.equal(JSON.stringify(visible).includes(created.token), false);
  const replacement = {schemaVersion: 1, name: 'Completely replaced', widget: {...source.widget, html: '<main>Replacement</main>'}};
  const missingVersion = await replace(request(`/api/v1/projects/${created.projectId}`, 'PUT', created.token, replacement), context(created.projectId));
  assert.equal(missingVersion.status, 428);
  const updated = await replace(request(`/api/v1/projects/${created.projectId}`, 'PUT', created.token, replacement, {'If-Match': created.etag}), context(created.projectId));
  assert.equal(updated.status, 200);
  const next = await updated.json() as ProjectView;
  assert.deepEqual(next.revision.snapshot.themes, []);
  assert.deepEqual(next.revision.snapshot.scenes, []);
  assert.equal(next.revision.snapshot.widget.html, '<main>Replacement</main>');
  assert.equal(next.revisions.length, 2);
  assert.notEqual(next.etag, created.etag);
  const stale = await replace(request(`/api/v1/projects/${created.projectId}`, 'PUT', created.token, source, {'If-Match': created.etag}), context(created.projectId));
  assert.equal(stale.status, 409);
  const current = await get(request(`/api/v1/projects/${created.projectId}`, 'GET', created.token), context(created.projectId));
  assert.equal((await current.json() as ProjectView).revision.id, next.revision.id);
});

test('local uploads require project ownership, exact reserved bytes, and cannot overwrite or traverse', async t => {
  await setup(t);
  const project = await newProject();
  const other = await newProject();
  const path = `/api/v1/projects/${project.projectId}/uploads`;
  assert.equal((await reserveUpload(request(path, 'POST', other.token, {bytes: 4}), context(project.projectId))).status, 403);
  assert.equal((await reserveUpload(request(path, 'POST', project.token, {bytes: 4_000_001}), context(project.projectId))).status, 413);
  const reserved = await reserveUpload(request(path, 'POST', project.token, {bytes: 4, contentType: 'text/plain'}), context(project.projectId));
  assert.equal(reserved.status, 201);
  const ticket = await reserved.json() as ReservedUpload;
  assert.equal(ticket.requiresAuthorization, true);
  assert.equal(ticket.method, 'PUT');
  assert.equal(ticket.url, `${path}/${ticket.uploadId}`);
  const uploadContext = (id = project.projectId, uploadId = ticket.uploadId) => ({params: Promise.resolve({id, uploadId})});
  const body = (text: string, token = project.token) => new Request(origin + ticket.url, {method: 'PUT', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream'}, body: text});
  assert.equal((await upload(body('good', 'wrong'), uploadContext())).status, 403);
  assert.equal((await upload(body('no'), uploadContext())).status, 422);
  assert.equal((await upload(body('extra'), uploadContext())).status, 422);
  assert.equal((await upload(body('good'), uploadContext(project.projectId, '../escape'))).status, 400);
  assert.equal((await upload(body('good', other.token), uploadContext(other.projectId))).status, 404);
  const uploaded = await upload(body('good'), uploadContext());
  assert.equal(uploaded.status, 201);
  assert.deepEqual(await uploaded.json(), {uploadId: ticket.uploadId, bytes: 4});
  assert.equal((await upload(body('evil'), uploadContext())).status, 409);
  const attachment = {path: 'assets/example.txt', uploadId: ticket.uploadId};
  const wrongProject = await replace(request(`/api/v1/projects/${other.projectId}`, 'PUT', other.token, {...source, assets: [attachment]}, {'If-Match': other.etag}), context(other.projectId));
  assert.equal(wrongProject.status, 200);
  const blocked = await wrongProject.json() as ProjectView;
  assert.equal(blocked.revision.status, 'blocked');
  assert.match(blocked.revision.diagnostics.join(' '), /does not belong/);
  const ownProject = await replace(request(`/api/v1/projects/${project.projectId}`, 'PUT', project.token, {...source, assets: [attachment]}, {'If-Match': project.etag}), context(project.projectId));
  const prepared = await ownProject.json() as ProjectView;
  assert.equal(ownProject.status, 200);
  assert.equal(prepared.revision.status, 'ready');
  assert.equal(prepared.revision.prepared?.assets[0]?.bytes, 4);
  assert.equal(prepared.revision.snapshot.assets[0]?.uploadId, ticket.uploadId);
});

test('restore creates an immutable revision using historical prepared assets even after the source upload is removed', async t => {
  const storage = await setup(t);
  const project = await newProject();
  const uploadPath = `/api/v1/projects/${project.projectId}/uploads`;
  const reserved = await reserveUpload(request(uploadPath, 'POST', project.token, {bytes: 8, contentType: 'text/plain'}), context(project.projectId));
  const ticket = await reserved.json() as ReservedUpload;
  assert.equal((await upload(new Request(origin + ticket.url, {method: 'PUT', headers: {Authorization: `Bearer ${project.token}`}, body: 'original'}), {params: Promise.resolve({id: project.projectId, uploadId: ticket.uploadId})})).status, 201);
  const savedResponse = await replace(request(`/api/v1/projects/${project.projectId}`, 'PUT', project.token, {...source, assets: [{path: 'assets/original.txt', uploadId: ticket.uploadId}]}, {'If-Match': project.etag}), context(project.projectId));
  const saved = await savedResponse.json() as ProjectView;
  assert.equal(saved.revision.status, 'ready');
  const before = await storage.list(`projects/${project.projectId}/prepared/`);
  const changedResponse = await replace(request(`/api/v1/projects/${project.projectId}`, 'PUT', project.token, {...source, name: 'Changed'}, {'If-Match': saved.etag}), context(project.projectId));
  const changed = await changedResponse.json() as ProjectView;
  await storage.delete(`projects/${project.projectId}/uploads/${ticket.uploadId}.json`);
  await storage.delete(`projects/${project.projectId}/uploads/${ticket.uploadId}.bin`);
  const path = `/api/studio/projects/${project.projectId}/restore`;
  const input = {revisionId: saved.revision.id};
  assert.equal((await restore(request(path, 'POST', undefined, input, {'If-Match': changed.etag}), context(project.projectId))).status, 403);
  assert.equal((await restore(request(path, 'POST', project.token, input), context(project.projectId))).status, 428);
  assert.equal((await restore(request(path, 'POST', project.token, input, {'If-Match': saved.etag}), context(project.projectId))).status, 409);
  const restoredResponse = await restore(request(path, 'POST', project.token, input, {'If-Match': changed.etag}), context(project.projectId));
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json() as ProjectView;
  assert.equal(restored.revision.status, 'ready');
  assert.notEqual(restored.revision.id, saved.revision.id);
  assert.equal(restored.project.name, 'API fixture');
  assert.deepEqual(restored.revision.snapshot, saved.revision.snapshot);
  assert.deepEqual(restored.revision.prepared, saved.revision.prepared);
  assert.deepEqual(await storage.list(`projects/${project.projectId}/prepared/`), before);
  const asset = restored.revision.prepared?.assets[0];
  assert.ok(asset);
  assert.equal(Buffer.from((await storage.get(asset.key))!.body).toString(), 'original');
  const historicalContext = {params: Promise.resolve({id: project.projectId, revisionId: saved.revision.id})};
  const historicalPath = `/api/studio/projects/${project.projectId}/revisions/${saved.revision.id}`;
  assert.equal((await revision(request(historicalPath), historicalContext)).status, 403);
  const historical = await revision(request(historicalPath, 'GET', project.token), historicalContext);
  assert.equal(historical.status, 200);
  assert.deepEqual(await historical.json(), saved.revision);
});

test('artifact downloads are private, project-scoped, uncached attachments with exact bytes', async t => {
  const storage = await setup(t);
  const project = await newProject();
  const other = await newProject();
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const artifact = {id: 'fixture-image', name: 'preview "image".png', key: `projects/${project.projectId}/artifacts/fixture-image.png`, contentType: 'image/png', bytes: bytes.length, sha256: 'fixture-metadata'};
  await storage.put(artifact.key, bytes);
  await writeJson(storage, `projects/${project.projectId}/jobs/fixture-job.json`, {id: 'fixture-job', projectId: project.projectId, revisionId: project.revisionId, kind: 'render', selection: 'default', status: 'completed', createdAt: '2025-01-15T12:00:00.000Z', updatedAt: '2025-01-15T12:00:00.000Z', progress: 'Done', artifacts: [artifact]});
  const path = `/api/studio/projects/${project.projectId}/artifacts/${artifact.id}`;
  const target = (id = project.projectId) => ({params: Promise.resolve({id, artifactId: artifact.id})});
  assert.equal((await download(request(path), target())).status, 403);
  assert.equal((await download(request(path, 'GET', other.token), target())).status, 403);
  assert.equal((await download(request(path, 'GET', other.token), target(other.projectId))).status, 404);
  const response = await download(request(path, 'GET', project.token), target());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), '8');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="preview__image_.png"');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('creation keys and cross-origin guards reject writes without creating projects', async t => {
  const storage = await setup(t);
  process.env.STUDIO_CREATE_KEY = 'personal-workspace-key';
  assert.equal((await create(request('/api/v1/projects', 'POST', undefined, source))).status, 403);
  assert.equal((await create(request('/api/v1/projects', 'POST', undefined, source, {'X-Studio-Key': 'wrong'}))).status, 403);
  assert.equal((await create(request('/api/v1/projects', 'POST', undefined, source, {'X-Studio-Key': 'personal-workspace-key', Origin: 'https://untrusted.example'}))).status, 403);
  assert.deepEqual(await storage.list('projects/'), []);
  const allowed = await create(request('/api/v1/projects', 'POST', undefined, source, {'X-Studio-Key': 'personal-workspace-key'}));
  assert.equal(allowed.status, 201);
  const created = await allowed.json() as Created;
  assert.equal((await get(request(`/api/v1/projects/${created.projectId}`, 'GET', created.token), context(created.projectId))).status, 200);
});
