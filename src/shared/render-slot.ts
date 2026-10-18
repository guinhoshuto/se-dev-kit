// One heavy render at a time on this machine (8 GB of RAM), across repos and sessions.
//
// One implementation for every repo. The source is ~/obsidian/AI/scripts/render-slot.ts; each repo
// keeps a byte-identical copy (background-creator: scripts/render-slot.ts, se-dev-kit:
// src/shared/render-slot.ts), because its build cannot reach the vault. Never edit a copy: edit the
// source and run `python3 ~/obsidian/AI/scripts/render_slot_copias.py --write`; `--check` (and a
// test in each repo) fails while a copy differs. Only node: imports, so it compiles under the
// strictest tsconfig of the two repos.
//
// Command line (HAR-80, 2026-10-08): `node render-slot.ts run -- <cmd> [args]` runs one heavy step
// under the slot, for a repo or a one-off render that does not import this module. It waits in the
// queue, takes the slot named after the command, runs it with RENDER_SLOT_HELD (so a render inside
// runs under the same slot) in a process group of its own, forwards SIGINT, SIGTERM and SIGHUP to that
// whole group, and releases the slot only when the command has exited, however it ends, and, after a
// forwarded signal, only once nothing of its group runs (HAR-166, 2026-10-14: a SIGTERM to the outer
// `run` of an npm script `node -e 0 && render-slot.ts run -- sleep 15` ended npm and its shell, and the
// nested step went on with the slot free). A command that exits by itself gives the slot back at once,
// even with a process it left in the background. It exits with the command's status (128 + the signal
// number when the command died of a signal), 2 on a usage error or a refused command, and 75 when the
// wait gave up. It refuses a .sh script, run directly or through a shell: the slot covers each heavy
// step, never the script that chains them (2026-10-06, a chain held it 50 minutes through light steps).
//
// With the slot in hand, `run` asks the machine check about what the slot does not cover (HAR-32,
// 2026-10-16): `python3 ~/obsidian/AI/scripts/maquina_livre.py --json --fora-da-trava --familia <its pid>`,
// without RENDER_SLOT_HELD (under the slot it names, the check looks only at the disk and at renders
// outside the slot), so the slot counts as its own, and renders outside it, the game, memory and disk
// count. On the answer 3 (busy) it gives the slot back before running anything, says why on stderr (once
// per reason), leaves the slot to the next in the queue for 20 seconds, without a ticket, and asks again
// with `since`, the moment it first came: it never goes ahead of anyone who came before it, and the wait
// limit (4 hours) counts from that moment too, so a machine that stays busy ends the wait with 75. Any
// other answer runs the command: 0 (free) and, with a note on stderr, 4 ("not sure", a sandbox that denies
// ps) and a check that is missing, fails or takes over 60 seconds, so a broken check never keeps a render
// from running. A run under a slot it inherits (RENDER_SLOT_HELD) does not ask: its parent took the slot.
// RENDER_SLOT_CHECK=off skips the check; another value is the program asked in its place, with the same
// arguments (the tests).
//
// `node render-slot.ts hold --rotulo <label> --max <minutes>` (HAR-109, 2026-10-09) holds the slot for a
// heavy task that is not one shell command: an E2E driven step by step through an MCP (Chrome, the SE
// Widget Studio), which could only wait for the machine and let another session start a render in the
// middle. It waits in the queue like `run`, takes the slot as the command "hold: <label>", says so on
// stdout with its pid, and keeps it until `node render-slot.ts release --rotulo <label>`, a signal, or
// --max minutes (1 to 240), whichever comes first; then it releases the slot and exits 0 (75 when the
// wait gave up, 2 on a usage error). Run it in the background. A heavy command of the same task runs
// under that slot with RENDER_SLOT_HELD=<hold pid> in its environment, instead of waiting behind it.
// `release` sends SIGTERM to the hold of that label, holding the slot or still in the queue, waits up to
// 10 seconds for it to let go, and exits 0; 1 when no live hold has that label (it never touches the slot
// of anything else).
//
// `node render-slot.ts status` (HAR-167, 2026-10-14) says who holds the slot and who waits in the queue,
// without touching either: for each, the pid, the repo, the command, since when (local time), the id8 of
// the Claude Code session above the pid (the first of its ancestors with a <pid>.json in
// ~/.claude/sessions, the file `sessoes.py --eu` reads) and the last line of the log of the first job band
// entry (~/.claude/watch.json, `watch_job.py add --log`) whose pid is that pid, an ancestor or a
// descendant of it; "free" when nothing holds it. CLAUDE_CONFIG_DIR moves ~/.claude, as for Claude Code.
// It exits 0.
//
// Protocol: the slot is the directory ~/.cache/render-slot (RENDER_SLOT_DIR overrides it). Taking it
// is an atomic mkdir; inside, owner.json holds {protocol, pid, repo, command, startedAt}, and `run`
// adds commandPgid, the process group of its command, as soon as it starts it. A slot whose pid is
// gone, and the commandPgid group too when there is one (HAR-166: a `run` killed by SIGKILL leaves its
// command running in that group; without commandPgid, the pid alone decides), or whose startedAt is
// before the last boot (the pid was reused), is taken over,
// under the mutex <slot>.takeover (an atomic mkdir), and only after checking again under it that the
// same dead owner still holds it. Only the owner removes it. A child process started by the owner
// finds RENDER_SLOT_HELD=<owner pid> in its environment and runs under the parent's slot instead of
// waiting for it.
//
// Queue: the waiters take the slot in the order they came (HAR-61, 2026-10-06: a chain of kits gives
// way, between one kit and the next, to whoever was already waiting). A waiter that cannot take the
// slot writes a ticket in <slot>.queue/, named <ms, 15 digits>-<pid, 7 digits>.json so that the names
// sort in arrival order, through a temporary file and a rename, so a reader never sees half of one.
// Only the first live ticket may take a free slot, and a newcomer without a ticket never takes a free
// slot while a live ticket waits. The waiter removes its ticket when it takes the slot, gives up or
// exits (exit, SIGINT, SIGTERM). Each round of waiting touches the ticket: its mtime is the heartbeat.
// A ticket is live while its pid runs, it was written after the last boot and it was touched less
// than a minute ago, so a pid reused after its waiter was killed (SIGKILL) stops holding the queue
// after a minute. A waiter that finds it was itself asleep for longer than that (a sleep of the Mac)
// judges no silence for a minute after it wakes, so the others get to touch their tickets first. Any waiter
// removes the tickets of dead pids, of an earlier boot, or silent for 15 minutes; a waiter whose
// ticket was removed while it still runs writes it again under the same name and keeps its place.
// A waiter's place is when it first came: a waiter that gives the slot back right after taking it (the
// machine got busy meanwhile, as the stills of background-creator checks with the slot in hand, HAR-61)
// asks again with `since`, that first moment, and its ticket takes that place again. A `since` before
// the last boot or after now is ignored.
// The queue sits next to the slot, never inside it, and only orders the takers: the slot is still
// taken by the atomic mkdir, so two holders stay impossible, and a copy older than the queue, which
// ignores the tickets, can only jump it. That is why the queue did not raise PROTOCOL.
//
// `protocol` is PROTOCOL below. Raise it whenever a change would let an older copy break the slot of
// a newer one (a new file in the slot, another way to clear the mutex). An owner.json without it was
// written by protocol 1 (the copies before 2026-09-30) and is judged as always. A slot written by a
// newer protocol is never taken over here, even with its pid gone: this copy waits, and says to
// update it.
//
// The takeover mutex is identified by the inode of its directory, never by its path. Right after
// the mkdir its creator creates holder.json ({pid, token}) inside with an exclusive create, reads
// the inode and keeps it, but only when holder.json still holds its token. Any error after the
// mkdir (ENOENT, EEXIST, and EINVAL on APFS when the directory is removed or replaced during the
// create) means the directory at the path is not the one it made: it gives up and waits.
//
// A mutex whose mtime is older than 10 seconds is cleared only when its taker died: while the pid in
// its holder.json still runs (by the rule above for owner.json: a holder.json written before the last
// boot is dead), it stays, however old, so a holder stopped for a while (a sleep of the Mac) keeps
// its mutex. A holder.json naming the clearing process itself is an orphan it left, and a mutex
// without a readable holder.json is judged by its age alone. A live pid that takes nothing over (a
// pid reused after its taker died in the critical section) keeps the mutex until someone removes it
// by hand: a waiter for a dead owner's slot names that pid and the rm of the slot and the mutex. Clearing first claims the mutex with an
// atomic mkdir of <mutex>/clearing, then checks that the path still holds the inode it saw: only
// one process claims a given directory, and a claim that landed in a newer mutex is taken back out
// (rmdir) while that mutex stays at its path. The claimed mutex is removed as below. A claim older
// than 10 seconds (its clearer died) is ignored, and the mutex is removed as below without one. The
// mkdir and rmdir of a claim change the mtime of the mutex, so a dead mutex can wait up to 10 more
// seconds before it is cleared.
//
// Removing a mutex, whether leaving the critical section or clearing it, is never a plain rm of the
// path: rename the path to a unique name (<slot>.takeover.stale-<pid>-<random hex>; a name taken
// already, left by a process that died between the move and the delete, is traded for another, never
// an error), then compare the inode of the moved directory with the inode seen before. The same
// inode: delete it. Another inode (a live mutex someone made in between) is moved back when the path
// is still free, otherwise deleted. Since a clearer leaves a mutex whose holder runs, claims first
// and checks the inode, another inode at the path only follows a clearer that died holding its
// claim. Only then, for a few syscalls, can a live mutex be off its path (so two processes share the
// critical section), and the move back can replace a mutex that was just made and is still an empty
// directory (whose maker then gives up, as above).
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export type SlotOwner = {protocol?: number; pid: number; repo: string; command: string; startedAt: string; commandPgid?: number};
export type SlotHandle = {release: () => void; inherited: boolean};
export type SlotOptions = {
  command: string;
  dir?: string;
  repo?: string;
  pollMs?: number;
  waitLimitMs?: number;
  /** false: fail at once with RENDER_SLOT_BUSY when another process holds the slot (`--no-wait`). */
  wait?: boolean;
  log?: (message: string) => void;
  /**
   * When this waiter first came, in ms since the epoch: its place in the queue, kept by a waiter that
   * gave the slot back and asks again. Before the last boot or after now, it is ignored. Default: now.
   */
  since?: number;
};

