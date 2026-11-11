#!/usr/bin/env node
/**
 * The whole gate of a session on one issue (AGENTS.md, "A session on one issue", step 2), on the branch's last commit:
 * typecheck, npm test, the build in the render-slot queue, verify:bundle, then each mutation plan the branch adds or
 * changes against main. Each step is a child of its own, with its output in .cache/gate/<commit>/<step>.log; the run
 * stops at the first step that fails.
 *
 *   npm run gate [-- --dry-run | --help]
 *
 * No step runs or polls the machine check (maquina_livre.py) before it starts, and no step has a timeout: the browser
 * suites of npm test, the build and a plan that starts Chrome wait in the render-slot queue, which moves in the order
 * the waiters came and lets them in between two steps of a chain that cedes. A hand-written chain that waited on
 * `maquina_livre.py --esperar` before the build stood still while that queue moved (86 min before each build, #38).
 *
 * Exit codes: 0 every step passed; 1 a step failed (or the tree changed during the gate); 2 usage, or a refusal before
 * any step (outside a git checkout, a dirty tree); 3 every step passed but npm test left suites NOT COVERED.
 */
import {execFileSync, spawn} from 'node:child_process';
import {createWriteStream, existsSync, readFileSync} from 'node:fs';
import {mkdir, readdir, unlink, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isEntryPoint} from './lib/entry-point.mjs';
import {opensChrome} from './mutate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXIT = {passed: 0, failed: 1, usage: 2, notCovered: 3};
const SLOT = 'dist/shared/render-slot.js';

export class UsageError extends Error {}

const HELP = `Usage: npm run gate [-- --dry-run | --help]

Runs the issue gate on the branch's last commit, one step after the other, and stops at the first that fails:
  1. typecheck      npm run typecheck
  2. npm test       npm test (its browser suites take the render slot themselves)
  3. build          node ${SLOT} run --repo <root> -- npm run build (in the render-slot queue)
  4. verify:bundle  npm run verify:bundle
  5. one step per tests/**/*.mutations.json the branch adds or changes against main (git diff main...HEAD):
                    node scripts/mutate.mjs --plan <plan>, in the render-slot queue when a test of it starts Chrome
No step waits for the machine check; each step's log goes to .cache/gate/<commit>/, with summary.txt.
A dirty tree is refused: the gate runs on the branch's last commit, so commit first.
--dry-run prints the commit, the steps and the plans, and runs and writes nothing.
Exit codes: 0 all passed, 1 a step failed, 2 usage or refusal, 3 all passed but npm test left suites NOT COVERED.`;

export function parseArgs(args) {
  const options = {dryRun: false, help: false};
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new UsageError(`Unknown argument ${arg}. Run with --help.`);
  }
  return options;
}

const git = (root, args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});

/** HEAD's short sha and the entries of `git status --porcelain` (tracked changes and untracked files git does not ignore). */
export function gitState(root = ROOT) {
  let commit;
  try {commit = git(root, ['rev-parse', '--short', 'HEAD']).trim();}
  catch {throw new UsageError(`${root} is not a git checkout with a commit: the gate runs on the branch's last commit.`);}
  const dirty = git(root, ['status', '--porcelain']).split('\n').filter(Boolean);
  return {commit, dirty};
}

/**
 * The mutation plans the branch adds or changes against `base`, from the merge base (three dots), so `base` moving
 * ahead does not count; deleted plans are left out. Paths relative to the root, sorted.
 */
export function changedPlans({root = ROOT, base = 'main'} = {}) {
  let names;
  try {names = git(root, ['diff', '--name-only', '--diff-filter=d', `${base}...HEAD`]);}
  catch (error) {throw new UsageError(`Cannot diff against ${base}: ${String(error?.stderr || error?.message || error).trim()}`);}
  return names.split('\n').filter(path => /^tests\/.+\.mutations\.json$/.test(path)).sort();
}

