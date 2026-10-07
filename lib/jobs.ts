import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve, relative, extname} from 'node:path';
import type {Artifact, Job, ObjectStore, Revision} from './model';
import {materializeSnapshot, relocateProject} from './materialize';
import {getStore, mutateJson, readJson} from './storage';
import {buildJobFontPackage, canonicalNeedsFonts, lockForRevision, resolveMissingFonts, staticGoogleFontUrls, type JobFontPackage, type ResolveGoogleFontOptions} from './fonts';
import {FONT_CACHE_EPOCH, GOOGLE_FONTS_UA, familiesFromUrl} from '../src/runtime/google-fonts-url';
import {artifactLimits, jobBudgetMs} from './limits';

/** Trusted deployment folders copied into every offline Sandbox; next.config.mjs must trace the same folders. */
export const SANDBOX_ENGINE_FOLDERS = ['dist', 'presets', 'sample-media'] as const;
const REMOTE_ROOT = '/vercel/sandbox/studio';
const REMOTE_JOB = `${REMOTE_ROOT}/job`;
/** Passes a job may run: the first, plus up to three that refill Google Fonts it discovered. */
export const FONT_MAX_PASSES = 4;
/** Job time a further pass needs (Chromium boot, the scene, one poll); with less left the job fails. */
export const FONT_PASS_MIN_MS = 60_000;
interface WorkerResult {ok: boolean; artifacts: {name: string; bytes: number; sha256: string}[]; progress: string; error?: string; pass?: number; needsFonts?: unknown}
const jobKey = (job: Pick<Job, 'projectId' | 'id'>) => `projects/${job.projectId}/jobs/${job.id}.json`;
const contentTypes: Record<string, string> = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webm': 'video/webm', '.mp4': 'video/mp4', '.json': 'application/json'};
const terminalStatuses = new Set<Job['status']>(['completed', 'failed', 'cancelled']);
type JobPatch = Partial<Pick<Job, 'status' | 'progress' | 'artifacts' | 'error' | 'workflowId' | 'sandboxId' | 'commandId' | 'fontPass'>>;
export const hostedSandboxName = (jobId: string) => `sws-${jobId}`;

/** Upstream injection for tests (fake Google). Production passes nothing. */
export type FontInjection = Pick<ResolveGoogleFontOptions, 'memory' | 'lookup' | 'transport' | 'now' | 'budgetLimits'>;
/** The part of `@vercel/sandbox` jobs use, so tests can replace the provider. */
export interface SandboxHandle {
  writeFiles(files: {path: string; content: Uint8Array}[]): Promise<void>;
  runCommand(params: {cmd: string; args: string[]; cwd: string; env: Record<string, string>; detached: true; timeoutMs: number}): Promise<{cmdId: string}>;
  getCommand(cmdId: string): Promise<{wait(options: {signal: AbortSignal}): Promise<{exitCode: number | null; stderr(): Promise<string>}>}>;
  readFileToBuffer(file: {path: string}): Promise<Buffer | null>;
  stop(): Promise<unknown>;
}
export interface SandboxProvider {
  get(params: {name: string}): Promise<SandboxHandle>;
  getOrCreate(params: {name: string; source: {type: 'snapshot'; snapshotId: string}; networkPolicy: 'deny-all'; timeout: number; persistent: false; resources: {vcpus: number}}): Promise<SandboxHandle>;
}
/** Injection for tests. The workflow passes nothing: Blob or local storage, the real Sandbox, real Google. */
export interface JobDependencies {store?: ObjectStore; sandbox?: SandboxProvider; fonts?: FontInjection}
async function sandboxProvider(deps: JobDependencies): Promise<SandboxProvider> {
  if (deps.sandbox) return deps.sandbox;
  const {Sandbox} = await import('@vercel/sandbox');
  return Sandbox as unknown as SandboxProvider;
}

/**
 * Merge against the latest object with CAS so delayed workflow metadata cannot erase worker results.
 * The first recorded commandId is kept, except that a font refill records its new pass's command:
 * a commandId is replaced only together with a higher `fontPass`.
 */
