#!/usr/bin/env node
/**
 * Post-build check that every consumer of the built-in sample media receives the files the
 * manifest lists: the traced Next.js functions that import, preview, or upload them to the
 * Sandbox, and the npm package used by the local CLI. Run after `npm run build`.
 */
import {execFile} from 'node:child_process';
import {access, readFile} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'sample-media/manifest.json'), 'utf8'));
const required = ['sample-media/manifest.json', ...manifest.items.map(item => `sample-media/${item.file}`)];

// Functions that read sample-media at runtime: the capability probe, create/replace import, interactive
// preview, and the workflow step that uploads engine folders to the offline Sandbox.
const functions = [
  'app/api/v1/sample-media/route',
  'app/api/v1/projects/route',
  'app/api/v1/projects/[id]/route',
  'app/api/studio/projects/[id]/preview/route',
  'app/api/studio/projects/[id]/jobs/route',
  'app/.well-known/workflow/v1/step/route'
];

const failures = [];
for (const name of functions) {
  const nftPath = resolve(root, '.next/server', `${name}.js.nft.json`);
  try {
    await access(nftPath);
  } catch {
    failures.push(`${name}: trace file is missing; run npm run build first.`);
    continue;
  }
  const {files} = JSON.parse(await readFile(nftPath, 'utf8'));
  const traced = new Set(files.map(file => relative(root, resolve(dirname(nftPath), file)).split(sep).join('/')));
  const missing = required.filter(file => !traced.has(file));
  if (missing.length) failures.push(`${name}: ${missing.length} sample-media file(s) not traced, for example ${missing[0]}.`);
}

const {stdout} = await exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {cwd: root, maxBuffer: 16 * 1024 * 1024});
const packed = new Set(JSON.parse(stdout)[0].files.map(file => file.path));
const unpacked = required.filter(file => !packed.has(file));
if (unpacked.length) failures.push(`npm package: ${unpacked.length} sample-media file(s) missing, for example ${unpacked[0]}.`);

if (failures.length) {
  console.error(`Sample media bundle check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Sample media bundle check passed: ${required.length} files traced into ${functions.length} functions and present in the npm package.`);