export const HELD_ENV = 'RENDER_SLOT_HELD';
/** The protocol this copy writes and understands; see the top of this file. */
export const PROTOCOL = 2;
const POLL_MS = 2000;
/** Long enough to wait out a whole kit of a pack chain (about 2.4 hours in 2026-10), which then gives way. */
const WAIT_LIMIT_MS = 4 * 60 * 60 * 1000;
/** How long `run` leaves the slot to the next in the queue when the machine is busy outside it (HAR-32). */
const BUSY_BACKOFF_MS = 20_000;
/** A machine check that takes longer than this tells nothing, and `run` goes on without it. */
const CHECK_TIMEOUT_MS = 60_000;
/** A ticket not touched for this long stops counting: its waiter is stuck, or its pid was reused. */
const TICKET_FRESH_MS = 60_000;
/** A ticket silent for this long is removed; a waiter that still runs writes it again in its place. */
const TICKET_FORGET_MS = 15 * 60_000;
const TICKET_NAME = /^(\d{15})-(\d{7})\.json$/;
/** An owner.json still missing after this long means its writer died between mkdir and write. */
const UNWRITTEN_GRACE_MS = 10_000;
const OWNER_FILE = 'owner.json';
/**
 * The manual way out when no render is running and the slot stays held; with `mutexPid`, the pid
 * of an old takeover mutex that still runs and blocks the takeover of a dead owner's slot.
 */
const STUCK_HINT = (dir: string, mutexPid: number | null = null) => (mutexPid === null
  ? `If no render is running, remove the slot by hand: rm -r ${dir}`
  : `If pid ${mutexPid} is not a render taking over this slot, remove the slot and its takeover mutex by hand: rm -r ${dir} ${dir}.takeover`);

/** A render slot refusal: `code` names it (RENDER_SLOT_BUSY, RENDER_SLOT_TIMEOUT), `hint` is the way out. */
export class RenderSlotError extends Error {
  readonly code: string;
  readonly detail: string;
  readonly hint: string;

  constructor(code: string, detail: string, hint: string) {
    super(`${detail} ${hint}`);
    this.name = 'RenderSlotError';
    this.code = code;
    this.detail = detail;
    this.hint = hint;
  }
}

/** The name of the package whose folder holds the working directory, else the folder's name. */
export const defaultRepo = (from = process.cwd()) => {
  for (let dir = from; ; dir = path.dirname(dir)) {
    try {
      const {name} = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {name?: unknown};
      if (typeof name === 'string' && name) return name;
    } catch { /* no package.json here */ }
    if (path.dirname(dir) === dir) return path.basename(from);
  }
};

export const slotDir = () => process.env.RENDER_SLOT_DIR || path.join(os.homedir(), '.cache', 'render-slot');

/** What `npm run <script> -- <args>` looks like for the waiting message. */
export const currentCommand = () => {
  const args = process.argv.slice(2).join(' ');
  const script = process.env.npm_lifecycle_event;
  const base = script ? `npm run ${script}` : path.basename(process.argv[1] ?? 'node');
  return (args ? `${base}${script ? ' --' : ''} ${args}` : base).slice(0, 200);
};

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** When this machine booted, in ms since the epoch. */
const bootTimeMs = () => Date.now() - os.uptime() * 1000;

