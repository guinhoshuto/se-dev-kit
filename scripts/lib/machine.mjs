// Machine checks shared by the test runner, kill-stale and wait-free. The machine is small (8 GB of
// RAM), so a test that starts Chrome must not run next to another render, and nothing here may touch
// a process another session still drives. Only `ps`, `lsof` (macOS) or /proc (Linux), statfs and the
// machine check every repo shares (machineVerdict) are used.
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readlink, statfs} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, isAbsolute, join, relative} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

/** The inert switch every Chrome started by launchStudioBrowser carries (src/capture/browser.ts). */
export const BROWSER_MARKER = '--se-widget-studio';

/** Free space a browser suite needs before it starts: the machine rule is "no render below 3 GB free". */
export const MIN_FREE_BYTES = 3 * 1024 ** 3;

// A render or an automated browser from any session: the same patterns, string for string, as the
// machine check every repo shares (PESADO in ~/obsidian/AI/scripts/maquina_livre.py; a unit test fails
// while they differ), so this fallback sees what the check sees.
// Remotion counts while its CLI renders (the render, still and benchmark commands), called through
// node_modules/.bin, remotion-cli.js, npx or npm exec (the title npx shows in ps), and while its compositor
// runs; the Chrome it opens matches the headless patterns. Studio, compositions, bundle and any command
// that only names the word (a folder, a config file, a log) do not count: on 2026-10-06 the bare `remotion`
// pattern reported `node .cache/remotion-mock/slot-run.mts`, a wrapper that renders nothing (HAR-32).
// Blender counts as its executable with -b or --background. A render started from Blender's UI stays
// invisible to this check; before this rule, a 511 s Blender render in a Codex session went unseen.
// ffmpeg counts while it writes many frames (image2, a %06d name) or encodes video, not for one frame.
export const HEAVY_PATTERNS = [
  String.raw`\bChrom(e|ium)\b.*--headless`,
  String.raw`headless[_-]shell`,
  String.raw`--remote-debugging-pipe`,
  String.raw`(?:node_modules/\.bin/remotion|@remotion/cli/remotion-cli\.js|(?:^|[\s/])(?:npx|npm\s+exec)\s+remotion)\s+(?:render|still|benchmark)(?:\s|$)`,
  String.raw`@remotion/compositor-[^/\s]+/remotion(?:\s|$)`,
  String.raw`dist/cli/index\.js\s+(render|record|capture)\b`,
  String.raw`^(?:\S*/)?[Bb]lender\s(?:.*\s)?(?:-b|--background)(?:\s|$)`,
  String.raw`^(?:\S*/)?ffmpeg\s(?!.*\s-(?:frames:v|vframes)\s+1(?:\s|$))` +
    String.raw`.*(?:\s-f\s+image2(?:\s|$)|%0?\d*d\.\w+|\s(?:libx26[45]|libvpx(?:-vp9)?|libaom-av1|libsvtav1|\w+_videotoolbox|prores\w*)(?:\s|$))`
];
const HEAVY = HEAVY_PATTERNS.map(pattern => new RegExp(pattern));

// A shell or a search tool whose command line only mentions a pattern (the machine check's own
// `pgrep -fl 'Chrome.*headless|remotion|...'`, or the shell that chains it) renders nothing: the
// work a shell starts is listed as a process of its own. So does caffeinate, which only wraps the
// command it keeps the Mac awake for. The same names as EMBRULHO in the machine check; Claude Code's
// grep shows up as ugrep. A login shell's leading dash is dropped.
export const WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pgrep', 'pkill', 'grep', 'egrep', 'ugrep', 'rg', 'caffeinate']);
const executable = command => basename(command.trimStart().split(/\s+/, 1)[0] ?? '').replace(/^-+/, '');

export function parseProcessList(text) {
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{pid: Number(match[1]), ppid: Number(match[2]), command: match[3]}] : [];
  });
}

export async function listProcesses() {
  const {stdout} = await run('ps', ['-axww', '-o', 'pid=,ppid=,command='], {maxBuffer: 32 * 1024 * 1024});
  return parseProcessList(stdout);
}

export async function cwdOf(pid) {
  try {
    if (process.platform === 'linux') return await readlink(`/proc/${pid}/cwd`);
    const {stdout} = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    return stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
  } catch {
    return undefined;
  }
}

