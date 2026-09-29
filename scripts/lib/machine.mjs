// Machine checks shared by the test runner, kill-stale and wait-free. The machine is small (8 GB of
// RAM), so a test that starts Chrome must not run next to another render, and nothing here may touch
// a process another session still drives. Only `ps`, `lsof` (macOS) or /proc (Linux) and statfs are used.
import {execFile} from 'node:child_process';
import {readlink, statfs} from 'node:fs/promises';
import {basename, isAbsolute, relative} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

/** The inert switch every Chrome started by launchStudioBrowser carries (src/capture/browser.ts). */
export const BROWSER_MARKER = '--se-widget-studio';

/** Free space a browser suite needs before it starts: the machine rule is "no render below 3 GB free". */
export const MIN_FREE_BYTES = 3 * 1024 ** 3;

// A render or an automated browser from any session: the same patterns the machine rule greps for.
const HEAVY = [
  /\bChrom(e|ium)\b.*--headless/,
  /headless[_-]shell/,
  /--remote-debugging-pipe/,
  /remotion/,
  /dist\/cli\/index\.js\s+(render|record|capture)\b/
];

// A shell or a search tool whose command line only mentions a pattern (the machine check's own
// `pgrep -fl 'Chrome.*headless|remotion|...'`, or the shell that chains it) renders nothing: the
// work a shell starts is listed as a process of its own.
const WRAPPER = /^-?(sh|bash|zsh|dash|ksh|fish|pgrep|pkill|grep|egrep|rg)$/;
const executable = command => basename(command.trimStart().split(/\s+/, 1)[0] ?? '');

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
  return !WRAPPER.test(executable(command)) && HEAVY.some(pattern => pattern.test(command));
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

// Rounded down, so a volume just under the limit never reads as enough.
const gib = bytes => `${(Math.floor(bytes / 1024 ** 3 * 10) / 10).toFixed(1)} GiB`;
export const shortCommand = command => (command.length > 110 ? `${command.slice(0, 107)}...` : command);

/**
 * Whether a suite that starts Chrome may run now. It refuses below MIN_FREE_BYTES, when another
 * session renders, or when this checkout left an orphan (which `npm run kill-stale` removes).
 */
export async function browserGate({root, paths, ownRoots, minFreeBytes = MIN_FREE_BYTES, processes, free = freeBytes, cwd = cwdOf}) {
  for (const path of paths) {
    const bytes = await free(path);
    if (bytes < minFreeBytes) return {ok: false, reason: `only ${gib(bytes)} free on the volume of ${path}; browser suites need ${gib(minFreeBytes)}`};
  }
  const list = processes ?? await listProcesses();
  const {orphans} = await checkoutOrphans(root, list, {cwd});
  if (orphans.length) return {ok: false, reason: `this checkout left ${orphans.length} orphan process(es) (PID ${orphans.map(item => item.pid).join(', ')}); run npm run kill-stale`};
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
