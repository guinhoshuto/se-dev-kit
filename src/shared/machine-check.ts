// The machine check every repo on this Mac shares (~/obsidian/AI/scripts/maquina_livre.py, in the
// owner's vault), asked by local capture, record and render before each recipe, and by a local Studio
// job before it starts (scripts/job-worker.mjs). The render slot keeps two renders apart; this check
// also sees what holds no slot: the game, low memory, swap, disk, and a render from a tool that does
// not use the slot. scripts/lib/machine.mjs asks the same check for the test runner. MACHINE_CHECK
// overrides its path (the tests use a fake one).
import {execFile, spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {constants, homedir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {StudioError} from "./errors.js";

const run = promisify(execFile);

/** `kinds`, when the check names them (its `tipos`), is the kind of each reason: trava, fila, memoria, jogo, render… */
export type MachineVerdict = {free: boolean; reasons: string[]; kinds?: string[]};

const POLL_MS = 20_000;
/** As long as the render slot's wait: a render queued behind a pack chain waits out the same machine. */
const WAIT_LIMIT_MS = 4 * 60 * 60 * 1000;
/** The reasons a ticket in the render slot queue waits out: the slot and its queue. */
const QUEUE_KINDS = new Set(["trava", "fila"]);
/** What may come with them in the queue: memory, which the check at the turn asks again. */
const TURN_KINDS = new Set(["trava", "fila", "memoria"]);
/** The longest `--max` that `render-slot vez` takes, counted from its `--since`. */
const TURN_MAX_MINUTES = 240;
/** What `render-slot vez --conferir` prints at its turn, its ticket still first in the queue; then it reads the answer. */
const TURN_LINE = "Your turn in the render slot queue";
/** `render-slot vez` at its wait limit. */
const TURN_GAVE_UP = 75;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const machineCheckScript = () => process.env.MACHINE_CHECK || join(homedir(), "obsidian", "AI", "scripts", "maquina_livre.py");

/** The check's --json answer as {free, reasons} (English), with `kinds` when it names one per reason, or null when `text` is not one. */
export function parseVerdict(text: string): MachineVerdict | null {
  let answer: {livre?: unknown; reasons?: unknown; tipos?: unknown};
  try {
    answer = JSON.parse(text) as typeof answer;
  } catch {
    return null;
  }
  if (typeof answer?.livre !== "boolean" || !Array.isArray(answer.reasons)) return null;
  if (answer.livre) return {free: true, reasons: []};
  const reasons = answer.reasons.filter((reason): reason is string => typeof reason === "string");
  const {tipos} = answer;
  const named = reasons.length > 0 && reasons.length === answer.reasons.length && Array.isArray(tipos) && tipos.length === reasons.length && tipos.every((kind) => typeof kind === "string");
  return {free: false, reasons: reasons.length ? reasons : ["the machine check says to wait, without a reason"], ...(named ? {kinds: tipos as string[]} : {})};
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

/** A wait for the turn in the render slot queue: its ticket's label, its place (ms) and limit (minutes from it), and the answer at the turn. */
export type TurnRequest = {label: string; since: number; maxMinutes: number; answer: () => Promise<"go" | "back">};
/** How that wait ended: its exit status, the answer it gave at its turn (none when the turn never came), and its last line. */
export type TurnResult = {code: number | null; answer?: "go" | "back"; said: string};

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
  /**
   * The label of a product ticket in the render slot queue, "vez: <label>" (1 to 60 letters, digits, ".", "_" or
   * "-"), for a caller that takes no slot itself before its render (the skill client, wait-free): see waitForMachine.
   * Never for a caller that holds the slot: it would wait in the queue for its own slot.
   */
  queue?: string;
  /** Waits for the turn (the tests); by default `render-slot vez --conferir`, the build next to this module. */
  turn?: (request: TurnRequest) => Promise<TurnResult>;
};

/** Whether the check's reasons are ones the render slot queue waits out: the slot or its queue, with at most memory besides. */
const queueable = (verdict: MachineVerdict) =>
  verdict.kinds !== undefined && verdict.kinds.some((kind) => QUEUE_KINDS.has(kind)) && verdict.kinds.every((kind) => TURN_KINDS.has(kind));

/** The reasons left at the turn: the queue behind its ticket waits for it, so a "fila" reason no longer counts. */
const atTheTurn = (verdict: MachineVerdict | null) =>
  !verdict || verdict.free ? [] : verdict.reasons.filter((_, at) => verdict.kinds?.[at] !== "fila");

/**
 * `node render-slot.js vez --conferir` from the build next to this module: a product ticket in the queue, which a
 * chain that cedes (hold --ceder, HAR-301) lets go first between two of its steps. At its turn, its ticket still
 * first, it asks `answer` and writes it on the vez's stdin: "go" leaves the baton, which keeps those that cede off
 * the free slot for 30 s, for the render that follows; "back" leaves none. What the vez says while it waits stays
 * out of the log, which names the wait once; its last line comes back in `said`. A signal or the end of this process
 * ends the vez too, so its ticket never outlives the wait.
 */
function waitForTurn({label, since, maxMinutes, answer}: TurnRequest): Promise<TurnResult> {
  const script = fileURLToPath(new URL("./render-slot.js", import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "vez", "--rotulo", label, "--since", String(Math.floor(since)), "--max", String(maxMinutes), "--conferir"], {stdio: ["pipe", "pipe", "pipe"]});
    let said = "";
    let asked = false;
    let given: "go" | "back" | undefined;
    const stop = () => { child.kill("SIGTERM"); };
    const onSignal = (signal: NodeJS.Signals) => {
      child.kill(signal);
      // Without another handler, Node would keep running once this one returns.
      if (process.listenerCount(signal) === 0) process.exit(128 + (constants.signals[signal] ?? 15));
    };
    process.once("exit", stop);
    for (const signal of SIGNALS) process.once(signal, onSignal);
    const settle = (result: TurnResult) => {
      process.off("exit", stop);
      for (const signal of SIGNALS) process.off(signal, onSignal);
      resolve(result);
    };
    // The vez may be gone before the answer is written (killed, or at its limit).
    child.stdin.on("error", () => {});
    const lines = (stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
      let rest = "";
      stream.on("data", (chunk: Buffer) => {
        const parts = (rest + String(chunk)).split("\n");
        rest = parts.pop() ?? "";
        for (const line of parts.map((part) => part.trim()).filter(Boolean)) onLine(line);
      });
    };
    lines(child.stderr, (line) => { said = line; });
    lines(child.stdout, (line) => {
      said = line;
      if (asked || !line.startsWith(TURN_LINE)) return;
      asked = true;
      answer().catch(() => "back" as const).then((reply) => {
        given = reply;
        child.stdin.end(`${reply}\n`);
      });
    });
    child.once("error", (error) => settle({code: null, said: error.message}));
    child.once("close", (code) => settle({code, ...(given ? {answer: given} : {}), said}));
  });
}

