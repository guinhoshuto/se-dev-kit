import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, relative, extname} from 'node:path';
import type {Artifact, Job, ObjectStore, Revision} from './model';
import {materializeSnapshot, relocateProject} from './materialize';
import {getStore, mutateJson, readJson} from './storage';

const MAX_JOB_MS = 10 * 60_000;
const REMOTE_ROOT = '/vercel/sandbox/studio';
interface WorkerResult {ok: boolean; artifacts: {name: string; bytes: number; sha256: string}[]; progress: string; error?: string}
const jobKey = (job: Pick<Job, 'projectId' | 'id'>) => `projects/${job.projectId}/jobs/${job.id}.json`;
const contentTypes: Record<string, string> = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webm': 'video/webm', '.mp4': 'video/mp4', '.json': 'application/json'};
const terminalStatuses = new Set<Job['status']>(['completed', 'failed', 'cancelled']);
type JobPatch = Partial<Pick<Job, 'status' | 'progress' | 'artifacts' | 'error' | 'workflowId' | 'sandboxId' | 'commandId'>>;
export const hostedSandboxName = (jobId: string) => `sws-${jobId}`;
/** Merge against the latest object with CAS so delayed workflow metadata cannot erase worker results. */
export async function patchJob(store: ObjectStore, job: Job, patch: JobPatch): Promise<Job> {
  return mutateJson(store, jobKey(job), job, latest => {
    const metadata = {
      ...(latest.workflowId || patch.workflowId ? {workflowId: latest.workflowId ?? patch.workflowId} : {}),
      ...(latest.sandboxId || patch.sandboxId ? {sandboxId: latest.sandboxId ?? patch.sandboxId} : {}),
      ...(latest.commandId || patch.commandId ? {commandId: latest.commandId ?? patch.commandId} : {})
    };
    if (terminalStatuses.has(latest.status)) return {...latest, ...metadata};
    if (latest.status === 'running' && patch.status === 'queued') return {...latest, ...metadata};
    return {...latest, ...patch, ...metadata, updatedAt: new Date().toISOString()};
  });
}
/** Reservations last eleven minutes; execution must finish within ten minutes of job creation. */
export function remainingJobTime(job: Pick<Job, 'createdAt'>, now = Date.now()): number {
  const created = Date.parse(job.createdAt);
  const remaining = Math.min(MAX_JOB_MS, created + MAX_JOB_MS - now);
  if (!Number.isFinite(remaining) || remaining < 30_000) throw new Error('This job has less than 30 seconds left in its execution budget. Create a new job.');
  return remaining;
}
export function executionMode(): 'local' | 'vercel' {
  const mode = process.env.STUDIO_EXECUTION ?? (process.env.VERCEL ? 'vercel' : 'local');
  if (mode !== 'local' && mode !== 'vercel') throw new Error('STUDIO_EXECUTION must be local or vercel.');
  if (process.env.VERCEL && mode !== 'vercel') throw new Error('Vercel deployments require Sandbox execution; local workers are not supported.');
  if (mode === 'vercel' && !process.env.STUDIO_SANDBOX_SNAPSHOT_ID) throw new Error('STUDIO_SANDBOX_SNAPSHOT_ID is required. Prepare a trusted browser/media snapshot before submitting jobs.');
  return mode;
}
function validateJob(job: Job, revision: Revision) {
  if (revision.status !== 'ready' || !revision.prepared) throw new Error('The revision must finish preparation before running a job.');
  if (job.revisionId !== revision.id || job.projectId !== revision.projectId) throw new Error('Job revision does not match its immutable snapshot.');
}
export async function startJob(job: Job, revision: Revision, store: ObjectStore): Promise<Job> {
  validateJob(job, revision);
  const mode = executionMode();
  if (mode === 'local') {
    // Local mode requires a persistent Node process; Vercel never uses this branch.
    void runJob(job, revision, store).catch(async error => { await patchJob(store, job, {status: 'failed', error: error instanceof Error ? error.message : String(error), progress: 'Job failed.'}).catch(() => {}); });
    return job;
  }
  const {start} = await import('workflow/api');
  const {renderWorkflow} = await import('../workflows/render');
  const run = await start(renderWorkflow, [job.projectId, job.id]);
  // Do not replace a job already advanced by the workflow while start() was returning.
  const latest = await readJson<Job>(store, jobKey(job));
  return patchJob(store, latest ?? job, {workflowId: run.runId});
}
async function publish(store: ObjectStore, job: Job, result: WorkerResult, read: (name: string) => Promise<Uint8Array>): Promise<Job> {
  if (!Array.isArray(result.artifacts) || result.artifacts.length > 256) throw new Error('Invalid worker artifact list.');
  const artifacts: Artifact[] = [];
  let total = 0;
  for (const [index, item] of result.artifacts.entries()) {
    if (!item.name || item.name.includes('\\') || item.name.split('/').some(part => !part || part.startsWith('.'))) throw new Error('Unsafe artifact path.');
    total += item.bytes;
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 100 * 1024 * 1024 || total > 250 * 1024 * 1024) throw new Error('Worker artifact size limit exceeded.');
    const body = await read(item.name);
    if (body.byteLength !== item.bytes || createHash('sha256').update(body).digest('hex') !== item.sha256) throw new Error('Worker artifact integrity check failed.');
    const key = `projects/${job.projectId}/artifacts/${job.id}/${item.name}`;
    const contentType = contentTypes[extname(item.name)] ?? 'application/octet-stream';
    const existing = await store.get(key);
    if (existing) {
      if (createHash('sha256').update(existing.body).digest('hex') !== item.sha256) throw new Error('An existing immutable artifact has a different digest.');
    } else await store.put(key, body, {contentType});
    artifacts.push({id: `${job.id}--${index}`, name: item.name, key, contentType, bytes: item.bytes, sha256: item.sha256});
  }
  return patchJob(store, job, {status: result.ok ? 'completed' : 'failed', progress: result.progress, artifacts, ...(result.error ? {error: result.error} : {})});
}
export async function runJob(job: Job, revision: Revision, store: ObjectStore): Promise<Job> {
  validateJob(job, revision);
  if (executionMode() !== 'local') throw new Error('Hosted jobs must run through the durable workflow.');
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'sws-job-')));
  let current = await patchJob(store, job, {status: 'running', progress: 'Preparing isolated browser worker.'});
  try {
    if (terminalStatuses.has(current.status)) return current;
    remainingJobTime(current);
    const project = await materializeSnapshot(revision.prepared!, store, directory);
    const input = resolve(directory, 'input.json');
    const resultFile = resolve(directory, 'result.json');
    await writeFile(input, JSON.stringify({job, project}), {flag: 'wx'});
    const environment: NodeJS.ProcessEnv = {PATH: process.env.PATH, TMPDIR: tmpdir(), NODE_ENV: 'production'};
    for (const name of ['SE_WIDGET_STUDIO_BROWSER', 'STUDIO_FFMPEG_PATH', 'STUDIO_FFPROBE_PATH']) if (process.env[name]) environment[name] = process.env[name];
    const timeoutMs = remainingJobTime(current);
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, [resolve(process.cwd(), 'scripts/job-worker.mjs'), input, resultFile], {env: environment, cwd: process.cwd(), detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe']});
      let errors = '';
      child.stderr?.on('data', chunk => { errors = `${errors}${String(chunk)}`.slice(-4000); });
      const timer = setTimeout(() => {
        if (child.pid) {try {process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');} catch {child.kill('SIGKILL');}}
        reject(new Error('Job exceeded the 10 minute execution limit.'));
      }, timeoutMs);
      child.once('error', error => {clearTimeout(timer); reject(error);});
      child.once('close', code => {clearTimeout(timer); code === 0 ? done() : reject(new Error(`Worker exited with code ${code}. ${errors}`));});
    });
    const result = JSON.parse(await readFile(resultFile, 'utf8')) as WorkerResult;
    current = await publish(store, current, result, name => readFile(resolve(project.outputRoot, name)));
  } catch (error) {
    current = await patchJob(store, current, {status: 'failed', progress: 'Job failed.', error: error instanceof Error ? error.message : String(error)});
  } finally {
    // Only this exact mkdtemp-owned directory is removed. Consumer/output directories are never cleaned.
    await rm(directory, {recursive: true, force: true});
  }
  return current;
}