export async function patchJob(store: ObjectStore, job: Job, patch: JobPatch): Promise<Job> {
  return mutateJson(store, jobKey(job), job, latest => {
    const advances = patch.fontPass !== undefined && patch.fontPass > (latest.fontPass ?? 1);
    const commandId = advances && patch.commandId ? patch.commandId : latest.commandId ?? patch.commandId;
    const fontPass = advances ? patch.fontPass : latest.fontPass;
    const metadata = {
      ...(latest.workflowId || patch.workflowId ? {workflowId: latest.workflowId ?? patch.workflowId} : {}),
      ...(latest.sandboxId || patch.sandboxId ? {sandboxId: latest.sandboxId ?? patch.sandboxId} : {}),
      ...(commandId ? {commandId} : {}),
      ...(fontPass !== undefined ? {fontPass} : {})
    };
    if (terminalStatuses.has(latest.status)) return {...latest, ...metadata};
    if (latest.status === 'running' && patch.status === 'queued') return {...latest, ...metadata};
    return {...latest, ...patch, ...metadata, updatedAt: new Date().toISOString()};
  });
}
/** Execution must finish within the job budget (lib/limits.ts) of job creation; reservations last one minute longer. */
export function remainingJobTime(job: Pick<Job, 'createdAt'>, now = Date.now()): number {
  const created = Date.parse(job.createdAt);
  const budget = jobBudgetMs();
  const remaining = Math.min(budget, created + budget - now);
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
  const limits = artifactLimits();
  let total = 0;
  for (const [index, item] of result.artifacts.entries()) {
    if (!item.name || item.name.includes('\\') || item.name.split('/').some(part => !part || part.startsWith('.'))) throw new Error('Unsafe artifact path.');
    total += item.bytes;
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > limits.file || total > limits.job) throw new Error('Worker artifact size limit exceeded.');
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
// Google Fonts package ------------------------------------------------------------------------

function fontNamespace(revision: Revision): {epoch: string; userAgent: string} {
  return {epoch: revision.prepared?.googleFonts?.epoch ?? FONT_CACHE_EPOCH, userAgent: revision.prepared?.googleFonts?.userAgent ?? GOOGLE_FONTS_UA};
}
/** URLs of the lock of the revision saved just before this one, if any. */
async function previousRevisionFontUrls(store: ObjectStore, revision: Revision): Promise<string[]> {
  let previous: Revision | undefined;
  for (const key of (await store.list(`projects/${revision.projectId}/revisions/`)).filter(item => item.endsWith('.json'))) {
    const candidate = await readJson<Revision>(store, key);
    if (candidate && candidate.id !== revision.id && candidate.createdAt < revision.createdAt && (!previous || candidate.createdAt > previous.createdAt)) previous = candidate;
  }
  return previous ? (await lockForRevision(store, revision.projectId, previous.id)).map(entry => entry.url) : [];
}
/**
 * The job's font package, from storage only: the revision lock, the static stylesheets, and the
 * previous revision's lock entries the cache already holds. Rebuilt for every pass, so a refill
 * adds what the last pass missed.
 */
async function jobFontPackage(store: ObjectStore, revision: Revision, fonts: FontInjection = {}): Promise<JobFontPackage> {
  const prepared = revision.prepared!;
  const staticUrls = prepared.googleFonts?.static ?? staticGoogleFontUrls(revision.snapshot, prepared);
  return buildJobFontPackage({store, projectId: revision.projectId, revisionId: revision.id, ...fontNamespace(revision),
    cachedUrls: [...staticUrls, ...await previousRevisionFontUrls(store, revision)], ...(fonts.memory ? {memory: fonts.memory} : {})});
}
/** Files of a package for pass `pass`, relative to the job directory. Objects in `skip` are already there; the lock comes last. */
function fontPackageFiles(pkg: JobFontPackage, pass: number, skip: ReadonlySet<string> = new Set()): {path: string; content: Uint8Array}[] {
  const files = [...pkg.objects].filter(([digest]) => !skip.has(digest)).map(([digest, content]) => ({path: `fonts/objects/${digest}`, content}));
  files.push({path: `fonts/lock-${pass}.json`, content: Buffer.from(JSON.stringify(pkg.lock))});
  return files;
}
async function writeFontPackage(directory: string, pkg: JobFontPackage, pass: number): Promise<void> {
  for (const file of fontPackageFiles(pkg, pass)) {
    const target = resolve(directory, file.path);
    await mkdir(dirname(target), {recursive: true});
    try { await writeFile(target, file.content, {flag: 'wx'}); }
    catch (error) { if ((error as {code?: unknown}).code !== 'EEXIST' || file.path.endsWith('.json')) throw error; }
  }
}
const fontFamilies = (url: string) => familiesFromUrl(url).map(family => `"${family.name}"`).join(', ') || (/^https:\/\/fonts\.gstatic\.com\/s\/([^/]+)\//.exec(url)?.[1] ?? 'a Google font');
/** Fails with FONT_DISCOVERY_LIMIT when no further pass may run: four passes, or too little job time left. */
function assertAnotherPass(job: Pick<Job, 'createdAt'>, pass: number, missing: readonly string[], now = Date.now()): void {
  const listed = missing.slice(0, 8).join(', ') + (missing.length > 8 ? `, and ${missing.length - 8} more` : '');
  if (pass >= FONT_MAX_PASSES) throw new Error(`FONT_DISCOVERY_LIMIT: after ${FONT_MAX_PASSES} passes the widget still requested Google Fonts outside the job package: ${listed}.`);
  const left = Date.parse(job.createdAt) + jobBudgetMs() - now;
  if (!(left >= FONT_PASS_MIN_MS)) throw new Error(`FONT_DISCOVERY_LIMIT: not enough job time is left for font pass ${pass + 1} (${Math.max(0, Math.round(left / 1000))} s). Run the job again: the fonts found so far are kept. Missing: ${listed}.`);
}
/**
 * Resolves what a discovery pass missed through the proxy (`render` bucket), into the cache and the
 * revision lock. Fails with FONT_UNAVAILABLE, naming the family, the URL and the reason, when Google
 * cannot serve a font that is not cached.
 */
async function refillFonts(store: ObjectStore, job: Job, revision: Revision, urls: readonly string[], fonts: FontInjection = {}): Promise<void> {
  const deadline = Math.min(Date.now() + 20_000, Date.parse(job.createdAt) + jobBudgetMs() - FONT_PASS_MIN_MS);
  const failures = await resolveMissingFonts(urls, {store, projectId: revision.projectId, revisionId: revision.id, ...fontNamespace(revision), deadline, ...fonts});
  if (failures.length) {
    throw new Error(`FONT_UNAVAILABLE: Google Fonts could not be loaded: ${failures.map(failure => `${fontFamilies(failure.url)} (${failure.url}): ${failure.reason}. ${failure.message}`).join('; ')} Try again later.`);
  }
}
const passProgress = (pass: number) => `Fetching Google Fonts (pass ${pass}/${FONT_MAX_PASSES}).`;
/** The worker's `needsFonts`, canonicalized and capped again: it comes from a Chromium without a sandbox. */
function discoveredFonts(result: WorkerResult): string[] {
  const urls = canonicalNeedsFonts(result.needsFonts);
  if (!urls.length) throw new Error('A font discovery pass reported no valid Google Fonts URL.');
  return urls;
}

// Local worker -------------------------------------------------------------------------------

/**
 * STUDIO_EXECUTION=local tells the worker to take the render slot, ask the machine check, keep the disk
 * guard, and skip the hosted limits. RENDER_SLOT_DIR and MACHINE_CHECK pass through, so a test's own
 * slot and machine check reach its workers (scripts/run-tests.mjs gives every suite both).
 */
export function localWorkerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {PATH: process.env.PATH, TMPDIR: tmpdir(), NODE_ENV: 'production', STUDIO_EXECUTION: 'local'};
  for (const name of ['SE_WIDGET_STUDIO_BROWSER', 'STUDIO_FFMPEG_PATH', 'STUDIO_FFPROBE_PATH', 'RENDER_SLOT_DIR', 'MACHINE_CHECK']) if (process.env[name]) environment[name] = process.env[name];
  return environment;
}
/** A worker's stdout line {"progress": "…"}, such as why it waits for the machine; anything else is no progress. */
function workerProgress(line: string): string | undefined {
  let value: unknown;
  try {value = JSON.parse(line);} catch {return undefined;}
  const progress = (value as {progress?: unknown} | null)?.progress;
  return typeof progress === 'string' && progress.trim() ? progress.trim().slice(0, 1000) : undefined;
}
async function runLocalWorker(input: string, pass: number, timeoutMs: number, onProgress: (progress: string) => Promise<unknown>): Promise<void> {
  const environment = localWorkerEnvironment();
  // One progress write at a time, all of them done before the pass ends; a failed one is only cosmetic.
  let reported: Promise<unknown> = Promise.resolve();
  try {
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, [resolve(process.cwd(), 'scripts/job-worker.mjs'), input, String(pass)], {env: environment, cwd: process.cwd(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
      let errors = '';
      let partial = '';
      child.stderr?.on('data', chunk => { errors = `${errors}${String(chunk)}`.slice(-4000); });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        const lines = `${partial}${chunk}`.split('\n');
        partial = lines.pop()!.slice(-4000);
        for (const line of lines) {
          const progress = workerProgress(line);
          if (progress) reported = reported.then(() => onProgress(progress)).catch(() => {});
        }
      });
      const timer = setTimeout(() => {
        if (child.pid) {try {process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');} catch {child.kill('SIGKILL');}}
        reject(new Error(`Job exceeded its ${Math.round(jobBudgetMs() / 60_000)} minute execution limit.`));
      }, timeoutMs);
      child.once('error', error => {clearTimeout(timer); reject(error);});
      child.once('close', code => {clearTimeout(timer); code === 0 ? done() : reject(new Error(`Worker exited with code ${code}. ${errors}`));});
    });
  } finally {
    await reported;
  }
}

/** Local mode: the same pass loop as the hosted workflow, with a subprocess instead of a Sandbox. */
export async function runJob(job: Job, revision: Revision, store: ObjectStore, deps: Pick<JobDependencies, 'fonts'> = {}): Promise<Job> {
  validateJob(job, revision);
  if (executionMode() !== 'local') throw new Error('Hosted jobs must run through the durable workflow.');
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'sws-job-')));
  let current = await patchJob(store, job, {status: 'running', progress: 'Preparing isolated browser worker.'});
  try {
    if (terminalStatuses.has(current.status)) return current;
    remainingJobTime(current);
    const project = await materializeSnapshot(revision.prepared!, store, directory);
    const input = resolve(directory, 'input.json');
    await writeFile(input, JSON.stringify({job, project, sampleMedia: revision.prepared!.sampleMedia ?? {}}), {flag: 'wx'});
    await writeFontPackage(directory, await jobFontPackage(store, revision, deps.fonts), 1);
    for (let pass = 1; ; pass++) {
      await runLocalWorker(input, pass, remainingJobTime(current), progress => patchJob(store, current, {progress}));
      const result = JSON.parse(await readFile(resolve(directory, `result-${pass}.json`), 'utf8')) as WorkerResult;
      if (result.needsFonts === undefined) {
        current = await publish(store, current, result, name => readFile(resolve(project.outputRoot, `pass-${pass}`, name)));
        break;
      }
      const missing = discoveredFonts(result);
      assertAnotherPass(current, pass, missing);
      current = await patchJob(store, current, {progress: passProgress(pass + 1), fontPass: pass + 1});
      if (terminalStatuses.has(current.status)) return current;
      await refillFonts(store, current, revision, missing, deps.fonts);
      await writeFontPackage(directory, await jobFontPackage(store, revision, deps.fonts), pass + 1);
    }
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
    if (entry.name.startsWith('.')) continue; // e.g. a local .DS_Store; nothing the worker reads is hidden.
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push({path, content: await readFile(path)});
    else throw new Error('Worker files must not contain symlinks.');
  }
  return files;
}
async function loadJob(projectId: string, id: string, deps: JobDependencies = {}) {
  const store = deps.store ?? getStore();
  const job = await readJson<Job>(store, `projects/${projectId}/jobs/${id}.json`);
  if (!job) throw new Error('Job was not found.');
  return {store, job};
}
async function loadRevision(store: ObjectStore, job: Job): Promise<Revision> {
  const revision = await readJson<Revision>(store, `projects/${job.projectId}/revisions/${job.revisionId}.json`);
  if (!revision) throw new Error('Pinned job revision was not found.');
  validateJob(job, revision);
  return revision;
}
const workerCommand = (pass: number, timeoutMs: number) => ({cmd: 'node', args: ['scripts/job-worker.mjs', `${REMOTE_JOB}/input.json`, String(pass)], cwd: REMOTE_ROOT, env: {SE_WIDGET_STUDIO_BROWSER: '/vercel/sandbox/studio/browser/chrome', STUDIO_FFMPEG_PATH: '/vercel/sandbox/studio/tools/ffmpeg', STUDIO_FFPROBE_PATH: '/vercel/sandbox/studio/tools/ffprobe'}, detached: true as const, timeoutMs});
async function writeSandboxFiles(sandbox: SandboxHandle, files: {path: string; content: Uint8Array}[]): Promise<void> {
  for (let index = 0; index < files.length; index += 16) await sandbox.writeFiles(files.slice(index, index + 16));
}

