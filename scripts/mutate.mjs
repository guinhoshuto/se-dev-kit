#!/usr/bin/env node
/**
 * Proves that a test catches a change: swaps one literal in a file, runs the named test file with a
 * bounded runner, and puts the file back byte for byte. A mutation the test does not notice survived.
 * Nothing a run starts outlives it: when mutate dies or the watchdog fires, a leash kills the whole tree.
 *
 *   npm run mutate -- <file> --from <old> --to <new> --test <test-file> [--name <pattern>] [--occurrences <n>]
 *   npm run mutate -- --plan <mutations.json>
 *   either form: [--timeout <ms>] [--allow-live-checkout]
 *
 * A plan is JSON, so code with quotes, `$` or backticks needs no shell quoting: an array of
 * {file, from, to, test, name?, occurrences?}, or {"mutations": [...]}. Paths are relative to the
 * checkout. `from` must occur exactly `occurrences` times (default 1) and every occurrence is swapped.
 *
 * A test under tests/integration starts Chrome, so a run with one passes the test runner's gate for a
 * browser suite (scripts/run-tests.mjs): it takes the machine-wide render slot without waiting, asks
 * the machine check, and holds the slot until its last test ends; the tests inherit it
 * (RENDER_SLOT_HELD). A held slot or a busy machine stops the run before any test or mutation.
 *
 * Exit codes: 0 every mutation was killed; 1 at least one survived; 2 usage or setup error, or no free
 * machine for a test that starts Chrome (nothing was judged and every file is back); 3 a file could
 * not be put back (the backup path is printed).
 */
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, rmSync, writeFileSync} from 'node:fs';
import {lstat, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {SUITES, gate, takeBrowserSlot} from './run-tests.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXIT = {killed: 0, survived: 1, usage: 2, restore: 3};
const DEFAULT_TIMEOUT_MS = 60_000;
const KEYS = ['file', 'from', 'to', 'test', 'name', 'occurrences'];

export class UsageError extends Error {}
export class RestoreError extends Error {}
const usage = (condition, message) => {if (!condition) throw new UsageError(message);};

const HELP = `Usage: npm run mutate -- <file> --from <old> --to <new> --test <test-file> [--name <pattern>] [--occurrences <n>]
       npm run mutate -- --plan <mutations.json>
Options: --timeout <ms>      per-test timeout (--test-timeout), default ${DEFAULT_TIMEOUT_MS}; a run is killed after 3x + 30 s
         --allow-live-checkout  allow src/ and skills/ mutations outside a linked worktree (in the main checkout,
                                dist/, rebuilt from src/, and skills/ are live for every agent session)

Swaps a literal (split/join, so $ patterns stay literal), checks the swap landed, rebuilds dist/ when the
file is under src/, runs the test file with --test-timeout and --test-force-exit ([browser] tests skipped),
and restores the file, checked byte for byte, and git diff. The named test must be green before the swap.
A mutation is killed when the run is not green: a failure, a cancellation (a timeout), a crash or a hang.
A test under tests/integration starts Chrome: the run then holds the render slot, taken without waiting,
once the machine check says the machine is free, as a browser suite of npm test does; otherwise it stops
before anything runs.
A plan is a JSON array of {file, from, to, test, name?, occurrences?}, or {"mutations": [...]}.
Exit codes: 0 all killed, 1 some survived, 2 usage or setup error or no free machine, 3 a file could not be restored.`;

export function parseArgs(args) {
  const options = {timeoutMs: DEFAULT_TIMEOUT_MS, allowLiveCheckout: false};
  const values = {'--from': 'from', '--to': 'to', '--test': 'test', '--name': 'name', '--occurrences': 'occurrences', '--plan': 'plan', '--timeout': 'timeout'};
  const given = {}; const positional = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--allow-live-checkout') options.allowLiveCheckout = true;
    else if (Object.hasOwn(values, arg)) {
      // The value is taken as is, even when it starts with "--": code to mutate often does.
      usage(index + 1 < args.length, `${arg} requires a value.`);
      usage(!Object.hasOwn(given, values[arg]), `${arg} may only appear once.`);
      given[values[arg]] = args[++index];
    } else if (arg.startsWith('--')) throw new UsageError(`Unknown option ${arg}. Run with --help.`);
    else positional.push(arg);
  }
  if (options.help) return options;
  if (given.timeout !== undefined) {
    options.timeoutMs = Number(given.timeout);
    usage(Number.isInteger(options.timeoutMs) && options.timeoutMs >= 1000 && options.timeoutMs <= 600_000, '--timeout takes milliseconds from 1000 to 600000.');
  }
  if (given.plan !== undefined) {
    usage(!positional.length && ['from', 'to', 'test', 'name', 'occurrences'].every(key => given[key] === undefined), '--plan takes every mutation from the file: drop <file>, --from, --to, --test, --name and --occurrences.');
    options.planPath = given.plan;
    return options;
  }
  usage(positional.length === 1, 'Name exactly one file to mutate, or pass --plan <mutations.json>.');
  usage(given.from !== undefined && given.to !== undefined && given.test !== undefined, '--from, --to and --test are required with a file.');
  options.mutations = [{file: positional[0], from: given.from, to: given.to, test: given.test, name: given.name, occurrences: given.occurrences === undefined ? undefined : Number(given.occurrences)}];
  return options;
}