/** Whether a process of the group `pgid` still runs (EPERM counts as running). */
const groupAlive = (pgid: number) => {
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Whether the owner still runs: its pid or, under `run`, the process group of its command (HAR-166: a
 * `run` killed by SIGKILL leaves its command running there). A slot written before the last boot is
 * dead even when its pid is alive again: after a reboot the pid belongs to another process (EPERM
 * counts as alive).
 */
const ownerAlive = (owner: SlotOwner) => !(Date.parse(owner.startedAt) < bootTimeMs())
  && (alive(owner.pid) || (typeof owner.commandPgid === 'number' && owner.commandPgid > 1 && groupAlive(owner.commandPgid)));

const readOwner = (dir: string): SlotOwner | null => {
  try {
    const owner = JSON.parse(readFileSync(path.join(dir, OWNER_FILE), 'utf8')) as SlotOwner;
    return Number.isInteger(owner.pid) && owner.pid > 0 ? owner : null;
  } catch {
    return null;
  }
};

const ageMs = (dir: string) => {
  try { return Date.now() - statSync(dir).mtimeMs; } catch { return 0; }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `dir` is held by a dead owner (or by a writer that died before writing owner.json). */
/** Whether the owner was written by a newer protocol than this copy's, which never takes it over. */
const newerProtocol = (owner: SlotOwner | null) => typeof owner?.protocol === 'number' && owner.protocol > PROTOCOL;

const isStale = (dir: string, owner: SlotOwner | null) => {
  if (newerProtocol(owner)) return false;
  return owner ? !ownerAlive(owner) : ageMs(dir) > UNWRITTEN_GRACE_MS;
};

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

const inodeOf = (target: string) => {
  try { return statSync(target).ino; } catch { return null; }
};

/** What a process saw at a takeover mutex path: which directory (inode) and how old it was. */
export type MutexSighting = {ino: number; ageMs: number};

export const sightMutex = (mutex: string): MutexSighting | null => {
  try {
    const stats = statSync(mutex);
    return {ino: stats.ino, ageMs: Date.now() - stats.mtimeMs};
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
};

const HOLDER_FILE = 'holder.json';
const CLAIM_DIR = 'clearing';

/**
 * The inode of the mutex at the path while its holder.json holds `token`, else null. Any error
 * (the path gone or replaced, holder.json not written yet) counts as "not this process's mutex".
 */
export const ownMutexInode = (mutex: string, token: string): number | null => {
  try {
    const {ino} = statSync(mutex);
    return (JSON.parse(readFileSync(path.join(mutex, HOLDER_FILE), 'utf8')) as {token?: unknown}).token === token ? ino : null;
  } catch {
    return null;
  }
};

/**
 * Marks the directory just made at `mutex` as this process's: holder.json created exclusively, then
 * read back. Its inode, or null when the directory at the path is not the one made here; any error
 * counts as that, never as a crash (APFS answers EINVAL when the directory goes during the create).
 */
export const markMutex = (mutex: string): number | null => {
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  try {
    writeFileSync(path.join(mutex, HOLDER_FILE), `${JSON.stringify({pid: process.pid, token})}\n`, {flag: 'wx'});
  } catch {
    return null;
  }
  return ownMutexInode(mutex, token);
};

/**
 * Takes the takeover mutex: an atomic mkdir, then markMutex, whose inode the caller keeps. Null when
 * another process holds it, or when the directory at the path is no longer the one made here (an
 * orphan left by that is cleared after the grace).
 */
export const takeMutex = (mutex: string): number | null => {
  try {
    mkdirSync(mutex);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null;
    throw error;
  }
  return markMutex(mutex);
};

/**
 * A name to move a mutex aside to. The random part never repeats across processes: a directory
 * left by a process that died between the move and the delete does not collide with a later
 * process that got the same pid.
 */
export const asideName = (mutex: string) => `${mutex}.stale-${process.pid}-${randomBytes(8).toString('hex')}`;
const ASIDE_TRIES = 3;
/** What rename answers when its target name is already taken by a directory or a file. */
const NAME_TAKEN = new Set(['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR']);

/**
 * Deletes a mutex directory moved aside. A clearer whose path lookup ran before the move can still
 * create its claim inside while the delete runs (ENOTEMPTY): the delete walks the directory again,
 * and a leftover is only a stray directory next to the mutex, never a reason to fail the render.
 */
const discardAside = (aside: string) => {
  try { rmSync(aside, {recursive: true, force: true, maxRetries: 5, retryDelay: 1}); } catch { /* left as a stray directory */ }
};

/**
 * Removes the mutex directory whose inode is `ino`, and never another one: the path is renamed to a
 * unique name first, and the moved directory is deleted only when its inode is `ino`. A live mutex
 * moved by mistake goes back when the path is still free. When that can happen is at the top of
 * this file. On a file system that reuses an inode at once (not APFS), a recreated mutex can match.
 * A name already taken is replaced by another; when every try is taken, the mutex stays and the
 * answer is false, never an error.
 */
const removeMutexIfSame = (mutex: string, ino: number, nameAside = asideName) => {
  let aside: string | null = null;
  for (let tries = 0; aside === null && tries < ASIDE_TRIES; tries += 1) {
    const candidate = nameAside(mutex);
    try {
      renameSync(mutex, candidate);
      aside = candidate;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return false;
      if (!NAME_TAKEN.has(code ?? '')) throw error;
    }
  }
  if (aside === null) return false;
  if (inodeOf(aside) === ino) {
    discardAside(aside);
    return true;
  }
  try {
    renameSync(aside, mutex);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    // The path holds a newer mutex: the holder of the one moved here never removes that newer one.
    discardAside(aside);
  }
  return false;
};

/** Leaves the critical section: removes the mutex only while the one at the path is still this one. */
export const releaseMutex = (mutex: string, ino: number, nameAside = asideName) => removeMutexIfSame(mutex, ino, nameAside);

/**
 * The pid in the holder.json at the mutex path while it still runs, by the rule of ownerAlive: a
 * holder.json written before the last boot is dead. Null when holder.json is unreadable (age alone
 * decides then) and when it names this process: a process clears a mutex only while it holds none,
 * so its own holder.json there is an orphan it left (a mutex it gave up on or failed to move).
 */
const runningHolder = (mutex: string): number | null => {
  const file = path.join(mutex, HOLDER_FILE);
  try {
    const {pid} = JSON.parse(readFileSync(file, 'utf8')) as {pid?: unknown};
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    return !(statSync(file).mtimeMs < bootTimeMs()) && alive(pid) ? pid : null;
  } catch {
    return null;
  }
};

/** The pid of a takeover mutex older than the grace whose holder still runs, which no clearer removes. */
const blockingMutexHolder = (mutex: string) => {
  const seen = sightMutex(mutex);
  return seen !== null && seen.ageMs > UNWRITTEN_GRACE_MS ? runningHolder(mutex) : null;
};

/**
 * Clears a mutex left by a taker that died, given what was seen at its path: nothing when the
 * sighting is not older than the grace, and only the directory seen, never one made after it. The
 * directory is claimed first (<mutex>/clearing), so one clearer removes it and the others, even
 * those whose claim lands in a newer mutex, leave the path alone. True when this process removed it.
 */
export const clearStaleMutex = (mutex: string, seen: MutexSighting) => {
  if (seen.ageMs <= UNWRITTEN_GRACE_MS) return false;
  // Old but held by a process that still runs (stopped for a while, as in a sleep of the Mac).
  if (runningHolder(mutex) !== null) return false;
  const claim = path.join(mutex, CLAIM_DIR);
  try {
    mkdirSync(claim);
  } catch (error) {
    // Gone (ENOENT), or claimed by another clearer, which is left alone until its claim is older
    // than the grace (that clearer died).
    if (errorCode(error) !== 'EEXIST' || ageMs(claim) <= UNWRITTEN_GRACE_MS) return false;
    return removeMutexIfSame(mutex, seen.ino);
  }
  if (inodeOf(mutex) !== seen.ino) {
    // The claim landed in a newer mutex: take it back out and leave that mutex at its path.
    try { rmdirSync(claim); } catch { /* its holder removed the mutex already */ }
    return false;
  }
  return removeMutexIfSame(mutex, seen.ino);
};

/**
 * Removes a dead owner's slot under the takeover mutex, after checking again that the same dead
 * owner still holds it: a slot someone took in between is never touched. False when another
 * process is taking it over now. A mutex left by a taker that died is cleared after the grace.
 */
const takeOverStale = (dir: string, stalePid: number | null) => {
  const mutex = `${dir}.takeover`;
  const ino = takeMutex(mutex);
  if (ino === null) {
    const seen = sightMutex(mutex);
    return seen === null || clearStaleMutex(mutex, seen);
  }
  try {
    const owner = readOwner(dir);
    if ((owner?.pid ?? null) === stalePid && isStale(dir, owner)) rmSync(dir, {recursive: true, force: true});
  } finally {
    releaseMutex(mutex, ino);
  }
  return true;
};

/**
 * Takes the slot away in one step for every reader, then deletes it (BGC-36, 2026-10-17): a recursive rm of
 * the slot itself unlinks owner.json before the directory, and a waiter that looked in between logged a slot
 * "still writing its owner file" that was only being released (the second wait message, with the machine full).
 */
const removeSlotDir = (dir: string) => {
  const gone = `${dir}.released-${process.pid}-${Date.now()}`;
  try {
    renameSync(dir, gone);
  } catch {
    rmSync(dir, {recursive: true, force: true});
    return;
  }
  rmSync(gone, {recursive: true, force: true});
};

/** Removes the slot only when this process owns it. */
export const releaseRenderSlot = (dir = slotDir()) => {
  if (readOwner(dir)?.pid !== process.pid) return false;
  removeSlotDir(dir);
  if (process.env[HELD_ENV] === String(process.pid)) delete process.env[HELD_ENV];
  return true;
};

const noopHandle = (): SlotHandle => ({release: () => {}, inherited: true});

export const describeSlotHolder = (owner: SlotOwner | null) => {
  if (!owner) return 'held by a process that is still writing its owner file';
  const held = `held by pid ${owner.pid} (${owner.repo}: ${owner.command}) since ${owner.startedAt}`;
  return newerProtocol(owner)
    ? `${held}, written by render-slot protocol ${owner.protocol} while this copy speaks ${PROTOCOL}: update this copy from ~/obsidian/AI/scripts/render-slot.ts`
    : held;
};

const exists = (dir: string) => {
  try { statSync(dir); return true; } catch { return false; }
};

/** Who holds the slot, when a live process does: undefined when it is free or stale (the next taker takes it over). */
export const renderSlotHolder = (dir = slotDir()): {owner: SlotOwner | null} | undefined => {
  if (!exists(dir)) return undefined;
  const owner = readOwner(dir);
  return isStale(dir, owner) ? undefined : {owner};
};

/** The folder of the queue of waiters, next to the slot (see the top of this file). */
export const queueDir = (dir = slotDir()) => `${dir}.queue`;

/** A waiter in the queue: arrival in ms since the epoch, and how long its ticket has gone untouched. */
export type QueueTicket = {name: string; pid: number; enqueuedAt: number; repo: string; command: string; silentMs: number};

const ticketName = (at: number, pid: number) => `${String(at).padStart(15, '0')}-${String(pid).padStart(7, '0')}.json`;

const removeQuietly = (file: string) => {
  try { rmSync(file, {force: true}); } catch { /* left for the next waiter to judge */ }
};

/** The tickets in arrival order, and the temporary files that dead writers left over 15 minutes ago. */
const readQueue = (queue: string): {tickets: QueueTicket[]; strays: string[]} => {
  let names: string[];
  try { names = readdirSync(queue).sort(); } catch { return {tickets: [], strays: []}; }
  const tickets: QueueTicket[] = [];
  const strays: string[] = [];
  for (const name of names) {
    let silentMs: number;
    try { silentMs = Date.now() - statSync(path.join(queue, name)).mtimeMs; } catch { continue; }
    const match = TICKET_NAME.exec(name);
    if (!match) {
      if (name.endsWith('.tmp') && silentMs > TICKET_FORGET_MS) strays.push(name);
      continue;
    }
    let repo = '?';
    let command = '?';
    try {
      const data = JSON.parse(readFileSync(path.join(queue, name), 'utf8')) as {repo?: unknown; command?: unknown};
      if (typeof data.repo === 'string') repo = data.repo;
      if (typeof data.command === 'string') command = data.command;
    } catch { /* the name alone places it */ }
    tickets.push({name, pid: Number(match[2]), enqueuedAt: Number(match[1]), repo, command, silentMs});
  }
  return {tickets, strays};
};

/**
 * 'gone' (any waiter removes it): its pid is dead, it was written before the last boot, or it has been
 * silent for 15 minutes; 'quiet' (skipped, kept): silent for over a minute; 'live' otherwise. With
 * `judgeSilence` false (this process woke up less than a minute ago), silence decides nothing.
 */
const judgeTicket = (ticket: QueueTicket, judgeSilence: boolean): 'live' | 'quiet' | 'gone' => {
  if (ticket.enqueuedAt < bootTimeMs() || !alive(ticket.pid)) return 'gone';
  if (!judgeSilence) return 'live';
  if (ticket.silentMs > TICKET_FORGET_MS) return 'gone';
  return ticket.silentMs > TICKET_FRESH_MS ? 'quiet' : 'live';
};

/** The live waiters, in the order they came. Read only: nothing is removed. */
export const renderSlotQueue = (dir = slotDir()): QueueTicket[] =>
  readQueue(queueDir(dir)).tickets.filter((ticket) => judgeTicket(ticket, true) === 'live');

/**
 * The live tickets ahead of `own`, or all of them when `own` is null, in order. Gone tickets and old
 * temporary files are removed on the way; quiet tickets are skipped.
 */
const ticketsAhead = (queue: string, own: string | null, judgeSilence: boolean): QueueTicket[] => {
  const {tickets, strays} = readQueue(queue);
  for (const stray of strays) removeQuietly(path.join(queue, stray));
  const ahead: QueueTicket[] = [];
  for (const ticket of tickets) {
    if (own !== null && ticket.name >= own) break;
    const verdict = judgeTicket(ticket, judgeSilence);
    if (verdict === 'gone') removeQuietly(path.join(queue, ticket.name));
    else if (verdict === 'live') ahead.push(ticket);
  }
  return ahead;
};

/** Writes a ticket through a temporary file and a rename; false when the queue cannot be written. */
const writeTicket = (queue: string, name: string, body: string) => {
  const temporary = path.join(queue, `.${name}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    mkdirSync(queue, {recursive: true});
    writeFileSync(temporary, body);
    renameSync(temporary, path.join(queue, name));
    return true;
  } catch {
    removeQuietly(temporary);
    return false;
  }
};

/** The heartbeat: touches the ticket, or writes it again under the same name when it was removed. */
const touchTicket = (queue: string, name: string, body: string) => {
  const now = new Date();
  try { utimesSync(path.join(queue, name), now, now); } catch { writeTicket(queue, name, body); }
};

const describeTicket = (ticket: QueueTicket) => `pid ${ticket.pid} (${ticket.repo}: ${ticket.command}) since ${new Date(ticket.enqueuedAt).toISOString()}`;

/** Takes the slot directory with the atomic mkdir: false when another process has it. */
const makeSlotDir = (dir: string) => {
  try {
    mkdirSync(dir);
    return true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    return false;
  }
};

/**
 * Waits for the machine-wide render slot, in the order of the queue, and takes it. The slot is
 * released by `release()`, on exit, and on SIGINT/SIGTERM. Nested calls in the same process and
 * children of the owner (RENDER_SLOT_HELD) run under the slot they already hold.
 */
export const acquireRenderSlot = async (options: SlotOptions): Promise<SlotHandle> => {
  const dir = options.dir ?? slotDir();
  const queue = queueDir(dir);
  // The heartbeat beats well inside a minute, whatever pollMs the caller asks for.
  const roundMs = Math.min(options.pollMs ?? POLL_MS, TICKET_FRESH_MS / 4);
  const waitLimitMs = options.waitLimitMs ?? WAIT_LIMIT_MS;
  const log = options.log ?? ((message: string) => console.log(message));
  const repo = options.repo ?? defaultRepo();
  const body = `${JSON.stringify({protocol: PROTOCOL, pid: process.pid, repo, command: options.command})}\n`;
  const started = Date.now();
  // The place in the queue: when this waiter first came, never before the last boot nor after now.
  const {since} = options;
  const arrival = since !== undefined && since >= bootTimeMs() && since <= started ? Math.floor(since) : started;
  let said = '';
  let warnedBlocked = false;
  let ticket: string | null = null;
  let lastRound = started;
  // A waiter that just started judges silence at once; only one that finds it slept waits a minute.
  let awakeSince = started - TICKET_FRESH_MS;

  // A new message only when the holder or the place in the queue changes.
  const say = (status: string, message: string) => {
    if (status !== said) log(message);
    said = status;
  };
  const dropTicket = () => {
    if (ticket !== null) removeQuietly(path.join(queue, ticket));
    ticket = null;
  };
  const onQueueExit = () => { dropTicket(); };
  const onQueueSignal = (signal: NodeJS.Signals) => {
    dropTicket();
    // Without another handler, Node would keep running once this one returns.
    if (process.listenerCount(signal) === 0) process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const joinQueue = () => {
    if (ticket !== null) return;
    const name = ticketName(arrival, process.pid);
    // A queue that cannot be written leaves this waiter without a ticket: it waits behind every
    // live ticket, as before the queue existed.
    if (!writeTicket(queue, name, body)) return;
    ticket = name;
    process.once('exit', onQueueExit);
    process.once('SIGINT', onQueueSignal);
    process.once('SIGTERM', onQueueSignal);
  };
  const leaveQueue = () => {
    dropTicket();
    process.off('exit', onQueueExit);
    process.off('SIGINT', onQueueSignal);
    process.off('SIGTERM', onQueueSignal);
  };

  mkdirSync(path.dirname(dir), {recursive: true});
  try {
    for (;;) {
      const current = readOwner(dir);
      if (current?.pid === process.pid) return noopHandle();
      const held = Number(process.env[HELD_ENV]);
      if (current && current.pid === held && ownerAlive(current)) return noopHandle();
      const now = Date.now();
      // A round far later than the last one means this process slept (a sleep of the Mac). So did the
      // other waiters: their silence means nothing until they have had a minute to touch their tickets.
      if (now - lastRound > TICKET_FRESH_MS) awakeSince = now;
      lastRound = now;
      if (ticket !== null) touchTicket(queue, ticket, body);
      const ahead = ticketsAhead(queue, ticket, now - awakeSince >= TICKET_FRESH_MS);
      const next = ahead[0];
      let waitingFor: string;
      let wayOut: string;
      if (next === undefined) {
        if (makeSlotDir(dir)) {
          const owner: SlotOwner = {protocol: PROTOCOL, pid: process.pid, repo, command: options.command, startedAt: new Date().toISOString()};
          const temporary = path.join(dir, `${OWNER_FILE}.tmp`);
          writeFileSync(temporary, `${JSON.stringify(owner, null, 2)}\n`);
          renameSync(temporary, path.join(dir, OWNER_FILE));
          process.env[HELD_ENV] = String(process.pid);
          // The finally below takes the ticket out.
          const onExit = () => { releaseRenderSlot(dir); };
          const onSignal = (signal: NodeJS.Signals) => {
            releaseRenderSlot(dir);
            // Without another handler, Node would keep running once this one returns.
            if (process.listenerCount(signal) === 0) process.exit(signal === 'SIGINT' ? 130 : 143);
          };
          process.once('exit', onExit);
          process.once('SIGINT', onSignal);
          process.once('SIGTERM', onSignal);
          return {
            inherited: false,
            release: () => {
              releaseRenderSlot(dir);
              process.off('exit', onExit);
              process.off('SIGINT', onSignal);
              process.off('SIGTERM', onSignal);
            },
          };
        }
        const owner = readOwner(dir);
        // Freed between the mkdir above and this read (BGC-36): the next round takes it, at once and without a message.
        if (owner === null && !exists(dir)) continue;
        const stale = isStale(dir, owner);
        if (stale && takeOverStale(dir, owner?.pid ?? null)) continue;
        // A dead owner's slot whose takeover waits on an old mutex of a pid that still runs.
        const blocker = stale ? blockingMutexHolder(`${dir}.takeover`) : null;
        const holder = blocker === null
          ? describeSlotHolder(owner)
          : `${describeSlotHolder(owner)}, whose takeover waits on the mutex ${dir}.takeover, held for over 10 seconds by pid ${blocker}, which still runs`;
        const hint = STUCK_HINT(dir, blocker);
        if (options.wait === false) throw new RenderSlotError('RENDER_SLOT_BUSY', `Another render holds the render slot (${dir}), ${holder}.`, `Run again when it ends. ${hint}`);
        joinQueue();
        say(`held ${owner?.pid ?? 'unwritten'}`, `Waiting for the render slot, ${holder}.`);
        if (blocker !== null && !warnedBlocked) { log(`The takeover of the render slot waits on pid ${blocker}. ${hint}`); warnedBlocked = true; }
        waitingFor = holder;
        // No promise of an automatic takeover while a mutex of a live pid blocks it.
        wayOut = `${blocker === null ? 'Run again when that render ends; a slot whose pid is gone is taken over automatically. ' : ''}${hint}`;
      } else {
        // Waiters that came first: the first of them takes the slot when it frees.
        const state = renderSlotHolder(dir);
        const slot = state === undefined ? 'free for the first in the queue' : describeSlotHolder(state.owner);
        const queued = `${ahead.length} ahead in the queue, the next ${describeTicket(next)}`;
        if (options.wait === false) throw new RenderSlotError('RENDER_SLOT_BUSY', `The render slot (${dir}) is ${slot}, and ${queued}.`, 'Run again when they are done.');
        joinQueue();
        say(`queue ${ahead.length} ${next.name} ${state?.owner?.pid ?? 'free'}`, `Waiting for the render slot, ${slot}; ${queued}.`);
        waitingFor = `${slot}, with ${queued}`;
        wayOut = 'Run again when they are done; a waiter whose pid is gone leaves the queue automatically.';
      }
      if (Date.now() - started > waitLimitMs) {
        throw new RenderSlotError('RENDER_SLOT_TIMEOUT', `Gave up after ${Math.round(waitLimitMs / 60_000)} minutes waiting for the render slot (${dir}), ${waitingFor}.`, wayOut);
      }
      await sleep(roundMs);
    }
  } finally {
    leaveQueue();
  }
};

/** Runs `task` holding the render slot, and releases it however `task` ends. */
export const withRenderSlot = async <T>(task: () => Promise<T>, options: Partial<SlotOptions> = {}): Promise<T> => {
  const slot = await acquireRenderSlot({command: currentCommand(), ...options});
  try {
    return await task();
  } finally {
    slot.release();
  }
};

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const EXIT_USAGE = 2;
const EXIT_GAVE_UP = 75;

/** Why `run` refuses this command line, or null: a .sh script, run directly or through a shell. */
export const refusedCommand = (command: string[]) => {
  const [program, ...args] = command;
  if (program === undefined) return 'Nothing to run: render-slot run -- <command> [args].';
  const name = path.basename(program);
  const script = name.endsWith('.sh') ? program : SHELLS.has(name) ? args.find((arg) => !arg.startsWith('-') && arg.endsWith('.sh')) : undefined;
  if (script === undefined) return null;
  return `Refused: ${script} is a chain of steps. The render slot covers each heavy step, never the script that chains them: run each heavy step inside it with render-slot run.`;
};

/** Sends `signal` to the process group `child` leads (`run` spawns it detached), else to `child` alone. */
const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid !== undefined && child.pid > 1) {
    try { process.kill(-child.pid, signal); return; } catch { /* no group of its own: the command alone */ }
  }
  try { child.kill(signal); } catch { /* gone meanwhile */ }
};

/**
 * Writes the process group of the command into owner.json (commandPgid), when this process owns the
 * slot: a SIGKILL to `run` leaves the command running in it, and the slot stays held until it ends.
 */
const recordCommandGroup = (dir: string, pgid: number) => {
  try {
    const owner = readOwner(dir);
    if (owner?.pid !== process.pid) return;
    const temporary = path.join(dir, `${OWNER_FILE}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({...owner, commandPgid: pgid}, null, 2)}\n`);
    renameSync(temporary, path.join(dir, OWNER_FILE));
  } catch { /* best effort: without it, the pid alone decides, as before */ }
};

/** The machine check `run` asks with the slot in hand (HAR-32): the vault's, which every copy reaches. */
const machineCheckScript = () => path.join(os.homedir(), 'obsidian', 'AI', 'scripts', 'maquina_livre.py');

/**
 * Asks the machine check, with the slot in hand, about what the slot does not cover (HAR-32). `busy` is
 * its reason on the answer 3, and null on any other: 0 (free), 4 (not sure) or a check that is missing,
 * fails or times out, which `note` names, so a broken check never keeps a render from running.
 */
const checkMachine = async (dir: string, timeoutMs: number): Promise<{busy: string | null; note: string | null}> => {
  const own = process.env.RENDER_SLOT_CHECK ?? '';
  if (own === 'off') return {busy: null, note: null};
  const script = machineCheckScript();
  if (own === '' && !exists(script)) return {busy: null, note: `The machine check ${script} is missing: running without it.`};
  const [program, first] = own === '' ? ['python3', [script]] : [own, []];
  const env: NodeJS.ProcessEnv = {...process.env, RENDER_SLOT_DIR: dir};
  // Under the slot RENDER_SLOT_HELD names, the check looks only at the disk and at renders outside the
  // slot; without it, the slot of this process counts as its family's, and memory and the game count too.
  delete env[HELD_ENV];
  const answer = await new Promise<{status: number | null; out: string; failure: string | null}>((resolve) => {
    let out = '';
    const check = spawn(program, [...first, '--json', '--fora-da-trava', '--familia', String(process.pid)], {env, stdio: ['ignore', 'pipe', 'ignore']});
    // Not spawn's own timeout: its timer outlives a check that never started, and kept `run` alive 60 s after its command.
    const timer = setTimeout(() => check.kill('SIGKILL'), timeoutMs);
    const done = (status: number | null, failure: string | null) => { clearTimeout(timer); resolve({status, out, failure}); };
    check.stdout?.on('data', (chunk: Buffer) => { out += String(chunk); });
    check.on('error', (error: Error) => done(null, error.message));
    check.on('close', (status: number | null, signal: NodeJS.Signals | null) => done(status, signal === null ? null : `stopped by ${signal} after ${timeoutMs / 1000} s`));
  });
  let said: {reasons?: unknown; nao_sei?: unknown} = {};
  try { said = JSON.parse(answer.out) as typeof said; } catch { /* not JSON: its last line is the reason */ }
  const lastLine = answer.out.trim().split('\n').pop() ?? '';
  if (answer.status === 3) return {busy: Array.isArray(said.reasons) && said.reasons.length > 0 ? said.reasons.join('; ') : lastLine || 'no reason given', note: null};
  if (answer.status === 0) return {busy: null, note: null};
  if (answer.status === 4) return {busy: null, note: `The machine check could not tell${typeof said.nao_sei === 'string' ? ` (${said.nao_sei})` : ''}: running anyway.`};
  return {busy: null, note: `The machine check failed (${answer.failure ?? `exit ${answer.status}`}): running without it.`};
};

/** What only `run` takes (HAR-32): how long it leaves the slot to the next when the machine is busy, and how long the check may take. */
export type RunOptions = {backoffMs?: number; checkTimeoutMs?: number};

/**
 * Takes the slot for `run` on a machine free besides it (HAR-32). With the slot in hand it asks the machine
 * check; on busy it gives the slot back, says why (once per reason), leaves the slot to the next in the
 * queue for backoffMs, without a ticket, and asks again with `since`, the moment it first came, which keeps
 * its place: it never goes ahead of anyone who came before it. The wait limit counts from that moment, so a
 * machine that stays busy ends in RENDER_SLOT_TIMEOUT, as a slot that stays held does; with wait false, in
 * RENDER_SLOT_BUSY at once. A slot it inherits is not checked: its parent took it.
 */
const takeSlotToRun = async (options: SlotOptions & RunOptions): Promise<SlotHandle> => {
  const {backoffMs = BUSY_BACKOFF_MS, checkTimeoutMs = CHECK_TIMEOUT_MS, ...slotOptions} = options;
  const log = slotOptions.log ?? ((message: string) => console.log(message));
  const since = slotOptions.since ?? Date.now();
  const waitLimitMs = slotOptions.waitLimitMs ?? WAIT_LIMIT_MS;
  let gaveBack = 0;
  let said = '';
  for (;;) {
    let slot: SlotHandle;
    try {
      slot = await acquireRenderSlot({...slotOptions, since, waitLimitMs: Math.max(0, waitLimitMs - (Date.now() - since))});
    } catch (error) {
      if (!(error instanceof RenderSlotError) || gaveBack === 0) throw error;
      throw new RenderSlotError(error.code, `${error.detail} It had given the slot back ${gaveBack}× since ${new Date(since).toISOString()}, the machine busy outside it: ${said}.`, error.hint);
    }
    if (slot.inherited) return slot;
    const {busy, note} = await checkMachine(slotOptions.dir ?? slotDir(), checkTimeoutMs);
    if (note !== null) log(note);
    if (busy === null) return slot;
    slot.release();
    gaveBack += 1;
    const waited = Date.now() - since;
    if (slotOptions.wait === false || waited >= waitLimitMs) {
      throw new RenderSlotError(slotOptions.wait === false ? 'RENDER_SLOT_BUSY' : 'RENDER_SLOT_TIMEOUT', `The machine is busy outside the render slot (${busy}): gave the slot back ${gaveBack}× since ${new Date(since).toISOString()}.`, 'Run again once it is free; python3 ~/obsidian/AI/scripts/maquina_livre.py says what keeps it busy.');
    }
    if (busy !== said) log(`The machine is busy outside the render slot: ${busy}. Gave the slot back; asking again in ${backoffMs / 1000} s, in the place it first came (${new Date(since).toISOString()}).`);
    said = busy;
    await sleep(Math.min(backoffMs, waitLimitMs - waited));
  }
};

/**
 * `render-slot run -- <cmd> [args]`: waits for the slot and a machine free besides it (takeSlotToRun), runs the command holding it, and resolves to
 * the exit status. The slot is released only once the command has exited and, after a signal, once
 * nothing of its process group runs.
 */
export const runCommand = async (command: string[], options: Partial<SlotOptions> & RunOptions = {}): Promise<number> => {
  const refusal = refusedCommand(command);
  if (refusal !== null) {
    console.error(refusal);
    return EXIT_USAGE;
  }
  const [program = '', ...args] = command;
  let child: ChildProcess | null = null;
  const forwarded = new Set<NodeJS.Signals>();
  // Registered before the slot's own handlers: while waiting, a signal leaves the queue (the 'exit'
  // handlers take the ticket and the slot out); while the command runs, it goes to the command's whole
  // process group, a step nested under a shell too (HAR-166).
  const onSignal = (signal: NodeJS.Signals) => {
    if (child === null) process.exit(128 + (os.constants.signals[signal] ?? 15));
    forwarded.add(signal);
    signalGroup(child, signal);
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  try {
    let slot: SlotHandle;
    try {
      slot = await takeSlotToRun({command: command.join(' ').slice(0, 200), log: (message) => console.error(message), ...options});
    } catch (error) {
      if (!(error instanceof RenderSlotError)) throw error;
      console.error(error.message);
      return EXIT_GAVE_UP;
    }
    // The slot's own signal handlers would release it at once, while the command still runs: only
    // onSignal stays, and the slot is released below, or by its 'exit' handler.
    for (const signal of SIGNALS) for (const listener of process.listeners(signal)) if (listener !== onSignal) process.off(signal, listener);
    try {
      // Detached: the command leads a process group of its own, which a forwarded signal reaches whole.
      const started = spawn(program, args, {stdio: 'inherit', detached: true});
      child = started;
      if (started.pid !== undefined) recordCommandGroup(options.dir ?? slotDir(), started.pid);
      const status = await new Promise<number>((resolve) => {
        started.on('error', (error: Error) => { console.error(`Could not run ${program}: ${error.message}`); resolve(127); });
        started.on('exit', (status: number | null, signal: NodeJS.Signals | null) => resolve(status ?? 128 + (signal ? os.constants.signals[signal] ?? 15 : 0)));
      });
      // After a signal, a step nested under a shell that died can still be rendering: the slot waits for
      // the whole group. A command that exits by itself gives the slot back at once.
      if (forwarded.size > 0 && started.pid !== undefined) while (groupAlive(started.pid)) await sleep(50);
      return status;
    } finally {
      slot.release();
    }
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal);
  }
};

export const HOLD_PREFIX = 'hold: ';
const LABEL = /^[\w.-]{1,60}$/;
const HOLD_MAX_MINUTES = 240;

/** Why `hold` or `release` refuses its options, or null. */
export const refusedHold = (label: string | undefined, maxMinutes?: number) => {
  if (label === undefined || !LABEL.test(label)) return 'Usage: render-slot hold --rotulo <label> --max <minutes>; the label is 1 to 60 letters, digits, ".", "_" or "-".';
  if (maxMinutes !== undefined && !(maxMinutes > 0 && maxMinutes <= HOLD_MAX_MINUTES)) return `--max is the minutes the hold may last, more than 0 and at most ${HOLD_MAX_MINUTES}.`;
  return null;
};

/**
 * `render-slot hold --rotulo <label> --max <minutes>`: waits for the slot, holds it as "hold: <label>"
 * until a signal (what `release` sends) or the deadline, and resolves to the exit status.
 */
export const holdSlot = async (label: string, maxMinutes: number, options: Partial<SlotOptions> = {}): Promise<number> => {
  const refusal = refusedHold(label, maxMinutes);
  if (refusal !== null) {
    console.error(refusal);
    return EXIT_USAGE;
  }
  let stop: ((why: string) => void) | null = null;
  // While waiting, a signal (what `release` sends) leaves the queue: the 'exit' handlers take the ticket out.
  const onSignal = (signal: NodeJS.Signals) => {
    if (stop === null) process.exit(128 + (os.constants.signals[signal] ?? 15));
    stop(signal);
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  try {
    let slot: SlotHandle;
    try {
      slot = await acquireRenderSlot({command: `${HOLD_PREFIX}${label}`, log: (message) => console.error(message), ...options});
    } catch (error) {
      if (!(error instanceof RenderSlotError)) throw error;
      console.error(error.message);
      return EXIT_GAVE_UP;
    }
    // Only onSignal stays: the slot is released below, once, whatever ends the hold.
    for (const signal of SIGNALS) for (const listener of process.listeners(signal)) if (listener !== onSignal) process.off(signal, listener);
    try {
      console.log(`Holding the render slot as "${HOLD_PREFIX}${label}" (pid ${process.pid}) for at most ${maxMinutes} minutes, until \`render-slot release --rotulo ${label}\`. Heavy commands of this task: ${HELD_ENV}=${process.pid} <command>.`);
      const why = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('deadline'), maxMinutes * 60_000);
        stop = (signal) => { clearTimeout(timer); resolve(signal); };
      });
      console.log(why === 'deadline' ? `Released the render slot: --max ${maxMinutes} minutes passed.` : `Released the render slot (${why}).`);
      return 0;
    } finally {
      slot.release();
    }
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal);
  }
};