export async function launchHostedJob(projectId: string, id: string, deps: JobDependencies = {}): Promise<void> {
  if (executionMode() !== 'vercel') throw new Error('Sandbox mode is required.');
  const {store, job} = await loadJob(projectId, id, deps);
  if (job.commandId || terminalStatuses.has(job.status)) return;
  const timeoutMs = remainingJobTime(job);
  const revision = await loadRevision(store, job);
  const Sandbox = await sandboxProvider(deps);
  const name = hostedSandboxName(job.id);
  // The Sandbox never gets network access: fonts arrive as job files, answered by the worker.
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
    const project = relocateProject(local, directory, REMOTE_JOB);
    // The first pass's font package: what the revision already pinned or the cache already holds.
    await writeFontPackage(directory, await jobFontPackage(store, revision, deps.fonts), 1);
    const uploads = (await filesUnder(directory)).map(file => ({path: `${REMOTE_JOB}/${relative(directory, file.path)}`, content: file.content}));
    // Upload only trusted built engine files and the immutable widget data. Dependencies exist in the prepared snapshot.
    for (const folder of SANDBOX_ENGINE_FOLDERS) {
      for (const file of await filesUnder(resolve(process.cwd(), folder))) uploads.push({path: `${REMOTE_ROOT}/${folder}/${relative(resolve(process.cwd(), folder), file.path)}`, content: file.content});
    }
    uploads.push({path: `${REMOTE_ROOT}/scripts/job-worker.mjs`, content: await readFile(resolve(process.cwd(), 'scripts/job-worker.mjs'))});
    uploads.push({path: `${REMOTE_JOB}/input.json`, content: Buffer.from(JSON.stringify({job, project, sampleMedia: revision.prepared!.sampleMedia ?? {}}))});
    await writeSandboxFiles(sandbox, uploads);
    const ready = await readJson<Job>(store, jobKey(job));
    if (ready && terminalStatuses.has(ready.status)) {await sandbox.stop().catch(() => {}); return;}
    if (ready?.commandId) return;
    const command = await sandbox.runCommand(workerCommand(1, remainingJobTime(current)));
    await patchJob(store, current, {commandId: command.cmdId});
  } finally {
    // Workflow retries recover this deterministic Sandbox and repeat only idempotent uploads.
    // Final failure cleanup belongs to failHostedJob so transient provider errors keep the VM alive.
    await rm(directory, {recursive: true, force: true});
  }
}

