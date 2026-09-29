// GET /api/v1/version: the deployed dist/build-info.json, which verify-hosted --wait-for polls.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GET} from '../../app/api/v1/version/route';
import {deployedBuild} from '../../lib/build-info';

const version = () => GET(new Request('http://127.0.0.1:3000/api/v1/version'));

test('GET /api/v1/version answers the built dist/build-info.json, uncached and without a capability', async () => {
  const built = JSON.parse(await readFile('dist/build-info.json', 'utf8'));
  const response = await version();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {schemaVersion: 1, version: built.version, commit: built.commit, dirty: built.dirty});
});

test('without dist/build-info.json the version route answers 503 instead of guessing', async t => {
  const cwd = process.cwd();
  const empty = await mkdtemp(join(tmpdir(), 'sws-version-'));
  process.chdir(empty);
  t.after(async () => {process.chdir(cwd); await rm(empty, {recursive: true, force: true});});
  assert.equal((await version()).status, 503);
});

test('the deployed build is read strictly: a short or missing commit, a non-boolean dirty or no version is refused', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'sws-version-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const file = join(folder, 'build-info.json');
  const commit = 'a'.repeat(40);
  await writeFile(file, JSON.stringify({version: '0.2.0', commit, dirty: false}));
  assert.deepEqual(await deployedBuild(file), {version: '0.2.0', commit, dirty: false});
  await writeFile(file, JSON.stringify({version: '0.2.0', commit: null, dirty: null}));
  assert.deepEqual(await deployedBuild(file), {version: '0.2.0', commit: null, dirty: null}, 'a build outside git names no commit');
  for (const bad of [{version: '0.2.0', commit: 'a'.repeat(39), dirty: false}, {version: '0.2.0', dirty: false}, {version: '0.2.0', commit, dirty: 'no'}, {commit, dirty: false}]) {
    await writeFile(file, JSON.stringify(bad));
    await assert.rejects(deployedBuild(file), /build-info\.json has/, JSON.stringify(bad));
  }
  await assert.rejects(deployedBuild(join(folder, 'missing.json')), /ENOENT/);
});