/** `render-slot release --rotulo <label>`: ends the live hold of that label, holding the slot or queued. */
export const releaseHold = async (label: string, dir = slotDir(), waitMs = 10_000): Promise<number> => {
  const refusal = refusedHold(label);
  if (refusal !== null) {
    console.error(refusal);
    return EXIT_USAGE;
  }
  const command = `${HOLD_PREFIX}${label}`;
  const owner = renderSlotHolder(dir)?.owner ?? null;
  const pids = new Set<number>();
  if (owner?.command === command && ownerAlive(owner)) pids.add(owner.pid);
  for (const ticket of renderSlotQueue(dir)) if (ticket.command === command && alive(ticket.pid)) pids.add(ticket.pid);
  if (pids.size === 0) {
    console.error(`No live hold named "${label}" holds or waits for the render slot (${dir}).`);
    return 1;
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone meanwhile */ }
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until && [...pids].some((pid) => alive(pid))) await sleep(50);
  const left = [...pids].filter((pid) => alive(pid));
  if (left.length > 0) {
    console.error(`The hold "${label}" (pid ${left.join(', ')}) did not exit in ${Math.round(waitMs / 1000)} seconds.`);
    return 1;
  }
  console.log(`Released the hold "${label}".`);
  return 0;
};

/** Claude Code's folder, with sessions/<pid>.json and the job band watch.json: CLAUDE_CONFIG_DIR, else ~/.claude. */
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** The parent of every pid that runs, from `ps`; empty when `ps` cannot run. */
const processTable = () => {
  const parents = new Map<number, number>();
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], {encoding: 'utf8'});
  for (const line of (listed.stdout ?? '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && ppid !== undefined && Number.isInteger(pid) && Number.isInteger(ppid) && pid > 0) parents.set(pid, ppid);
  }
  return parents;
};

