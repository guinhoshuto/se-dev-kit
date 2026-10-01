// One heavy render at a time on this machine (8 GB of RAM), across repos and sessions.
//
// One implementation for every repo. The source is ~/obsidian/AI/scripts/render-slot.ts; each repo
// keeps a byte-identical copy (background-creator: scripts/render-slot.ts, se-dev-kit:
// src/shared/render-slot.ts), because its build cannot reach the vault. Never edit a copy: edit the
// source and run `python3 ~/obsidian/AI/scripts/render_slot_copias.py --write`; `--check` (and a
// test in each repo) fails while a copy differs. Only node: imports, so it compiles under the
// strictest tsconfig of the two repos.
//
// Protocol: the slot is the directory ~/.cache/render-slot (RENDER_SLOT_DIR overrides it). Taking it
// is an atomic mkdir; inside, owner.json holds {protocol, pid, repo, command, startedAt}. A slot
// whose pid is gone, or whose startedAt is before the last boot (the pid was reused), is taken over,
// under the mutex <slot>.takeover (an atomic mkdir), and only after checking again under it that the
// same dead owner still holds it. Only the owner removes it. A child process started by the owner
// finds RENDER_SLOT_HELD=<owner pid> in its environment and runs under the parent's slot instead of
// waiting for it.
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
import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SlotOwner = {protocol?: number; pid: number; repo: string; command: string; startedAt: string};
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
};

export const HELD_ENV = 'RENDER_SLOT_HELD';
/** The protocol this copy writes and understands; see the top of this file. */
export const PROTOCOL = 2;
const POLL_MS = 2000;
const WAIT_LIMIT_MS = 30 * 60 * 1000;
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

/**
 * Whether the owner still runs. A slot written before the last boot is dead even when its pid is
 * alive again: after a reboot the pid belongs to another process (EPERM counts as alive).
 */
const ownerAlive = (owner: SlotOwner) => !(Date.parse(owner.startedAt) < bootTimeMs()) && alive(owner.pid);

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

/** Removes the slot only when this process owns it. */
export const releaseRenderSlot = (dir = slotDir()) => {
  if (readOwner(dir)?.pid !== process.pid) return false;
  rmSync(dir, {recursive: true, force: true});
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

/**
 * Waits for the machine-wide render slot and takes it. The slot is released by `release()`, on
 * exit, and on SIGINT/SIGTERM. Nested calls in the same process and children of the owner
 * (RENDER_SLOT_HELD) run under the slot they already hold.
 */
export const acquireRenderSlot = async (options: SlotOptions): Promise<SlotHandle> => {
  const dir = options.dir ?? slotDir();
  const pollMs = options.pollMs ?? POLL_MS;
  const waitLimitMs = options.waitLimitMs ?? WAIT_LIMIT_MS;
  const log = options.log ?? ((message: string) => console.log(message));
  const started = Date.now();
  let warned = false;
  let warnedBlocked = false;
  mkdirSync(path.dirname(dir), {recursive: true});
  for (;;) {
    const current = readOwner(dir);
    if (current?.pid === process.pid) return noopHandle();
    const held = Number(process.env[HELD_ENV]);
    if (current && current.pid === held && ownerAlive(current)) return noopHandle();
    try {
      mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readOwner(dir);
      const stale = isStale(dir, owner);
      if (stale && takeOverStale(dir, owner?.pid ?? null)) continue;
      // A dead owner's slot whose takeover waits on an old mutex of a pid that still runs.
      const blocker = stale ? blockingMutexHolder(`${dir}.takeover`) : null;
      const holder = blocker === null
        ? describeSlotHolder(owner)
        : `${describeSlotHolder(owner)}, whose takeover waits on the mutex ${dir}.takeover, held for over 10 seconds by pid ${blocker}, which still runs`;
      const hint = STUCK_HINT(dir, blocker);
      if (options.wait === false) throw new RenderSlotError('RENDER_SLOT_BUSY', `Another render holds the render slot (${dir}), ${holder}.`, `Run again when it ends. ${hint}`);
      if (!warned) { log(`Waiting for the render slot, ${holder}.`); warned = true; }
      if (blocker !== null && !warnedBlocked) { log(`The takeover of the render slot waits on pid ${blocker}. ${hint}`); warnedBlocked = true; }
      if (Date.now() - started > waitLimitMs) {
        // No promise of an automatic takeover while a mutex of a live pid blocks it.
        const retry = blocker === null ? 'Run again when that render ends; a slot whose pid is gone is taken over automatically. ' : '';
        throw new RenderSlotError('RENDER_SLOT_TIMEOUT', `Gave up after ${Math.round(waitLimitMs / 60_000)} minutes waiting for the render slot (${dir}), ${holder}.`, `${retry}${hint}`);
      }
      await sleep(pollMs);
      continue;
    }
    const owner: SlotOwner = {protocol: PROTOCOL, pid: process.pid, repo: options.repo ?? defaultRepo(), command: options.command, startedAt: new Date().toISOString()};
    const temporary = path.join(dir, `${OWNER_FILE}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(owner, null, 2)}\n`);
    renameSync(temporary, path.join(dir, OWNER_FILE));
    process.env[HELD_ENV] = String(process.pid);

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
