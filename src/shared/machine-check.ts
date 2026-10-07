// The machine check every repo on this Mac shares (~/obsidian/AI/scripts/maquina_livre.py, in the
// owner's vault), asked by local capture, record and render before each recipe, and by a local Studio
// job before it starts (scripts/job-worker.mjs). The render slot keeps two renders apart; this check
// also sees what holds no slot: the game, low memory, swap, disk, and a render from a tool that does
// not use the slot. scripts/lib/machine.mjs asks the same check for the test runner. MACHINE_CHECK
// overrides its path (the tests use a fake one).
import {execFile} from "node:child_process";
import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {StudioError} from "./errors.js";

const run = promisify(execFile);

export type MachineVerdict = {free: boolean; reasons: string[]};

const POLL_MS = 20_000;
/** As long as the render slot's wait: a render queued behind a pack chain waits out the same machine. */
const WAIT_LIMIT_MS = 4 * 60 * 60 * 1000;

export const machineCheckScript = () => process.env.MACHINE_CHECK || join(homedir(), "obsidian", "AI", "scripts", "maquina_livre.py");

/** The check's --json answer as {free, reasons} (English), or null when `text` is not one. */
export function parseVerdict(text: string): MachineVerdict | null {
  let answer: {livre?: unknown; reasons?: unknown};
  try {
    answer = JSON.parse(text) as typeof answer;
  } catch {
    return null;
  }
  if (typeof answer?.livre !== "boolean" || !Array.isArray(answer.reasons)) return null;
  if (answer.livre) return {free: true, reasons: []};
  const reasons = answer.reasons.filter((reason): reason is string => typeof reason === "string");
  return {free: false, reasons: reasons.length ? reasons : ["the machine check says to wait, without a reason"]};
}

/**
 * The check's verdict, with this process and everything it started (its own Chrome, its own slot)
 * counted as the caller's work. Null where the check is missing (another machine) or gave no answer:
 * the render slot alone then decides.
 */
export async function machineVerdict(script = machineCheckScript()): Promise<MachineVerdict | null> {
  if (!existsSync(script)) return null;
  let stdout: string;
  try {
    ({stdout} = await run("python3", [script, "--json", "--familia", String(process.pid)], {timeout: 60_000, maxBuffer: 4 * 1024 * 1024}));
  } catch (error) {
    // Exit 3 is the busy answer, with the JSON on stdout.
    stdout = String((error as {stdout?: unknown})?.stdout ?? "");
  }
  return parseVerdict(stdout);
}

export type MachineWaitOptions = {
  /** false: fail at once with MACHINE_BUSY and the reasons (`--no-wait`). */
  wait?: boolean;
  pollMs?: number;
  waitLimitMs?: number;
  /** When the wait began, if before this call (a Studio job's wait for the render slot): the limit counts from it. */
  startedAt?: number;
  log?: (message: string) => void;
  check?: () => Promise<MachineVerdict | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Returns once the machine check says free (or is missing); logs each new reason to wait. */
export async function waitForMachine(options: MachineWaitOptions = {}): Promise<void> {
  const check = options.check ?? (() => machineVerdict());
  const pollMs = options.pollMs ?? POLL_MS;
  const waitLimitMs = options.waitLimitMs ?? WAIT_LIMIT_MS;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const started = options.startedAt ?? now();
  let said = "";
  for (;;) {
    const verdict = await check();
    if (!verdict || verdict.free) {
      if (said) log("The machine is free; rendering.");
      return;
    }
    const reasons = verdict.reasons.join("; ");
    const hint = "Wait with npm run wait-free in se-dev-kit, or python3 ~/obsidian/AI/scripts/maquina_livre.py --esperar.";
    if (options.wait === false) throw new StudioError("MACHINE_BUSY", `The machine check says to wait: ${reasons}`, hint);
    if (now() - started >= waitLimitMs) {
      throw new StudioError("MACHINE_BUSY_TIMEOUT", `The machine was still busy after ${Math.round(waitLimitMs / 60_000)} min: ${reasons}`, hint);
    }
    if (reasons !== said) log(`Waiting for the machine: ${reasons}`);
    said = reasons;
    await sleep(pollMs);
  }
}