export type PollOutcome = {state: 'done'} | {state: 'pending'} | {state: 'refill'; pass: number};
/**
 * Decides on whether the current pass wrote `result-<pass>.json`, not only on its command's exit
 * code: a retried step may have started a second worker for the same pass, which waits for the
 * first one's result. A result with `needsFonts` asks for a refill; any other is published.
 */
export async function pollHostedJob(projectId: string, id: string, deps: JobDependencies = {}): Promise<PollOutcome> {
  const {store, job} = await loadJob(projectId, id, deps);
  if (terminalStatuses.has(job.status)) return {state: 'done'};
  if (!job.sandboxId || !job.commandId) throw new Error('Sandbox command was not recorded.');
  const pass = job.fontPass ?? 1;
  const Sandbox = await sandboxProvider(deps);
  const sandbox = await Sandbox.get({name: job.sandboxId});
  const resultPath = `${REMOTE_JOB}/result-${pass}.json`;
  let bytes = await sandbox.readFileToBuffer({path: resultPath});
  if (!bytes) {
    const command = await sandbox.getCommand(job.commandId);
    // getCommand returns a detached-command handle whose initial exitCode remains null.
    // wait() asks the provider for current completion and is bounded so each Workflow poll stays short.
    const signal = AbortSignal.timeout(1000);
    let finished;
    try {finished = await command.wait({signal});}
    catch (error) {if (signal.aborted) return {state: 'pending'}; throw error;}
    // The worker may have finished between the two reads.
    bytes = await sandbox.readFileToBuffer({path: resultPath});
    if (!bytes && finished.exitCode !== 0) {
      const errors = await finished.stderr().catch(() => '');
      throw new Error(`Worker exited with code ${finished.exitCode}. ${errors.slice(-1500)}`);
    }
  }
  if (!bytes || bytes.length > 1024 * 1024) throw new Error('Worker did not produce a valid bounded result.');
  const result = JSON.parse(bytes.toString('utf8')) as WorkerResult;
  if (result.needsFonts !== undefined) return {state: 'refill', pass};
  await publish(store, job, result, async name => {
    const body = await sandbox.readFileToBuffer({path: `${REMOTE_JOB}/output/pass-${pass}/${name}`});
    if (!body) throw new Error('Worker artifact was not found.');
    return body;
  });
  // Keep the filesystem available while a Workflow step retries transient Blob/API failures.
  // A successful publish is immutable; terminal workflow failure is cleaned up by failHostedJob.
  await sandbox.stop().catch(() => {});
  return {state: 'done'};
}

