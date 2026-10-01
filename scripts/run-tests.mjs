// Runs the test suites the way this machine needs them:
// - every suite also writes its output to .cache/test-logs/<run>/<suite>.log, so a failure keeps its name;
// - the suites that start Chrome (integration, web:browser) run one file at a time behind the machine
//   gate, holding the machine-wide render slot (~/.cache/render-slot, shared with background-creator),
//   and are skipped with the reason when the disk is low, another session renders, or the slot is held;
// - each suite gets a temporary folder of its own (TMPDIR), which must be empty when the suite ends,
//   and a render slot inside it, so a CLI render a test starts never waits for the machine's slot.
//
//   node scripts/run-tests.mjs <suite>...        suites: unit, integration, web, web:browser
//   node scripts/run-tests.mjs --repeat <file> <count>
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir, mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {browserGate} from './lib/machine.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = join(ROOT, '.cache', 'test-logs');
const KEEP_RUNS = 10;

// A test without its own timeout fails after two minutes instead of holding the run, and a file ends
// once its tests end even if a hung browser keeps its event loop alive (Playwright then kills Chrome).
const BOUNDED = ['--test-reporter=spec', '--test-timeout=120000', '--test-force-exit'];
// Web tests that start Chrome are named "[browser] ...".
const BROWSER_TEST = /\btest\(\s*['"`]\[browser\] /;

export const SUITES = {
  unit: {dir: 'tests/unit', suffix: '.test.mjs', flags: []},
  integration: {dir: 'tests/integration', suffix: '.test.mjs', browser: true, flags: []},
  web: {dir: 'tests/web', suffix: '.test.ts', tsx: true, flags: ['--test-skip-pattern=^\\[browser\\] ']},
  'web:browser': {dir: 'tests/web', suffix: '.test.ts', tsx: true, browser: true, tagged: true, flags: ['--test-name-pattern=^\\[browser\\] ']}
};

export function nodeArgs(suite, files) {
  return [
    ...(suite.tsx ? ['--import', 'tsx'] : []),
    '--test', ...BOUNDED,
    ...(suite.browser ? ['--test-concurrency=1'] : []),
    ...suite.flags,
    ...files
  ];
}

async function suiteFiles(suite) {
  const names = (await readdir(join(ROOT, suite.dir))).filter(name => name.endsWith(suite.suffix)).sort();
  const files = names.map(name => `${suite.dir}/${name}`);
  if (!suite.tagged) return files;
  const tagged = [];
  for (const file of files) if (BROWSER_TEST.test(await readFile(join(ROOT, file), 'utf8'))) tagged.push(file);
  return tagged;
}

export function suiteForFile(file) {
  const path = relative(ROOT, resolve(ROOT, file)).split('\\').join('/');
  const name = Object.keys(SUITES).find(key => !SUITES[key].tagged && path.startsWith(`${SUITES[key].dir}/`) && path.endsWith(SUITES[key].suffix));
  if (!name) throw new Error(`Not a test file of a known suite: ${file}`);
  return {path, suite: SUITES[name]};
}

/** Entries a suite left in its temporary folder; tsx keeps its compile cache there and is exempt. */
export const leftovers = entries => entries.filter(entry => !/^tsx-\d+$/.test(entry)).sort();

/** The machine-wide render slot for one browser suite, taken without waiting: a held slot skips the suite. */
export async function takeBrowserSlot(options = {}) {
  const {acquireRenderSlot} = await import('../dist/shared/render-slot.js');
  try {
    const slot = await acquireRenderSlot({command: `node scripts/run-tests.mjs ${process.argv.slice(2).join(' ')}`.trim(), repo: 'se-dev-kit', wait: false, ...options});
    return {ok: true, release: slot.release};
  } catch (error) {
    return {ok: false, reason: error instanceof Error ? error.message : String(error)};
  }
}

/**
 * Whether a browser suite may run now: it takes the render slot, then asks the machine gate, and
 * gives the slot back when the gate refuses. `take` and `check` are replaceable for tests.
 */
export async function gate({
  take = takeBrowserSlot,
  check = () => browserGate({root: ROOT, paths: [ROOT, tmpdir()], ownRoots: [process.pid]}),
  pauseMs = 1000
} = {}) {
  if (process.env.SE_WIDGET_STUDIO_TEST_GATE === 'off') return {ok: true, release: () => {}};
  const slot = await take();
  if (!slot.ok) return slot;
  let result;
  // A Chrome the previous suite's exit just killed can still be listed for a moment.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await sleep(pauseMs);
    result = await check();
    if (result.ok) return {...result, release: slot.release};
  }
  slot.release();
  return result;
}

/**
 * A suite's environment: its own TMPDIR, and a render slot inside it, so a CLI render a test starts
 * neither waits for nor holds the machine-wide slot (the runner holds that one for browser suites).
 */
export function suiteEnvironment(environment, temporary) {
  // NODE_TEST_CONTEXT would make a runner started from inside a test file act as that file's child.
  const {NODE_TEST_CONTEXT: _context, ...rest} = environment;
  return {...rest, TMPDIR: temporary, RENDER_SLOT_DIR: join(temporary, 'render-slot')};
}

export async function execute(label, suite, files, logPath, {echo = true} = {}) {
  const args = nodeArgs(suite, files);
  // Chrome keeps a Unix socket under TMPDIR; macOS caps that path at 104 bytes, so browser suites use /tmp.
  const temporary = await mkdtemp(join(suite.browser && process.platform === 'darwin' ? '/tmp' : tmpdir(), 'sws-'));
  const log = createWriteStream(logPath, {flags: 'a'});
  const started = Date.now();
  log.write(`$ node ${args.join(' ')}\n# ${label}: node ${process.version}, TMPDIR=${temporary}, ${new Date(started).toISOString()}\n`);
  const child = spawn(process.execPath, args, {cwd: ROOT, env: suiteEnvironment(process.env, temporary), stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', chunk => { if (echo) process.stdout.write(chunk); log.write(chunk); });
  child.stderr.on('data', chunk => { if (echo) process.stderr.write(chunk); log.write(chunk); });
  let code = await new Promise(done => child.once('close', (exit, signal) => done(exit ?? (signal ? 1 : 0))));
  const left = leftovers(await readdir(temporary));
  await rm(temporary, {recursive: true, force: true});
  if (left.length) {
    const message = `\n${label} left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in its temporary folder: ${left.slice(0, 8).join(', ')}${left.length > 8 ? ', ...' : ''}\nA test must remove what it creates (see tests/web/temporary.ts).\n`;
    if (echo) process.stderr.write(message);
    log.write(message);
    code ||= 1;
  }
  const seconds = (Date.now() - started) / 1000;
  log.write(`# ${label}: exit ${code} after ${seconds.toFixed(1)} s\n`);
  await new Promise(done => log.end(done));
  return {code, seconds};
}

async function newRunDirectory() {
  await mkdir(LOGS, {recursive: true});
  const directory = join(LOGS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  await mkdir(directory);
  const runs = (await readdir(LOGS, {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) await rm(join(LOGS, old), {recursive: true, force: true});
  return directory;
}

// Integration tests render in-process, where the CLI's Node.js refusal does not reach.
async function warnOnUnsupportedNode() {
  try {
    const {SUPPORTED_NODE, satisfiesNodeRange} = await import('../dist/shared/node-support.js');
    if (!satisfiesNodeRange(process.versions.node)) console.log(`Warning: Node.js ${process.versions.node} is outside package.json engines (${SUPPORTED_NODE}); Chrome has hung on Node 26. Use Node 24 (.node-version).`);
  } catch {
    // Without a built engine there is nothing to render with yet.
  }
}

async function runSuites(names) {
  for (const name of names) if (!SUITES[name]) throw new Error(`Unknown suite ${name}. Suites: ${Object.keys(SUITES).join(', ')}.`);
  await warnOnUnsupportedNode();
  const directory = await newRunDirectory();
  console.log(`Test logs: ${relative(ROOT, directory)}/`);
  const results = [];
  for (const name of names) {
    const suite = SUITES[name];
    const files = await suiteFiles(suite);
    if (!files.length) { results.push({name, status: 'passed', detail: 'no files'}); continue; }
    const allowed = suite.browser ? await gate() : {ok: true, release: () => {}};
    if (!allowed.ok) {
      console.log(`\nSkipped ${name}: ${allowed.reason}`);
      results.push({name, status: 'skipped', detail: allowed.reason});
      continue;
    }
    let outcome;
    try {
      console.log(`\n== ${name}: ${files.length} file(s)${suite.browser ? ', one at a time' : ''}`);
      outcome = await execute(name, suite, files, join(directory, `${name.replace(':', '-')}.log`));
    } finally {
      allowed.release();
    }
    const {code, seconds} = outcome;
    results.push({name, status: code === 0 ? 'passed' : 'failed', detail: `${seconds.toFixed(1)} s`});
    if (code !== 0) break;
  }
  console.log('');
  for (const result of results) console.log(`${result.name.padEnd(12)} ${result.status.padEnd(8)} ${result.detail}`);
  const skipped = results.filter(result => result.status === 'skipped').map(result => result.name);
  if (skipped.length) console.log(`NOT COVERED: ${skipped.join(', ')}. This run did not test them; run npm run wait-free, then npm run test:browser.`);
  console.log(`Logs: ${relative(ROOT, directory)}/`);
  return results.some(result => result.status === 'failed') ? 1 : 0;
}

async function repeat(file, countText) {
  const count = Number(countText ?? 5);
  if (!file || !Number.isInteger(count) || count < 1 || count > 100) throw new Error('Usage: npm run test:repeat -- <test file> [count 1-100, default 5]');
  const {path, suite: base} = suiteForFile(file);
  await warnOnUnsupportedNode();
  const browser = base.browser || BROWSER_TEST.test(await readFile(join(ROOT, path), 'utf8'));
  const suite = {...base, browser, flags: []};
  const directory = await newRunDirectory();
  console.log(`Repeating ${path} ${count} time(s)${browser ? ', behind the machine gate' : ''}. Logs: ${relative(ROOT, directory)}/`);
  const failed = [];
  for (let run = 1; run <= count; run += 1) {
    const allowed = browser ? await gate() : {ok: true, release: () => {}};
    if (!allowed.ok) { console.log(`Stopped before run ${run}: ${allowed.reason}`); return {failed, ran: run - 1, code: 1}; }
    let outcome;
    try {
      outcome = await execute(`run ${run}`, suite, [path], join(directory, `run-${run}.log`));
    } finally {
      allowed.release();
    }
    const {code, seconds} = outcome;
    console.log(`run ${run}: ${code === 0 ? 'passed' : 'FAILED'} in ${seconds.toFixed(1)} s`);
    if (code !== 0) failed.push(run);
  }
  console.log(`${path}: ${count - failed.length}/${count} passed${failed.length ? `; failed runs: ${failed.join(', ')} (run-<n>.log)` : ''}.`);
  return {failed, ran: count, code: failed.length ? 1 : 0};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    process.exitCode = args[0] === '--repeat' ? (await repeat(args[1], args[2])).code : await runSuites(args.length ? args : Object.keys(SUITES));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