/** A literal swap with split/join: `$$`, `$&` and friends in `to` stay literal, where String.replace expands them. */
export function applySwap(text, from, to, occurrences = 1) {
  const parts = text.split(from);
  usage(parts.length - 1 === occurrences, `"from" occurs ${parts.length - 1} time(s), expected ${occurrences}.`);
  return parts.join(to);
}

async function inside(root, value, label) {
  usage(typeof value === 'string' && value.length > 0, `${label} must be a path.`);
  const path = relative(root, resolve(root, value));
  usage(path && !path.startsWith('..') && !isAbsolute(path), `${label} must be inside ${root}.`);
  let info;
  try {info = await lstat(resolve(root, path));} catch {throw new UsageError(`${label} does not exist: ${path}.`);}
  usage(info.isFile(), `${label} must be a regular file, not a link or a folder: ${path}.`);
  return path.split(sep).join('/');
}

export async function checkMutation(raw, index, root) {
  const where = `Mutation ${index + 1}`;
  usage(raw !== null && typeof raw === 'object' && !Array.isArray(raw), `${where} must be an object.`);
  const unknown = Object.keys(raw).filter(key => !KEYS.includes(key));
  usage(!unknown.length, `${where} has unknown keys: ${unknown.join(', ')}.`);
  usage(typeof raw.from === 'string' && raw.from.length > 0, `${where}: "from" must be non-empty text.`);
  usage(typeof raw.to === 'string' && raw.to !== raw.from, `${where}: "to" must be text that differs from "from".`);
  usage(raw.name === undefined || (typeof raw.name === 'string' && raw.name.length > 0), `${where}: "name" must be a test name pattern.`);
  const occurrences = raw.occurrences ?? 1;
  usage(Number.isInteger(occurrences) && occurrences >= 1, `${where}: "occurrences" must be a positive integer.`);
  const file = await inside(root, raw.file, `${where}: "file"`);
  const test = await inside(root, raw.test, `${where}: "test"`);
  usage(/\.test\.(mjs|js|cjs|ts|mts)$/.test(test), `${where}: "test" must be a *.test.* file.`);
  return {file, from: raw.from, to: raw.to, test, name: raw.name, occurrences};
}

/** A test file of a suite whose every test starts Chrome (tests/integration); mutate skips the [browser] web tests. */
export const opensChrome = test => Object.values(SUITES).some(suite => suite.browser && !suite.tagged && test.startsWith(`${suite.dir}/`));

/** The test runner's gate for a browser suite: the render slot, taken without waiting, then the machine check. */
const machineGate = () => gate({take: () => takeBrowserSlot({command: `node scripts/mutate.mjs ${process.argv.slice(2).join(' ')}`.trim().slice(0, 200)})});

/** The spec reporter's totals and the names of the tests that failed. */
export function summarize(output) {
  const total = name => {
    const match = [...output.matchAll(new RegExp(`^ℹ ${name} (\\d+)$`, 'gm'))].at(-1);
    return match ? Number(match[1]) : undefined;
  };
  const summary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(name => [name, total(name)]));
  summary.failed = [...new Set([...output.matchAll(/^\s*✖ (.+?)(?: \([\d.]+ms\))?$/gm)].map(match => match[1]).filter(name => name !== 'failing tests:'))].slice(0, 5);
  return summary;
}