/**
 * Returns once the machine check says free (or is missing); logs each new reason to wait, and resolves to whether
 * the wait ended at a turn in the render slot queue. With `queue`, while the check's reasons are the render slot or
 * its queue (its `kinds`), with at most memory besides, the wait takes a product ticket in that queue instead of
 * polling (#15): polling never saw free the slot of a chain that holds it step by step and cedes its turn (hold
 * --ceder), which lets only a ticket in the queue go first. At the turn, the ticket still first, the check is asked
 * again without the queue behind it: free, the wait ends, and the render that follows has the slot for 30 s;
 * otherwise the turn goes back, and after `pollMs` the loop asks again, from the same place in the queue. A check
 * without kinds, or a ticket that cannot be taken, leaves the wait polling. The limit counts from `startedAt`.
 */
export async function waitForMachine(options: MachineWaitOptions = {}): Promise<{turn: boolean}> {
  const check = options.check ?? (() => machineVerdict());
  const pollMs = options.pollMs ?? POLL_MS;
  const waitLimitMs = options.waitLimitMs ?? WAIT_LIMIT_MS;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const turn = options.turn ?? waitForTurn;
  const started = options.startedAt ?? now();
  let {queue} = options;
  let said = "";
  for (;;) {
    const verdict = await check();
    if (!verdict || verdict.free) {
      if (said) log("The machine is free; rendering.");
      return {turn: false};
    }
    const reasons = verdict.reasons.join("; ");
    const hint = "Wait with npm run wait-free in se-dev-kit, or python3 ~/obsidian/AI/scripts/maquina_livre.py --esperar.";
    if (options.wait === false) throw new StudioError("MACHINE_BUSY", `The machine check says to wait: ${reasons}`, hint);
    if (now() - started >= waitLimitMs) {
      throw new StudioError("MACHINE_BUSY_TIMEOUT", `The machine was still busy after ${Math.round(waitLimitMs / 60_000)} min: ${reasons}`, hint);
    }
    if (queue !== undefined && queueable(verdict)) {
      if (`queue ${reasons}` !== said) log(`Waiting for the machine, in the render slot queue as "vez: ${queue}": ${reasons}`);
      said = `queue ${reasons}`;
      let left: string[] = [];
      // Its place and its limit both count from when the wait began, on the clock the vez reads.
      const result = await turn({label: queue, since: Date.now() - (now() - started), maxMinutes: Math.min(TURN_MAX_MINUTES, waitLimitMs / 60_000), answer: async () => {
        left = atTheTurn(await check());
        return left.length ? "back" : "go";
      }});
      if (result.answer === "go") {
        log("The machine is free at its turn in the render slot queue; rendering.");
        return {turn: true};
      }
      if (result.answer === "back") {
        if (`back ${left.join("; ")}` !== said) log(`Waiting for the machine: at its turn in the render slot queue, ${left.join("; ")}`);
        said = `back ${left.join("; ")}`;
        await sleep(pollMs);
        continue;
      }
      if (result.code === TURN_GAVE_UP) {
        throw new StudioError("MACHINE_BUSY_TIMEOUT", `The machine was still busy after ${Math.round(waitLimitMs / 60_000)} min: ${reasons}; in the render slot queue: ${result.said}`, hint);
      }
      log(`Waiting for the machine without a place in the render slot queue: its vez ended with ${result.code ?? "an error"}${result.said ? `: ${result.said}` : ""}`);
      queue = undefined;
      continue;
    }
    if (reasons !== said) log(`Waiting for the machine: ${reasons}`);
    said = reasons;
    await sleep(pollMs);
  }
}