/** Whether a mutation of the plan runs a test that starts Chrome; a plan that does not parse is left to mutate to refuse. */
export function planOpensChrome(root, plan) {
  try {
    const value = JSON.parse(readFileSync(resolve(root, plan), 'utf8'));
    const list = Array.isArray(value) ? value : value?.mutations;
    return Array.isArray(list) && list.some(mutation => typeof mutation?.test === 'string' && opensChrome(mutation.test));
  } catch {
    return false;
  }
}

const logName = name => `${name.replace(/^mutate tests\//, 'mutate-').replace(/\.mutations\.json$/, '').replace(/[^\w.-]+/g, '-')}.log`;

/** The steps in their order, each with its command, its arguments and its log file name. */
export function gateSteps({root = ROOT, plans = [], chrome = plan => planOpensChrome(root, plan)} = {}) {
  const steps = [
    {name: 'typecheck', command: 'npm', args: ['run', 'typecheck']},
    {name: 'npm test', command: 'npm', args: ['test']},
    {name: 'build', command: 'node', args: [SLOT, 'run', '--repo', root, '--', 'npm', 'run', 'build']},
    {name: 'verify:bundle', command: 'npm', args: ['run', 'verify:bundle']},
    ...plans.map(plan => {
      const mutate = ['scripts/mutate.mjs', '--plan', plan];
      return {name: `mutate ${plan}`, plan, command: 'node', args: chrome(plan) ? [SLOT, 'run', '--', 'node', ...mutate] : mutate};
    })
  ];
  return steps.map(step => ({...step, log: logName(step.name)}));
}

let current;
let stopSignal;

