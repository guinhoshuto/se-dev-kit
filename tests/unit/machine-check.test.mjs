import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {HELD_ENV} from "../../dist/shared/render-slot.js";
import {machineVerdict, parseVerdict, waitForMachine} from "../../dist/shared/machine-check.js";

const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));
const exists = (path) => stat(path).then(() => true, () => false);

/**
 * A fake maquina_livre.py: busy with `reason` for the first `busyAnswers` calls, then free. Each call
 * appends its argv to calls.log, so a test sees who asked and for which family.
 */
async function fakeCheck(folder, reason, busyAnswers) {
  const script = join(folder, "maquina_livre.py");
  await writeFile(script, [
    "import json, os, sys",
    "log = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'calls.log')",
    "with open(log, 'a') as f: f.write(' '.join(sys.argv[1:]) + '\\n')",
    "calls = sum(1 for _ in open(log))",
    `busy = calls <= ${busyAnswers}`,
    `print(json.dumps({'livre': not busy, 'motivos': [], 'reasons': [${JSON.stringify(reason)}] if busy else []}))`,
    "sys.exit(3 if busy else 0)"
  ].join("\n"));
  return script;
}

async function folder(t) {
  const path = await mkdtemp(join(tmpdir(), "sws-machine-gate-"));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}

const answers = (list) => {
  const queue = [...list];
  return async () => queue.shift();
};

test("waitForMachine waits while the check says busy, logs each new reason once, and returns once it says free", async () => {
  const log = [];
  const slept = [];
  const busy = (reason) => ({free: false, reasons: [reason]});
  await waitForMachine({
    check: answers([busy("the game is open"), busy("the game is open"), busy("12% of memory free, below 30%"), {free: true, reasons: []}]),
    pollMs: 7,
    log: (message) => log.push(message),
    sleep: async (ms) => { slept.push(ms); }
  });
  assert.deepEqual(log, [
    "Waiting for the machine: the game is open",
    "Waiting for the machine: 12% of memory free, below 30%",
    "The machine is free; rendering."
  ]);
  assert.deepEqual(slept, [7, 7, 7]);
});

test("waitForMachine returns at once, silent, when the check is free or missing", async () => {
  for (const verdict of [{free: true, reasons: []}, null]) {
    const log = [];
    await waitForMachine({check: answers([verdict]), log: (message) => log.push(message), sleep: async () => assert.fail("slept")});
    assert.deepEqual(log, []);
  }
});

test("waitForMachine with wait: false fails at once with MACHINE_BUSY and the reasons", async () => {
  await assert.rejects(
    waitForMachine({wait: false, check: answers([{free: false, reasons: ["the game is open", "swap 95% full"]}]), log: () => {}, sleep: async () => assert.fail("slept")}),
    (error) => error.code === "MACHINE_BUSY" && error.message === "The machine check says to wait: the game is open; swap 95% full" && /wait-free/.test(error.hint)
  );
});

test("waitForMachine gives up with MACHINE_BUSY_TIMEOUT at its limit, not before", async () => {
  let clock = 0;
  let checks = 0;
  await assert.rejects(
    waitForMachine({
      check: async () => { checks += 1; return {free: false, reasons: ["the game is open"]}; },
      pollMs: 60_000,
      waitLimitMs: 180_000,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      log: () => {}
    }),
    (error) => error.code === "MACHINE_BUSY_TIMEOUT" && error.message === "The machine was still busy after 3 min: the game is open"
  );
  assert.equal(checks, 4, "checked at 0, 1, 2 and 3 minutes");
});

test("waitForMachine counts its limit from startedAt: a Studio job's 20 minutes for the render slot leave 10 of its 30", async () => {
  let clock = 20 * 60_000;
  let checks = 0;
  await assert.rejects(
    waitForMachine({
      check: async () => { checks += 1; return {free: false, reasons: ["the game is open"]}; },
      startedAt: 0,
      pollMs: 60_000,
      waitLimitMs: 30 * 60_000,
      now: () => clock,
      // A ceiling, so a wait that ignored its limit fails here instead of spinning.
      sleep: async (ms) => { clock += ms; if (clock > 120 * 60_000) throw new Error("waited past any limit"); },
      log: () => {}
    }),
    (error) => error.code === "MACHINE_BUSY_TIMEOUT" && error.message === "The machine was still busy after 30 min: the game is open"
  );
  assert.equal(checks, 11, "checked at 20, 21, … and 30 minutes after the job began to wait");
});

