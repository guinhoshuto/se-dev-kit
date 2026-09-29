import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

/** The build a deployment runs, as `GET /api/v1/version` answers it. */
export interface DeployedBuild {version: string; commit: string | null; dirty: boolean | null}

/**
 * Reads the dist/build-info.json that scripts/copy-assets.mjs wrote during this deployment's build
 * (on Vercel from VERCEL_GIT_COMMIT_SHA). next.config.mjs traces dist/ into every function, and
 * `npm run verify:bundle` checks that the version route has the file. Strict: a missing file or a
 * malformed field throws instead of guessing a commit.
 */
export async function deployedBuild(path = resolve(process.cwd(), 'dist', 'build-info.json')): Promise<DeployedBuild> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> | null;
  const {version, commit, dirty} = raw ?? {};
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) throw new Error('build-info.json has no version.');
  if (commit !== null && (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))) throw new Error('build-info.json has an invalid commit.');
  if (dirty !== null && typeof dirty !== 'boolean') throw new Error('build-info.json has an invalid dirty flag.');
  return {version, commit, dirty};
}