/** `pid` and its ancestors, nearest first, down to (not including) pid 1. */
const lineage = (pid: number, parents: Map<number, number>) => {
  const line: number[] = [];
  for (let at = pid; at > 1 && !line.includes(at); at = parents.get(at) ?? 0) line.push(at);
  return line;
};

/** Every pid under `pid`, at any depth. */
const progeny = (pid: number, parents: Map<number, number>) => {
  const found = new Set<number>([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of parents) {
      if (found.has(parent) && !found.has(child)) { found.add(child); grew = true; }
    }
  }
  found.delete(pid);
  return found;
};

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,}$/;

/** The id8 of the Claude Code session above `pid`: the first of its line with a <pid>.json in sessions/. */
const sessionAbove = (pid: number, parents: Map<number, number>, home = claudeDir()) => {
  for (const at of lineage(pid, parents)) {
    try {
      const {sessionId} = JSON.parse(readFileSync(path.join(home, 'sessions', `${at}.json`), 'utf8')) as {sessionId?: unknown};
      if (typeof sessionId === 'string' && SESSION_ID.test(sessionId)) return sessionId.slice(0, 8);
    } catch { /* no session at this pid */ }
  }
  return null;
};

/** The log of the first job band entry (watch.json) whose pid is `pid`, one of its ancestors or one under it. */
const jobLog = (pid: number, parents: Map<number, number>, home = claudeDir()) => {
  let band: unknown;
  try { band = JSON.parse(readFileSync(path.join(home, 'watch.json'), 'utf8')); } catch { return null; }
  const jobs: unknown = Array.isArray(band) ? band : (band as {jobs?: unknown} | null)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const related = new Set([...lineage(pid, parents), ...progeny(pid, parents)]);
  for (const job of jobs as ({pid?: unknown; log?: unknown} | null)[]) {
    if (typeof job?.pid === 'number' && related.has(job.pid) && typeof job.log === 'string') return job.log;
  }
  return null;
};

