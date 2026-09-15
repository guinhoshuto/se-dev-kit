import {createHash} from 'node:crypto';
import {mkdir, realpath, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {normalizeFields} from '../src/config/fields';
import {STUDIO_VERSION} from '../src/version';
import type {CatalogItem, ResolvedProject} from '../src/types';
import type {ObjectStore, PreparedSnapshot} from './model';

const RESERVED = new Set(['widget.html', 'widget.css', 'widget.js', 'fields.json']);
export function safeAssetPath(path: string): string {
  if (!path || path.length > 512 || path.includes('\\') || /[\u0000-\u001f:*?\[\]{}]/u.test(path) ||
    path.split('/').some(part => !part || part.startsWith('.')) || RESERVED.has(path) || path.startsWith('catalog/')) {
    throw new Error('Asset path must be a safe relative path and must not replace a production or catalog file.');
  }
  return path;
}

/** Materializes only the derived immutable snapshot in a newly owned job directory. */
export async function materializeSnapshot(prepared: PreparedSnapshot, store: ObjectStore, directory: string): Promise<ResolvedProject> {
  await mkdir(resolve(directory, 'widget'), {recursive: true});
  // The engine allowlist compares real paths; macOS temporary paths can begin
  // with /var even though their canonical location begins with /private/var.
  const jobDirectory = await realpath(directory);
  const root = await realpath(resolve(jobDirectory, 'widget'));
  const snapshot = prepared.snapshot;
  const relativeFiles = {html: 'widget.html', css: 'widget.css', js: 'widget.js', fields: 'fields.json'};
  const files = {html: resolve(root, relativeFiles.html), css: resolve(root, relativeFiles.css), js: resolve(root, relativeFiles.js), fields: resolve(root, relativeFiles.fields)};
  await Promise.all([
    writeFile(files.html, snapshot.widget.html, {flag: 'wx'}),
    writeFile(files.css, snapshot.widget.css, {flag: 'wx'}),
    writeFile(files.js, snapshot.widget.js, {flag: 'wx'}),
    writeFile(files.fields, JSON.stringify(snapshot.widget.fields), {flag: 'wx'})
  ]);
  const seen = new Set<string>();
  let totalBytes = 0;
  if (prepared.assets.length > 256) throw new Error('A revision may contain at most 256 assets.');
  for (const asset of prepared.assets) {
    const path = safeAssetPath(asset.path);
    if (seen.has(path)) throw new Error('Duplicate prepared asset path.');
    seen.add(path);
    totalBytes += asset.bytes;
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || totalBytes > 100 * 1024 * 1024) throw new Error('Prepared asset size limit exceeded.');
    const stored = await store.get(asset.key);
    if (!stored || stored.body.byteLength !== asset.bytes || createHash('sha256').update(stored.body).digest('hex') !== asset.sha256) {
      throw new Error(`Prepared asset integrity check failed: ${path}`);
    }
    const target = resolve(root, path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, stored.body, {flag: 'wx'});
  }
  async function catalog<T extends {id: string}>(kind: string, values: T[]): Promise<CatalogItem<T>[]> {
    await mkdir(resolve(root, 'catalog', kind), {recursive: true});
    return Promise.all(values.map(async (value, index) => {
      const filePath = resolve(root, 'catalog', kind, `${index}.json`);
      await writeFile(filePath, JSON.stringify(value), {flag: 'wx'});
      return {id: value.id, filePath, value};
    }));
  }
  const {fields, defaults} = normalizeFields(snapshot.widget.fields);
  return {
    packageVersion: STUDIO_VERSION, inputDirectory: root, configDirectory: root, widgetRoot: root,
    outputRoot: resolve(jobDirectory, 'output'), files, relativeFiles, fields, fieldDefaults: defaults, rawFields: snapshot.widget.fields,
    config: {schemaVersion: 1, widget: {root: '.', files: relativeFiles, assets: [...seen], viewport: snapshot.widget.viewport, ...(snapshot.widget.ready ? {ready: snapshot.widget.ready} : {})}, channel: snapshot.channel, output: {root: '../output'}},
    themes: await catalog('themes', snapshot.themes), fixtures: await catalog('fixtures', snapshot.fixtures),
    scenes: await catalog('scenes', snapshot.scenes), scenarios: await catalog('scenarios', snapshot.scenarios), recipes: await catalog('recipes', snapshot.recipes)
  };
}

/** Relocation is limited to the known path-bearing fields, never arbitrary submitted strings. */
export function relocateProject(project: ResolvedProject, original: string, destination: string): ResolvedProject {
  const path = (value: string) => {
    if (!value.startsWith(`${original}/`)) throw new Error('Worker path escaped its job directory.');
    return `${destination}/${value.slice(original.length + 1)}`;
  };
  const catalogs = <T>(values: CatalogItem<T>[]) => values.map(item => ({...item, filePath: path(item.filePath)}));
  return {...project, inputDirectory: path(project.inputDirectory), configDirectory: path(project.configDirectory), widgetRoot: path(project.widgetRoot), outputRoot: path(project.outputRoot),
    files: {html: path(project.files.html), css: path(project.files.css), js: path(project.files.js), fields: path(project.files.fields)},
    themes: catalogs(project.themes), fixtures: catalogs(project.fixtures), scenes: catalogs(project.scenes), scenarios: catalogs(project.scenarios), recipes: catalogs(project.recipes)};
}