test("waitForMachine with a queue waits out the slot and its queue as a ticket, and asks the check again at its turn without the queue behind it", async () => {
  const slot = {free: false, reasons: ["the render slot is held by pid 7", "28% of memory free"], kinds: ["trava", "memoria"]};
  const behind = {free: false, reasons: ["1 waiting in the render slot queue"], kinds: ["fila"]};
  const low = {free: false, reasons: ["1 waiting in the render slot queue", "28% of memory free"], kinds: ["fila", "memoria"]};
  const game = {free: false, reasons: ["the game is open"], kinds: ["jogo"]};
  const run = async (verdicts, turns, options = {}) => {
    const log = [];
    const slept = [];
    const asked = [];
    const check = answers(verdicts);
    const result = await waitForMachine({
      queue: "wait-free", check, pollMs: 7, waitLimitMs: 30 * 60_000, startedAt: Date.now() - 60_000,
      log: (message) => log.push(message), sleep: async (ms) => { slept.push(ms); },
      turn: async (request) => {
        asked.push(request);
        const next = turns.shift();
        return next.turn ? {code: 0, answer: await request.answer(), said: ""} : next;
      },
      ...options
    });
    return {result, log, slept, asked};
  };
  // The slot (and memory) sends the wait to the queue; at its turn the queue behind it no longer counts.
  const go = await run([slot, behind], [{turn: true}]);
  assert.deepEqual(go.result, {turn: true});
  assert.deepEqual(go.log, ['Waiting for the machine, in the render slot queue as "vez: wait-free": the render slot is held by pid 7; 28% of memory free', "The machine is free at its turn in the render slot queue; rendering."]);
  assert.equal(go.asked[0].label, "wait-free");
  assert.equal(go.asked[0].maxMinutes, 30, "its limit, from its place");
  assert.ok(Math.abs(go.asked[0].since - (Date.now() - 60_000)) < 5_000, "its place is when the wait began");
  // Memory still low at the turn: the turn goes back, and after pollMs the wait asks again, from the same place.
  const back = await run([slot, low, slot, behind], [{turn: true}, {turn: true}]);
  assert.deepEqual(back.result, {turn: true});
  assert.equal(back.log[1], "Waiting for the machine: at its turn in the render slot queue, 28% of memory free");
  assert.deepEqual(back.slept, [7]);
  assert.equal(back.asked[1].since, back.asked[0].since);
  // A vez that cannot run leaves the wait polling; a reason the queue does not wait out never takes a ticket.
  const broken = await run([slot, slot, {free: true, reasons: []}], [{code: 2, said: "Usage: render-slot vez"}]);
  assert.deepEqual(broken.result, {turn: false});
  assert.equal(broken.asked.length, 1);
  assert.equal(broken.log[1], "Waiting for the machine without a place in the render slot queue: its vez ended with 2: Usage: render-slot vez");
  assert.deepEqual((await run([{...slot, reasons: [...slot.reasons, "the game is open"], kinds: [...slot.kinds, "jogo"]}, game, {free: true, reasons: []}], [])).asked, []);
  assert.deepEqual((await run([slot, {free: true, reasons: []}], [], {queue: undefined})).asked, [], "no queue without a label");
  // The vez at its limit is the wait's limit.
  await assert.rejects(run([slot], [{code: 75, said: "Gave up after 30 minutes waiting for the render slot"}]), (error) => error.code === "MACHINE_BUSY_TIMEOUT" && /in the render slot queue: Gave up after 30 minutes/.test(error.message));
});

test("parseVerdict keeps the check's kind of each reason only when it names one per reason", () => {
  assert.deepEqual(parseVerdict('{"livre": false, "reasons": ["the slot", "memory"], "tipos": ["trava", "memoria"]}'), {free: false, reasons: ["the slot", "memory"], kinds: ["trava", "memoria"]});
  assert.deepEqual(parseVerdict('{"livre": false, "reasons": ["the slot", "memory"], "tipos": ["trava"]}'), {free: false, reasons: ["the slot", "memory"]});
  assert.deepEqual(parseVerdict('{"livre": false, "reasons": ["the slot", 3], "tipos": ["trava", "memoria"]}'), {free: false, reasons: ["the slot"]});
  assert.deepEqual(parseVerdict('{"livre": true, "reasons": [], "tipos": []}'), {free: true, reasons: []});
});

test("machineVerdict asks the check for this process's family and reads its busy answer", async (t) => {
  const dir = await folder(t);
  const script = await fakeCheck(dir, "the game is open", 1);
  assert.deepEqual(await machineVerdict(script), {free: false, reasons: ["the game is open"]});
  assert.deepEqual(await machineVerdict(script), {free: true, reasons: []});
  assert.equal(await machineVerdict(join(dir, "missing.py")), null);
  assert.equal(parseVerdict('{"livre": false}'), null);
  assert.equal((await readFile(join(dir, "calls.log"), "utf8")).split("\n")[0], `--json --familia ${process.pid}`);
});