/** The last line of `file` that says something, after the last carriage return of a progress bar; null when unreadable. */
const lastLogLine = (file: string) => {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 8192);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split(/[\r\n]+/).map((line) => line.trim()).filter((line) => line !== '');
    return (lines[lines.length - 1] ?? '(empty)').slice(0, 200);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
};

/** `ms` as local "YYYY-MM-DD HH:MM", with the whole minutes since then. */
const localSince = (ms: number, now: number) => {
  const at = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())} (${Math.max(0, Math.floor((now - ms) / 60_000))} min ago)`;
};

/**
 * `render-slot status` (HAR-167): who holds the slot and who waits in the queue, each with the pid, the
 * repo, the command, since when, the Claude Code session and the last line of its job's log. Read only.
 */
export const slotStatus = (dir = slotDir(), now = Date.now()) => {
  const parents = processTable();
  const about = (pid: number, since: number, repo: string, command: string) => {
    const head = `pid ${pid} (${repo}: ${command}) since ${localSince(since, now)}, session ${sessionAbove(pid, parents) ?? 'unknown'}`;
    const log = jobLog(pid, parents);
    return log === null ? [head] : [head, `    log ${log}: ${lastLogLine(log) ?? '(cannot be read)'}`];
  };
  const lines: string[] = [];
  const owner = exists(dir) ? readOwner(dir) : null;
  if (!exists(dir)) {
    lines.push(`The render slot (${dir}) is free.`);
  } else if (renderSlotHolder(dir) === undefined) {
    const gone = owner === null ? 'its owner never wrote owner.json' : `pid ${owner.pid} (${owner.repo}: ${owner.command}), which took it at ${localSince(Date.parse(owner.startedAt), now)}, is gone`;
    lines.push(`The render slot (${dir}) is free: ${gone}; the next render takes it over.`);
  } else if (owner === null) {
    lines.push(`The render slot (${dir}) is ${describeSlotHolder(null)}.`);
  } else {
    const [head, ...log] = about(owner.pid, Date.parse(owner.startedAt), owner.repo, owner.command);
    lines.push(`The render slot (${dir}) is held by ${head}.`, ...log);
    if (!alive(owner.pid) && typeof owner.commandPgid === 'number') lines.push(`  Its pid is gone, but its command still runs in process group ${owner.commandPgid}.`);
    if (newerProtocol(owner)) lines.push(`  Written by render-slot protocol ${owner.protocol}, while this copy speaks ${PROTOCOL}: update this copy from ~/obsidian/AI/scripts/render-slot.ts.`);
  }
  const queue = renderSlotQueue(dir);
  lines.push(queue.length === 0 ? 'Nobody waits in the queue.' : `${queue.length} waiting in the queue, in the order they take the slot:`);
  queue.forEach((ticket, index) => {
    const [head, ...log] = about(ticket.pid, ticket.enqueuedAt, ticket.repo, ticket.command);
    lines.push(`  ${index + 1}. ${head}.`, ...log);
  });
  return lines.join('\n');
};

/** The value of `--name <value>` in `args`, or undefined. */
const optionValue = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const isMain = () => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const [verb, separator, ...command] = process.argv.slice(2);
  const args = process.argv.slice(3);
  if (verb === 'run' && separator === '--') {
    process.exitCode = await runCommand(command);
  } else if (verb === 'hold') {
    const max = optionValue(args, '--max');
    process.exitCode = await holdSlot(optionValue(args, '--rotulo') ?? '', max === undefined ? NaN : Number(max));
  } else if (verb === 'release') {
    process.exitCode = await releaseHold(optionValue(args, '--rotulo') ?? '');
  } else if (verb === 'status' && separator === undefined) {
    console.log(slotStatus());
  } else {
    console.error('Usage: node render-slot.ts run -- <command> [args] | hold --rotulo <label> --max <minutes> | release --rotulo <label> | status');
    process.exitCode = EXIT_USAGE;
  }
}