export function isInside(root, path) {
  if (!path) return false;
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** PIDs of `roots` and everything they started, so a check never counts its own work as another session's. */
export function familyOf(processes, roots) {
  const children = new Map();
  for (const item of processes) children.set(item.ppid, [...(children.get(item.ppid) ?? []), item.pid]);
  const family = new Set();
  const pending = [...roots];
  while (pending.length) {
    const pid = pending.pop();
    if (family.has(pid)) continue;
    family.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return family;
}

export function isHeavy(command) {
  return !WRAPPERS.has(executable(command)) && HEAVY.some(pattern => pattern.test(command));
}

const isTestWorker = command => /\bnode\b/.test(command) && /\.test\.(mjs|ts)\b/.test(command) && !/\s--test(\s|$)/.test(command);
const isJobWorker = command => /\bnode\b/.test(command) && /scripts\/job-worker\.mjs\b/.test(command);

/**
 * This checkout's leftovers: a marked Chrome whose launcher died (PPID 1), and a test or job worker
 * whose runner died, together with the marked Chrome it started. Only processes whose working
 * directory is inside `root` count. A PPID-1 test runner or CLI render is reported, never killed:
 * it may be a job someone put in the background on purpose.
 */
export async function checkoutOrphans(root, processes, {cwd = cwdOf} = {}) {
  const orphans = [];
  const reported = [];
  for (const item of processes) {
    if (item.ppid !== 1) continue;
    const marked = item.command.includes(BROWSER_MARKER);
    const worker = isTestWorker(item.command) || isJobWorker(item.command);
    const runnerOrRender = /\bnode\b/.test(item.command) && (/\s--test(\s|$)/.test(item.command) || /dist\/cli\/index\.js/.test(item.command));
    if (!marked && !worker && !runnerOrRender) continue;
    if (!isInside(root, await cwd(item.pid))) continue;
    if (marked || worker) orphans.push(item);
    else reported.push(item);
  }
  const family = familyOf(processes, orphans.map(item => item.pid));
  const browsers = processes.filter(item => family.has(item.pid) && item.command.includes(BROWSER_MARKER) && !orphans.includes(item));
  return {orphans: [...orphans, ...browsers], reported};
}

/** PIDs above `roots`, below launchd: the shell, npm and agent that started the caller. */
export function ancestorsOf(processes, roots) {
  const parents = new Map(processes.map(item => [item.pid, item.ppid]));
  const ancestors = new Set();
  for (const root of roots) {
    for (let pid = parents.get(root); pid !== undefined && pid > 1 && !ancestors.has(pid); pid = parents.get(pid)) ancestors.add(pid);
  }
  return ancestors;
}

/** Heavy processes that belong to neither `ownRoots`, their descendants, nor their ancestors. */
export function otherSessionsWork(processes, ownRoots) {
  const own = familyOf(processes, ownRoots);
  for (const pid of ancestorsOf(processes, ownRoots)) own.add(pid);
  return processes.filter(item => !own.has(item.pid) && isHeavy(item.command));
}

export async function freeBytes(path) {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

/**
 * The machine check every repo on this Mac shares: ~/obsidian/AI/scripts/maquina_livre.py, in the
 * owner's vault. It looks at other renders, the render slot, the game, free memory, swap and disk,
 * with the machine's limits in one place. MACHINE_CHECK overrides its path (the tests use a fake one).
 */
export const machineCheckScript = () => process.env.MACHINE_CHECK || join(homedir(), 'obsidian', 'AI', 'scripts', 'maquina_livre.py');

/** The check's --json answer as {free, reasons} (English), or null when `text` is not one. */
export function parseVerdict(text) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof answer?.livre !== 'boolean' || !Array.isArray(answer.reasons)) return null;
  if (answer.livre) return {free: true, reasons: []};
  const reasons = answer.reasons.filter(reason => typeof reason === 'string');
  return {free: false, reasons: reasons.length ? reasons : ['the machine check says to wait, without a reason']};
}

/**
 * The machine check's verdict, with `familyPids` and everything they started counted as the caller's
 * own work. Null where the check is missing (another machine) or gave no answer: the caller falls
 * back to its own process check.
 */
export async function machineVerdict(familyPids = [process.pid], script = machineCheckScript()) {
  if (!existsSync(script)) return null;
  let stdout;
  try {
    ({stdout} = await run('python3', [script, '--json', ...familyPids.flatMap(pid => ['--familia', String(pid)])], {timeout: 60_000, maxBuffer: 4 * 1024 * 1024}));
  } catch (error) {
    // Exit 3 is the busy answer, with the JSON on stdout.
    stdout = String(error?.stdout ?? '');
  }
  return parseVerdict(stdout);
}

// Rounded down, so a volume just under the limit never reads as enough.
const gib = bytes => `${(Math.floor(bytes / 1024 ** 3 * 10) / 10).toFixed(1)} GiB`;
export const shortCommand = command => (command.length > 110 ? `${command.slice(0, 107)}...` : command);

/**
 * Whether a suite that starts Chrome may run now. It refuses below MIN_FREE_BYTES, when this checkout
 * left an orphan (which `npm run kill-stale` removes), and when the machine check says to wait; where
 * that check is missing, when another session renders.
 */
export async function browserGate({root, paths, ownRoots, minFreeBytes = MIN_FREE_BYTES, processes, free = freeBytes, cwd = cwdOf, machine = machineVerdict}) {
  for (const path of paths) {
    const bytes = await free(path);
    if (bytes < minFreeBytes) return {ok: false, reason: `only ${gib(bytes)} free on the volume of ${path}; browser suites need ${gib(minFreeBytes)}`};
  }
  const list = processes ?? await listProcesses();
  const {orphans} = await checkoutOrphans(root, list, {cwd});
  if (orphans.length) return {ok: false, reason: `this checkout left ${orphans.length} orphan process(es) (PID ${orphans.map(item => item.pid).join(', ')}); run npm run kill-stale`};
  const verdict = await machine(ownRoots);
  if (verdict) return verdict.free ? {ok: true} : {ok: false, reason: `the machine check says to wait: ${verdict.reasons.join('; ')}`};
  const busy = otherSessionsWork(list, ownRoots);
  if (busy.length) return {ok: false, reason: `another session is rendering: PID ${busy[0].pid} ${shortCommand(busy[0].command)}${busy.length > 1 ? ` (+${busy.length - 1} more)` : ''}`};
  return {ok: true};
}

/** SIGKILL, by process group first, since Playwright starts Chrome as the leader of its own group. */
export function killTree(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
}
