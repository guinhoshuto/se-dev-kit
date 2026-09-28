import {after} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Folders a test file asks for, removed when that file's tests end. The test runner also fails a
// suite that leaves anything in its temporary folder (scripts/run-tests.mjs).
const created: string[] = [];
after(() => Promise.all(created.splice(0).map(directory => rm(directory, {recursive: true, force: true}))));

export async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}