/**
 * After a discovery pass: resolves what it missed through the proxy, uploads the new objects and
 * `lock-<pass+1>.json` to the same `deny-all` Sandbox, and starts the next pass. Idempotent: a
 * retry after the next pass was recorded exits, and one that repeats `runCommand` before it was
 * recorded starts a worker that waits for the first one's result.
 */
export async function refillHostedJob(projectId: string, id: string, pass: number, deps: JobDependencies = {}): Promise<void> {
  const {store, job} = await loadJob(projectId, id, deps);
  if (terminalStatuses.has(job.status) || (job.fontPass ?? 1) !== pass) return;
  if (!job.sandboxId) throw new Error('Sandbox was not recorded.');
  const revision = await loadRevision(store, job);
  const Sandbox = await sandboxProvider(deps);
  const sandbox = await Sandbox.get({name: job.sandboxId});
  const bytes = await sandbox.readFileToBuffer({path: `${REMOTE_JOB}/result-${pass}.json`});
  if (!bytes || bytes.length > 1024 * 1024) throw new Error('Worker did not produce a valid bounded result.');
  const missing = discoveredFonts(JSON.parse(bytes.toString('utf8')) as WorkerResult);
  assertAnotherPass(job, pass, missing);
  const current = await patchJob(store, job, {progress: passProgress(pass + 1)});
  if (terminalStatuses.has(current.status)) return;
  await refillFonts(store, current, revision, missing, deps.fonts);
  // Objects the previous lock listed are already in the Sandbox. The hint only saves uploads: the
  // worker checks every object's SHA-256, so a wrong hint can only cost a pass, never serve bytes.
  const uploaded = new Set<string>();
  const previous = await sandbox.readFileToBuffer({path: `${REMOTE_JOB}/fonts/lock-${pass}.json`}).catch(() => null);
  try { for (const entry of (JSON.parse(previous?.toString('utf8') ?? '{}') as {entries?: {sha256?: unknown}[]}).entries ?? []) if (typeof entry.sha256 === 'string') uploaded.add(entry.sha256); } catch { /* upload everything */ }
  const pkg = await jobFontPackage(store, revision, deps.fonts);
  await writeSandboxFiles(sandbox, fontPackageFiles(pkg, pass + 1, uploaded).map(file => ({path: `${REMOTE_JOB}/${file.path}`, content: file.content})));
  const ready = await readJson<Job>(store, jobKey(job));
  if (!ready || terminalStatuses.has(ready.status) || (ready.fontPass ?? 1) !== pass) return;
  const command = await sandbox.runCommand(workerCommand(pass + 1, remainingJobTime(ready)));
  await patchJob(store, ready, {fontPass: pass + 1, commandId: command.cmdId, progress: passProgress(pass + 1)});
}

export async function failHostedJob(projectId: string, id: string, error: string, deps: JobDependencies = {}): Promise<void> {
  const {store, job} = await loadJob(projectId, id, deps);
  const Sandbox = await sandboxProvider(deps);
  // The deterministic name also covers a create/metadata-write failure that left no sandboxId.
  const sandbox = await Sandbox.get({name: job.sandboxId ?? hostedSandboxName(job.id)}).catch(() => undefined);
  await sandbox?.stop().catch(() => {});
  await patchJob(store, job, {status: 'failed', progress: 'Job failed.', error: error.slice(0, 2000)});
}