/** Runs one step as a child (no shell), its stdout and stderr to its log; resolves with its exit code and its output's tail. */
export function runStep(step, {root, logPath}) {
  return new Promise(done => {
    const out = createWriteStream(logPath);
    let output = '';
    const child = spawn(step.command === 'node' ? process.execPath : step.command, step.args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    current = child;
    const collect = chunk => {out.write(chunk); output = (output + chunk).slice(-1_000_000);};
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    const finish = code => {current = undefined; out.end(() => done({code, output}));};
    child.on('error', error => {collect(`${error.message}\n`); finish(127);});
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

/** Forwards SIGINT and SIGTERM to the running step; the gate stops after it. */
export function forwardSignals() {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {stopSignal = signal; current?.kill(signal);});
}

const clock = () => new Date().toTimeString().slice(0, 8);
const seconds = ms => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

/** The suites of every NOT COVERED line, in their order, each once. */
export const notCoveredSuites = lines => [...new Set(lines.flatMap(line => (line.match(/^NOT COVERED: (.+?)\. /)?.[1] ?? '').split(', ').filter(Boolean)))];

/** Removes, directly in the folder, only the *.log files and summary.txt an earlier run of the same commit left. */
async function clearEarlierRun(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.isFile() && (entry.name.endsWith('.log') || entry.name === 'summary.txt')) await unlink(join(directory, entry.name));
  }
}

/**
 * The gate: refuses a dirty tree, then runs each step in turn through `run`, stopping at the first that fails or after
 * which HEAD or the tree changed. Returns the exit code; prints progress, the summary and the last line through `log`.
 */
export async function runGate({root = ROOT, base = 'main', run = runStep, log = console.log, error = console.error, stopped = () => stopSignal, awake = () => {}} = {}) {
  const {commit, dirty} = gitState(root);
  if (dirty.length) {
    error(`gate ${commit} refused: the tree is not clean, and the gate runs on the branch's last commit, so commit first.\n${dirty.map(line => `  ${line}`).join('\n')}`);
    return EXIT.usage;
  }
  awake();
  const plans = changedPlans({root, base});
  const steps = gateSteps({root, plans});
  const directory = join(root, '.cache', 'gate', commit);
  await mkdir(directory, {recursive: true});
  await clearEarlierRun(directory);
  const results = [];
  let failed;
  for (const step of steps) {
    const logPath = join(directory, step.log);
    const shown = relative(root, logPath);
    if (failed) {results.push({step, status: 'not run', shown: ''}); continue;}
    log(`${clock()} gate ${commit} · ${step.name} …`);
    const started = Date.now();
    const {code, output} = await run(step, {root, logPath});
    const result = {step, status: code === 0 ? 'passed' : 'failed', took: seconds(Date.now() - started), shown, extra: [], below: []};
    if (step.name === 'npm test') {
      result.below = output.match(/^NOT COVERED: .+$/gm) ?? [];
      const logs = [...output.matchAll(/^Logs: (.+\/)$/gm)].at(-1);
      if (logs) result.extra.push(`Logs: ${logs[1]}`);
    }
    if (step.plan) {
      const killed = [...output.matchAll(/^\d+ of \d+ mutation\(s\) killed\.$/gm)].at(-1);
      if (killed) result.extra.push(killed[0]);
    }
    const signal = stopped();
    if (result.status === 'passed' && signal) {result.status = 'failed'; result.extra.push(`stopped by ${signal}`);}
    if (result.status === 'passed') {
      const now = gitState(root);
      if (now.commit !== commit || now.dirty.length) {result.status = 'failed'; result.extra.push('the tree changed during the gate');}
    }
    results.push(result);
    if (result.status === 'failed') failed = result;
  }
  const width = Math.max(...results.map(result => result.step.name.length), 'mutation plans'.length);
  const summary = [];
  for (const result of results) {
    summary.push([result.step.name.padEnd(width), result.status.padEnd(8), (result.took ?? '').padEnd(8), result.shown, ...(result.extra ?? [])].join(' ').trimEnd());
    for (const line of result.below ?? []) summary.push(`  ${line}`);
  }
  if (!plans.length) summary.push(`${'mutation plans'.padEnd(width)} none     no tests/**/*.mutations.json added or changed against ${base}`);
  const uncovered = notCoveredSuites(results.find(result => result.step.name === 'npm test')?.below ?? []);
  let last; let code;
  if (failed) {last = `gate ${commit} FAILED at ${failed.step.name}: ${failed.shown}`; code = EXIT.failed;}
  else if (uncovered.length) {last = `gate ${commit} passed, but npm test left NOT COVERED: ${uncovered.join(', ')}. Run npm run test:browser again, or name them in the question.`; code = EXIT.notCovered;}
  else {last = `gate ${commit} passed: ${steps.length} step(s).`; code = EXIT.passed;}
  summary.push(last);
  await writeFile(join(directory, 'summary.txt'), `${summary.join('\n')}\n`);
  log('');
  for (const line of summary) log(line);
  return code;
}

/** What the gate would do, without running or writing anything. */
export function dryRun({root = ROOT, base = 'main', log = console.log} = {}) {
  const {commit, dirty} = gitState(root);
  const plans = changedPlans({root, base});
  const steps = gateSteps({root, plans});
  const width = Math.max(...steps.map(step => step.name.length));
  log(`gate ${commit} (dry run: nothing runs, nothing is written)`);
  log(`Logs would go to ${relative(root, join(root, '.cache', 'gate', commit))}/`);
  steps.forEach((step, index) => log(`  ${index + 1}. ${step.name.padEnd(width)}  ${[step.command, ...step.args].join(' ')}`));
  log(plans.length ? `Mutation plans added or changed against ${base}: ${plans.join(', ')}` : `Mutation plans: none added or changed against ${base}.`);
  if (dirty.length) log(`The tree is not clean, so the real run would refuse (exit 2): commit first.\n${dirty.map(line => `  ${line}`).join('\n')}`);
  return EXIT.passed;
}

/** Keeps a gate left running on battery from sleeping, by PID (caffeinate -w), never wrapping a command. */
function stayAwake() {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/caffeinate')) return;
  try {spawn('/usr/bin/caffeinate', ['-ims', '-w', String(process.pid)], {detached: true, stdio: 'ignore'}).unref();} catch { /* the gate runs anyway */ }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {console.log(HELP); return;}
    if (options.dryRun) {process.exitCode = dryRun(); return;}
    forwardSignals();
    process.exitCode = await runGate({awake: stayAwake});
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : error instanceof Error ? error.stack : String(error));
    process.exitCode = EXIT.usage;
  }
}

if (isEntryPoint(import.meta.url)) await main();