test("local capture and render wait for the machine check, and --no-wait fails with its reason", {timeout: 120_000}, async (t) => {
  const {[HELD_ENV]: _held, ...rest} = process.env;
  const commands = {
    capture: ["capture", exampleRoot, "--scene", "hero"],
    render: ["render", exampleRoot, "--recipe", "listing-media"]
  };
  for (const [name, args] of Object.entries(commands)) {
    const dir = await folder(t);
    const env = {...rest, RENDER_SLOT_DIR: join(dir, "render-slot"), MACHINE_CHECK: await fakeCheck(dir, "the game (Client-Mac-Shipping) is open", 2)};
    const base = [cliPath, ...args, "--json", "--output", join(dir, "out"), "--allow-low-disk", "--allow-unsupported-node", "--browser-path", join(dir, "missing-chrome")];
    const run = async (extra) => {
      const cli = spawn(process.execPath, [...base, ...extra], {env, stdio: ["ignore", "ignore", "pipe"]});
      t.after(() => cli.kill("SIGKILL"));
      let stderr = "";
      cli.stderr.on("data", (chunk) => { stderr += chunk; });
      const [code] = await once(cli, "exit");
      return {code, stderr};
    };

    const refused = await run(["--no-wait"]);
    assert.notEqual(refused.code, 0, `${name}: ${refused.stderr}`);
    assert.match(refused.stderr, /"code": "MACHINE_BUSY"/, name);
    assert.match(refused.stderr, /the game \(Client-Mac-Shipping\) is open/, name);
    assert.doesNotMatch(refused.stderr, /BROWSER_NOT_FOUND/, `${name} did not start rendering`);
    assert.equal(await exists(join(dir, "render-slot")), false, `${name} gave the slot back`);

    // The second answer is busy, the third free: the render waits one round, then runs (and stops at the missing browser).
    const waited = await run([]);
    assert.match(waited.stderr, /Waiting for the machine: the game \(Client-Mac-Shipping\) is open/, name);
    assert.match(waited.stderr, /The machine is free; rendering\./, name);
    assert.match(waited.stderr, /"code": "BROWSER_NOT_FOUND"/, `${name} ran once the machine was free`);
    assert.equal(await exists(join(dir, "render-slot")), false, `${name} gave the slot back`);
  }
});

test("a render of several recipes asks the machine check before it starts their shared browser", {timeout: 60_000}, async (t) => {
  const dir = await folder(t);
  const {[HELD_ENV]: _held, ...rest} = process.env;
  const env = {...rest, RENDER_SLOT_DIR: join(dir, "render-slot"), MACHINE_CHECK: await fakeCheck(dir, "the game is open", 99)};
  const cli = spawn(process.execPath, [cliPath, "render", exampleRoot, "--recipe", "listing-media", "--recipe", "etsy-listing-images", "--json", "--no-wait", "--output", join(dir, "out"), "--allow-low-disk", "--allow-unsupported-node", "--browser-path", join(dir, "missing-chrome")], {env, stdio: ["ignore", "ignore", "pipe"]});
  t.after(() => cli.kill("SIGKILL"));
  let stderr = "";
  cli.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(cli, "exit");
  assert.notEqual(code, 0, stderr);
  assert.match(stderr, /"code": "MACHINE_BUSY"/, "the busy machine stopped it");
  assert.doesNotMatch(stderr, /BROWSER_NOT_FOUND/, "before the shared browser was started");
});

test("a render under a slot inherited from its parent does not ask the machine check again", {timeout: 60_000}, async (t) => {
  const dir = await folder(t);
  const slot = join(dir, "render-slot");
  const env = {...process.env, RENDER_SLOT_DIR: slot, MACHINE_CHECK: await fakeCheck(dir, "the game is open", 99)};
  // The parent takes the slot, then runs the CLI with RENDER_SLOT_HELD, as the test runner does.
  const moduleUrl = new URL("../../dist/shared/render-slot.js", import.meta.url).href;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", `
const m = await import(${JSON.stringify(moduleUrl)});
const {spawnSync} = await import("node:child_process");
await m.withRenderSlot(async () => {
  const child = spawnSync(process.execPath, ${JSON.stringify([cliPath, "capture", exampleRoot, "--scene", "hero", "--json", "--output", join(dir, "out"), "--allow-low-disk", "--allow-unsupported-node", "--browser-path", join(dir, "missing-chrome")])}, {encoding: "utf8"});
  process.stdout.write(child.stderr);
}, {command: "test runner", log: () => {}});
`], {env, stdio: ["ignore", "pipe", "inherit"]});
  t.after(() => parent.kill("SIGKILL"));
  let stdout = "";
  parent.stdout.on("data", (chunk) => { stdout += chunk; });
  await once(parent, "exit");
  assert.match(stdout, /"code": "BROWSER_NOT_FOUND"/, stdout);
  assert.equal(await exists(join(dir, "calls.log")), false, "the check was not asked");
});