/** Green means: a test passed, none failed or was cancelled (a timeout), node exited 0 and no watchdog fired. */
export const isGreen = run => !run.timedOut && run.exitCode === 0 && run.tests > 0 && run.pass > 0 && !run.fail && !run.cancelled;

// Every run goes under a leash: a small node process that leads the run's process group and reads a pipe from mutate.
// When the pipe closes, because the watchdog closed it or because mutate died in any way (SIGKILL included, as an
// outer mutate's watchdog kills it), the leash kills every descendant, read from ps first (Playwright starts Chrome in
// a group of its own), then its group. When the run exits on its own, the leash kills what it left behind, which
// would otherwise hold the output pipe open: a descendant whose parent exits is adopted by launchd at once, so the
// leash notes the tree every 0.5 s and also kills the noted ones now parented by pid 1. A detached group alone
// outlived a mutate killed mid-hang (THB-21 in etsy-thumb-generator, where this leash comes from).
const LEASH = `
const {execFileSync, spawn} = require('node:child_process');
const run = spawn(process.argv[1], process.argv.slice(2), {stdio: ['ignore', 'inherit', 'inherit']});
const read = () => {
  let table = '';
  try {table = execFileSync('ps', ['-axo', 'pid=,ppid='], {encoding: 'utf8'});} catch {}
  const parent = new Map();
  const children = new Map();
  for (const line of table.trim().split('\\n')) {
    const [pid, ppid] = line.trim().split(/\\s+/).map(Number);
    parent.set(pid, ppid);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree = [process.pid];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i]) ?? []));
  return {parent, tree: tree.slice(1)};
};
const seen = new Set();
setInterval(() => {for (const pid of read().tree) seen.add(pid);}, 500).unref();
const reap = () => {
  const {parent, tree} = read();
  const orphans = [...seen].filter(pid => parent.get(pid) === 1);
  for (const pid of [...tree, ...orphans]) {try {process.kill(pid, 'SIGKILL');} catch {}}
};
run.on('error', error => {console.error(String(error)); process.exit(127);});
process.stdin.on('end', () => {reap(); process.kill(-process.pid, 'SIGKILL');}).resume();
run.on('exit', (code, signal) => {reap(); process.exit(code ?? (signal ? 128 : 1));});
`;
const killGroup = child => {try {process.kill(-child.pid, 'SIGKILL');} catch {try {child.kill('SIGKILL');} catch { /* already gone */ }}};
// Closing the pipe lets the leash reap the tree; the group goes by hand only if the leash does not answer.
const stop = child => {child.stdin.destroy(); setTimeout(() => killGroup(child), 2000).unref();};

