// One heavy render at a time on this machine (8 GB of RAM), across repos and sessions. This is the
// protocol of background-creator's scripts/render-slot.ts, adopted as is so both repos share one slot.
//
// The slot is the directory ~/.cache/render-slot (RENDER_SLOT_DIR overrides it). Taking it is an
// atomic mkdir; inside, owner.json holds {pid, repo, command, startedAt}. A slot whose pid is gone, or
// whose startedAt is before the last boot (the pid was reused), is taken over, under the mutex
// <slot>.takeover (an atomic mkdir), and only after checking again under it that the same dead owner
// still holds it. Only the owner removes it. A child process started by the owner finds
// RENDER_SLOT_HELD=<owner pid> in its environment and runs under the parent's slot instead of waiting.
import {mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {homedir, uptime} from "node:os";
import {dirname, join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {StudioError} from "./errors.js";

export interface SlotOwner {
  pid: number;
  repo: string;
  command: string;
  startedAt: string;
}

export interface SlotHandle {
  release: () => void;
  inherited: boolean;
}

export interface SlotOptions {
  command: string;
  dir?: string;
  repo?: string;
  pollMs?: number;
  waitLimitMs?: number;
  /** false: fail at once with RENDER_SLOT_BUSY when another process holds the slot. */
  wait?: boolean;
  log?: (message: string) => void;
}

export const HELD_ENV = "RENDER_SLOT_HELD";
const REPO = "se-dev-kit";
const POLL_MS = 2000;
const WAIT_LIMIT_MS = 30 * 60 * 1000;
/** An owner.json still missing after this long means its writer died between mkdir and write. */
const UNWRITTEN_GRACE_MS = 10_000;
const OWNER_FILE = "owner.json";

export function slotDir(): string {
  return process.env.RENDER_SLOT_DIR || join(homedir(), ".cache", "render-slot");
}

/** The manual way out when no render is running and the slot stays held. */
function stuckHint(dir: string): string {
  return `If no render is running, remove the slot by hand: rm -r ${dir}`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When this machine booted, in ms since the epoch. */
function bootTimeMs(): number {
  return Date.now() - uptime() * 1000;
}

/**
 * Whether the owner still runs. A slot written before the last boot is dead even when its pid is
 * alive again: after a reboot the pid belongs to another process (EPERM counts as alive).
 */
function ownerAlive(owner: SlotOwner): boolean {
  return !(Date.parse(owner.startedAt) < bootTimeMs()) && alive(owner.pid);
}

function readOwner(dir: string): SlotOwner | null {
  try {
    const owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8")) as SlotOwner;
    return Number.isInteger(owner.pid) && owner.pid > 0 ? owner : null;
  } catch {
    return null;
  }
}

function ageMs(dir: string): number {
  try {
    return Date.now() - statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function exists(dir: string): boolean {
  try {
    statSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Whether `dir` is held by a dead owner (or by a writer that died before writing owner.json). */
function isStale(dir: string, owner: SlotOwner | null): boolean {
  return owner ? !ownerAlive(owner) : ageMs(dir) > UNWRITTEN_GRACE_MS;
}

/**
 * Removes a dead owner's slot under the takeover mutex, after checking again that the same dead
 * owner still holds it: a slot someone took in between is never touched. False when another
 * process is taking it over now. A mutex left by a taker that died is cleared after the grace.
 */
function takeOverStale(dir: string, stalePid: number | null): boolean {
  const mutex = `${dir}.takeover`;
  try {
    mkdirSync(mutex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (ageMs(mutex) > UNWRITTEN_GRACE_MS) {
      rmSync(mutex, {recursive: true, force: true});
      return true;
    }
    return false;
  }
  try {
    const owner = readOwner(dir);
    if ((owner?.pid ?? null) === stalePid && isStale(dir, owner)) rmSync(dir, {recursive: true, force: true});
  } finally {
    rmSync(mutex, {recursive: true, force: true});
  }
  return true;
}

/** Removes the slot only when this process owns it. */
export function releaseRenderSlot(dir: string = slotDir()): boolean {
  if (readOwner(dir)?.pid !== process.pid) return false;
  rmSync(dir, {recursive: true, force: true});
  if (process.env[HELD_ENV] === String(process.pid)) delete process.env[HELD_ENV];
  return true;
}

export function describeSlotHolder(owner: SlotOwner | null): string {
  return owner
    ? `held by pid ${owner.pid} (${owner.repo}: ${owner.command}) since ${owner.startedAt}`
    : "held by a process that is still writing its owner file";
}

/** Who holds the slot, when a live process does: undefined when it is free or stale (the next taker takes it over). */
export function renderSlotHolder(dir: string = slotDir()): {owner: SlotOwner | null} | undefined {
  if (!exists(dir)) return undefined;
  const owner = readOwner(dir);
  return isStale(dir, owner) ? undefined : {owner};
}

function noopHandle(): SlotHandle {
  return {release: () => {}, inherited: true};
}

/**
 * Waits for the machine-wide render slot and takes it. The slot is released by `release()`, on
 * exit, and on SIGINT/SIGTERM. Nested calls in the same process and children of the owner
 * (RENDER_SLOT_HELD) run under the slot they already hold.
 */
export async function acquireRenderSlot(options: SlotOptions): Promise<SlotHandle> {
  const dir = options.dir ?? slotDir();
  const pollMs = options.pollMs ?? POLL_MS;
  const waitLimitMs = options.waitLimitMs ?? WAIT_LIMIT_MS;
  const log = options.log ?? ((message: string) => console.log(message));
  const started = Date.now();
  let warned = false;
  mkdirSync(dirname(dir), {recursive: true});
  for (;;) {
    const current = readOwner(dir);
    if (current?.pid === process.pid) return noopHandle();
    const held = Number(process.env[HELD_ENV]);
    if (current && current.pid === held && ownerAlive(current)) return noopHandle();
    try {
      mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readOwner(dir);
      if (isStale(dir, owner) && takeOverStale(dir, owner?.pid ?? null)) continue;
      const holder = describeSlotHolder(owner);
      if (options.wait === false) {
        throw new StudioError("RENDER_SLOT_BUSY", `Another render holds the render slot (${dir}), ${holder}.`, `Run again when it ends. ${stuckHint(dir)}`);
      }
      if (!warned) {
        log(`Waiting for the render slot, ${holder}.`);
        warned = true;
      }
      if (Date.now() - started > waitLimitMs) {
        throw new StudioError(
          "RENDER_SLOT_TIMEOUT",
          `Gave up after ${Math.round(waitLimitMs / 60_000)} minutes waiting for the render slot (${dir}), ${holder}.`,
          `Run again when that render ends; a slot whose pid is gone is taken over automatically. ${stuckHint(dir)}`
        );
      }
      await sleep(pollMs);
      continue;
    }
    const owner: SlotOwner = {pid: process.pid, repo: options.repo ?? REPO, command: options.command, startedAt: new Date().toISOString()};
    const temporary = join(dir, `${OWNER_FILE}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(owner, null, 2)}\n`);
    renameSync(temporary, join(dir, OWNER_FILE));
    process.env[HELD_ENV] = String(process.pid);

    const onExit = () => {
      releaseRenderSlot(dir);
    };
    const onSignal = (signal: NodeJS.Signals) => {
      releaseRenderSlot(dir);
      // Without another handler, Node would keep running once this one returns.
      if (process.listenerCount(signal) === 0) process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.once("exit", onExit);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    return {
      inherited: false,
      release: () => {
        releaseRenderSlot(dir);
        process.off("exit", onExit);
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    };
  }
}

/** Runs `task` holding the render slot, and releases it however `task` ends. */
export async function withRenderSlot<T>(task: () => Promise<T>, options: SlotOptions): Promise<T> {
  const slot = await acquireRenderSlot(options);
  try {
    return await task();
  } finally {
    slot.release();
  }
}