async function filesUnder(directory: string): Promise<{path: string; content: Buffer}[]> {
  const files: {path: string; content: Buffer}[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push({path, content: await readFile(path)});
    else throw new Error('Worker files must not contain symlinks.');
  }
  return files;
}
async function loadJob(projectId: string, id: string) {
  const store = getStore();
  const job = await readJson<Job>(store, `projects/${projectId}/jobs/${id}.json`);
  if (!job) throw new Error('Job was not found.');
  return {store, job};
}
export async function launchHostedJob(projectId: string, id: string): Promise<void> {
  if (executionMode() !== 'vercel') throw new Error('Sandbox mode is required.');
  const {store, job} = await loadJob(projectId, id);
  if (job.commandId || terminalStatuses.has(job.status)) return;
  const timeoutMs = remainingJobTime(job);
  const revision = await readJson<Revision>(store, `projects/${projectId}/revisions/${job.revisionId}.json`);
  if (!revision) throw new Error('Pinned job revision was not found.');
  validateJob(job, revision);
  const {Sandbox} = await import('@vercel/sandbox');
  const name = hostedSandboxName(job.id);
  const sandbox = job.sandboxId
    ? await Sandbox.get({name: job.sandboxId})
    : await Sandbox.getOrCreate({name, source: {type: 'snapshot', snapshotId: process.env.STUDIO_SANDBOX_SNAPSHOT_ID!}, networkPolicy: 'deny-all', timeout: timeoutMs, persistent: false, resources: {vcpus: 2}});
  // A retry may have recorded its command while the provider lookup was in flight.
  const latest = await readJson<Job>(store, jobKey(job));
  if (latest?.commandId || (latest && terminalStatuses.has(latest.status))) {
    if (terminalStatuses.has(latest.status)) await sandbox.stop().catch(() => {});
    return;
  }
  const current = await patchJob(store, latest ?? job, {status: 'running', progress: 'Running the pinned revision in an offline Sandbox.', sandboxId: name});
  if (terminalStatuses.has(current.status)) {await sandbox.stop().catch(() => {}); return;}
  if (current.commandId) return;
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'sws-transfer-')));
  try {
    const local = await materializeSnapshot(revision.prepared!, store, directory);
    const remoteJob = `${REMOTE_ROOT}/job`;
    const project = relocateProject(local, directory, remoteJob);
    const uploads = (await filesUnder(directory)).map(file => ({path: `${remoteJob}/${relative(directory, file.path)}`, content: file.content}));
    // Upload only trusted built engine files and the immutable widget data. Dependencies exist in the prepared snapshot.
    for (const folder of ['dist', 'presets']) {
      for (const file of await filesUnder(resolve(process.cwd(), folder))) uploads.push({path: `${REMOTE_ROOT}/${folder}/${relative(resolve(process.cwd(), folder), file.path)}`, content: file.content});
    }
    uploads.push({path: `${REMOTE_ROOT}/scripts/job-worker.mjs`, content: await readFile(resolve(process.cwd(), 'scripts/job-worker.mjs'))});
    uploads.push({path: `${remoteJob}/input.json`, content: Buffer.from(JSON.stringify({job, project}))});
    for (let index = 0; index < uploads.length; index += 16) await sandbox.writeFiles(uploads.slice(index, index + 16));
    const ready = await readJson<Job>(store, jobKey(job));
    if (ready && terminalStatuses.has(ready.status)) {await sandbox.stop().catch(() => {}); return;}
    if (ready?.commandId) return;
    const command = await sandbox.runCommand({cmd: 'node', args: ['scripts/job-worker.mjs', `${remoteJob}/input.json`, `${remoteJob}/result.json`], cwd: REMOTE_ROOT, env: {SE_WIDGET_STUDIO_BROWSER: '/vercel/sandbox/studio/browser/chrome', STUDIO_FFMPEG_PATH: '/vercel/sandbox/studio/tools/ffmpeg', STUDIO_FFPROBE_PATH: '/vercel/sandbox/studio/tools/ffprobe'}, detached: true, timeoutMs: remainingJobTime(current)});
    await patchJob(store, current, {commandId: command.cmdId});
  } finally {
    // Workflow retries recover this deterministic Sandbox and repeat only idempotent uploads.
    // Final failure cleanup belongs to failHostedJob so transient provider errors keep the VM alive.
    await rm(directory, {recursive: true, force: true});
  }
}
export async function pollHostedJob(projectId: string, id: string): Promise<boolean> {
  const {store, job} = await loadJob(projectId, id);
  if (['completed', 'failed', 'cancelled'].includes(job.status)) return true;
  if (!job.sandboxId || !job.commandId) throw new Error('Sandbox command was not recorded.');
  const {Sandbox} = await import('@vercel/sandbox');
  const sandbox = await Sandbox.get({name: job.sandboxId});
  const command = await sandbox.getCommand(job.commandId);
  // getCommand returns a detached-command handle whose initial exitCode remains null.
  // wait() asks the provider for current completion and is bounded so each Workflow poll stays short.
  const signal = AbortSignal.timeout(1000);
  let finished;
  try {finished = await command.wait({signal});}
  catch (error) {if (signal.aborted) return false; throw error;}
  if (finished.exitCode !== 0) {
    const errors = await finished.stderr().catch(() => '');
    throw new Error(`Worker exited with code ${finished.exitCode}. ${errors.slice(-1500)}`);
  }
  const bytes = await sandbox.readFileToBuffer({path: `${REMOTE_ROOT}/job/result.json`});
  if (!bytes || bytes.length > 1024 * 1024) throw new Error('Worker did not produce a valid bounded result.');
  const result = JSON.parse(bytes.toString('utf8')) as WorkerResult;
  await publish(store, job, result, async name => {
    const body = await sandbox.readFileToBuffer({path: `${REMOTE_ROOT}/job/output/${name}`});
    if (!body) throw new Error('Worker artifact was not found.');
    return body;
  });
  // Keep the filesystem available while a Workflow step retries transient Blob/API failures.
  // A successful publish is immutable; terminal workflow failure is cleaned up by failHostedJob.
  await sandbox.stop().catch(() => {});
  return true;
}
export async function failHostedJob(projectId: string, id: string, error: string): Promise<void> {
  const {store, job} = await loadJob(projectId, id);
  const {Sandbox} = await import('@vercel/sandbox');
  // The deterministic name also covers a create/metadata-write failure that left no sandboxId.
  const sandbox = await Sandbox.get({name: job.sandboxId ?? hostedSandboxName(job.id)}).catch(() => undefined);
  await sandbox?.stop().catch(() => {});
  await patchJob(store, job, {status: 'failed', progress: 'Job failed.', error: error.slice(0, 2000)});
}