/** Runs `command` under the leash; past `limitMs` the watchdog stops it and everything it started. */
export function spawnBounded(command, args, {cwd, limitMs}) {
  return new Promise((done, fail) => {
    // A nested `node --test` would otherwise talk its parent runner's protocol instead of printing.
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['-e', LEASH, command, ...args], {cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
    child.stdin.on('error', () => { /* the leash is gone */ });
    let output = ''; let timedOut = false;
    const collect = chunk => {output = (output + chunk).slice(-2_000_000);};
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    const timer = setTimeout(() => {timedOut = true; stop(child);}, limitMs);
    child.on('error', error => {clearTimeout(timer); fail(error);});
    child.on('close', (code, signal) => {clearTimeout(timer); done({exitCode: code ?? (signal ? 128 : 1), timedOut, output});});
  });
}

const tail = (output, lines = 30) => output.trimEnd().split('\n').slice(-lines).join('\n');

/** One bounded run of a test file under the leash; the watchdog stops it (Chrome too) if the runner itself hangs. */
export async function runTest({root, test, name, timeoutMs}) {
  const args = [
    ...(/\.m?ts$/.test(test) ? ['--import', 'tsx'] : []),
    '--test', '--test-reporter=spec', `--test-timeout=${timeoutMs}`, '--test-force-exit',
    '--test-skip-pattern=^\\[browser\\] ', ...(name ? [`--test-name-pattern=${name}`] : []), test
  ];
  const run = await spawnBounded(process.execPath, args, {cwd: root, limitMs: timeoutMs * 3 + 30_000});
  return {...run, ...summarize(run.output)};
}

export async function buildEngine(root) {
  const run = await spawnBounded('npm', ['run', 'build:engine'], {cwd: root, limitMs: 10 * 60_000});
  if (run.timedOut || run.exitCode !== 0) throw new UsageError(`npm run build:engine failed (exit ${run.exitCode}${run.timedOut ? ', timed out' : ''}); a mutant of src/ must still build:\n${tail(run.output)}`);
}

function gitDiff(root) {
  try {
    return createHash('sha256').update(execFileSync('git', ['-C', root, 'diff', '--binary', '--no-ext-diff', '--no-color'], {maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']})).digest('hex');
  } catch {
    throw new UsageError(`${root} is not a git checkout: mutate compares git diff before and after the run.`);
  }
}

function linkedWorktree(root) {
  try {
    const [directory, common] = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim().split('\n');
    return Boolean(directory && common && directory !== common);
  } catch {
    return false;
  }
}

const backupPath = (root, file) => resolve(root, '.cache', 'mutate', `${file.replaceAll('/', '__')}.orig`);
let active;

async function restore({path, original, backup}) {
  await writeFile(path, original);
  if (!(await readFile(path)).equals(original)) throw new RestoreError(`${path} still differs from its original after the restore; the original bytes are in ${backup}.`);
  await rm(backup);
}

/** For signals: puts the file under mutation back synchronously; the exit closes the leash's pipe, which stops the run. */
export function restoreNow() {
  if (!active) return;
  try {writeFileSync(active.path, active.original); rmSync(active.backup, {force: true});} catch { /* the backup stays for a manual restore */ }
}

const short = text => {const value = JSON.stringify(text); return value.length > 60 ? `${value.slice(0, 57)}…"` : value;};
function describe(result) {
  if (result.timedOut) return 'hung until the watchdog killed it';
  const parts = [];
  if (result.fail) parts.push(`${result.fail} failed`);
  if (result.cancelled) parts.push(`${result.cancelled} cancelled (timeout)`);
  if (!parts.length && result.exitCode !== 0) parts.push(`node exited ${result.exitCode}`);
  if (!parts.length && !result.tests) parts.push('no test ran');
  if (!parts.length) parts.push(`${result.pass} of ${result.tests} passed`);
  return `${parts.join(', ')}${result.failed?.length ? `: ${result.failed.join(' | ')}` : ''}`;
}

/**
 * Runs each mutation in turn: every `from` is found and every named test is green before any file
 * changes; each file is backed up under .cache/mutate/, mutated, tested, and restored before the next.
 * When a test starts Chrome, nothing runs until `machine()` allows it, and what it returns is held
 * until the last test ends. Returns {code, results}; throws UsageError for a setup problem or a refusal
 * and RestoreError when a file stays changed.
 */
export async function mutate(mutations, {root = ROOT, build = buildEngine, allowLiveCheckout = false, timeoutMs = DEFAULT_TIMEOUT_MS, log = console.log, machine = machineGate} = {}) {
  usage(Array.isArray(mutations) && mutations.length > 0, 'There are no mutations to run.');
  const checked = [];
  for (const [index, raw] of mutations.entries()) checked.push(await checkMutation(raw, index, root));
  const rebuilds = checked.some(mutation => mutation.file.startsWith('src/'));
  const live = checked.some(mutation => /^(src|skills)\//.test(mutation.file));
  usage(!live || allowLiveCheckout || linkedWorktree(root), 'In the main checkout, dist/ (rebuilt from src/) and skills/ are live for every agent session: run mutate in a worktree (.claude/worktrees/<name>), or pass --allow-live-checkout when no session uses this checkout.');
  const originals = new Map();
  for (const {file, from, to, occurrences} of checked) {
    usage(!existsSync(backupPath(root, file)), `A previous run left ${relative(root, backupPath(root, file))}: compare it with ${file}, keep the right bytes, and delete the backup.`);
    if (!originals.has(file)) {
      const bytes = await readFile(resolve(root, file));
      usage(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes), `${file} is not UTF-8 text.`);
      originals.set(file, bytes);
    }
    try {applySwap(originals.get(file).toString('utf8'), from, to, occurrences);}
    catch (error) {throw new UsageError(`${file}: ${error.message}`);}
  }
  const diff = gitDiff(root);
  const chrome = checked.find(mutation => opensChrome(mutation.test));
  let distChanged = false;
  let slot;
  const results = [];
  try {
    if (rebuilds) await build(root);
    if (chrome) {
      const allowed = await machine();
      usage(allowed.ok, `${chrome.test} starts Chrome, and the machine is not free for it: ${allowed.reason}\nNo test ran and nothing was mutated. Wait for the machine (npm run wait-free) and run mutate again.`);
      slot = allowed;
    }
    const baselines = new Set();
    for (const {test, name} of checked) {
      const key = `${test}\0${name ?? ''}`;
      if (baselines.has(key)) continue;
      const run = await runTest({root, test, name, timeoutMs});
      usage(isGreen(run), `${test}${name ? ` (--name ${name})` : ''} is not green before any mutation, so a kill would prove nothing: ${describe(run)}.\n${tail(run.output)}`);
      baselines.add(key);
    }
    for (const mutation of checked) {
      const path = resolve(root, mutation.file);
      const original = originals.get(mutation.file);
      const mutant = Buffer.from(applySwap(original.toString('utf8'), mutation.from, mutation.to, mutation.occurrences), 'utf8');
      const backup = backupPath(root, mutation.file);
      await mkdir(dirname(backup), {recursive: true});
      await writeFile(backup, original, {flag: 'wx'});
      active = {path, original, backup};
      try {
        await writeFile(path, mutant);
        usage((await readFile(path)).equals(mutant), `The mutation of ${mutation.file} did not land.`);
        if (mutation.file.startsWith('src/')) {distChanged = true; await build(root);}
        const run = await runTest({root, test: mutation.test, name: mutation.name, timeoutMs});
        const result = {...mutation, killed: !isGreen(run), exitCode: run.exitCode, timedOut: run.timedOut, tests: run.tests, pass: run.pass, fail: run.fail, cancelled: run.cancelled, failed: run.failed};
        results.push(result);
        log(`${result.killed ? 'KILLED  ' : 'SURVIVED'} ${mutation.file}: ${short(mutation.from)} -> ${short(mutation.to)} · ${describe(result)}`);
      } finally {
        await restore(active);
        active = undefined;
      }
    }
  } finally {
    // The rebuild below starts no Chrome.
    slot?.release();
    // dist/ goes back to the restored sources even when a step failed.
    if (distChanged) await build(root);
  }
  if (gitDiff(root) !== diff) throw new RestoreError('git diff changed during the run although every mutated file was restored: another process edited this checkout, or a test wrote to tracked files.');
  return {code: results.some(result => !result.killed) ? EXIT.survived : EXIT.killed, results};
}

async function readPlan(path) {
  let value;
  try {value = JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8'));}
  catch (error) {throw new UsageError(`Cannot read the plan ${path}: ${error.message}`);}
  const list = Array.isArray(value) ? value : value?.mutations;
  usage(Array.isArray(list) && list.length > 0, 'A plan is a non-empty JSON array of mutations, or {"mutations": [...]}.');
  return list;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {console.log(HELP); return;}
    const mutations = options.planPath ? await readPlan(options.planPath) : options.mutations;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => {restoreNow(); process.exit(130);});
    const {code, results} = await mutate(mutations, {allowLiveCheckout: options.allowLiveCheckout, timeoutMs: options.timeoutMs});
    console.log(`${results.filter(result => result.killed).length} of ${results.length} mutation(s) killed.`);
    process.exitCode = code;
  } catch (error) {
    if (error instanceof RestoreError) {console.error(`RESTORE FAILED: ${error.message}`); process.exitCode = EXIT.restore; return;}
    console.error(error instanceof UsageError ? error.message : error instanceof Error ? error.stack : String(error));
    process.exitCode = EXIT.usage;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
