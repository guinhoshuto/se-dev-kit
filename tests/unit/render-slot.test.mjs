import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile} from "node:fs/promises";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {HELD_ENV, acquireRenderSlot, releaseRenderSlot, renderSlotHolder} from "../../dist/shared/render-slot.js";

const execFileAsync = promisify(execFile);
const moduleUrl = new URL("../../dist/shared/render-slot.js", import.meta.url).href;
const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

async function slotFolder(t) {
  const folder = await mkdtemp(join(tmpdir(), "sws-slot-"));
  t.after(() => rm(folder, {recursive: true, force: true}));
  return join(folder, "render-slot");
}

/** A live process other than this one, to own a slot. */
function sleeper(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  t.after(() => child.kill("SIGKILL"));
  return child;
}

async function holdAs(dir, owner) {
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, "owner.json"), JSON.stringify(owner));
}

const exists = (path) => stat(path).then(() => true, () => false);
const ownerPid = async (dir) => JSON.parse(await readFile(join(dir, "owner.json"), "utf8")).pid;

/** Runs module code in a child Node.js with the slot module as `m`, and returns its trimmed stdout. */
async function inChild(code, env = process.env) {
  const {stdout} = await execFileAsync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(moduleUrl)});\n${code}`], {env});
  return stdout.trim();
}

test("a live owner makes a no-wait taker fail at once and a waiting one give up at its limit, both naming the holder", async (t) => {
  const dir = await slotFolder(t);
  const other = sleeper(t);
  const startedAt = new Date().toISOString();
  await holdAs(dir, {pid: other.pid, repo: "background-creator", command: "npm run render:mp4", startedAt});
  const holder = `held by pid ${other.pid} (background-creator: npm run render:mp4) since ${startedAt}`;
  await assert.rejects(acquireRenderSlot({dir, command: "t", wait: false}), (error) => error.code === "RENDER_SLOT_BUSY" && error.message.includes(holder));
  const lines = [];
  await assert.rejects(
    acquireRenderSlot({dir, command: "t", pollMs: 20, waitLimitMs: 200, log: (line) => lines.push(line)}),
    (error) => error.code === "RENDER_SLOT_TIMEOUT" && error.message.includes(holder)
  );
  assert.deepEqual(lines, [`Waiting for the render slot, ${holder}.`], "the wait is announced once");
  assert.equal(renderSlotHolder(dir)?.owner?.pid, other.pid);
  assert.equal(await ownerPid(dir), other.pid, "a waiting taker never touches a live owner's slot");
});

test("a slot whose owner is gone, or was written before the last boot, is taken over", async (t) => {
  const dir = await slotFolder(t);
  const gone = spawn(process.execPath, ["-e", ""], {stdio: "ignore"});
  await once(gone, "exit");
  await holdAs(dir, {pid: gone.pid, repo: "se-dev-kit", command: "killed render", startedAt: new Date().toISOString()});
  assert.equal(renderSlotHolder(dir), undefined, "a dead owner holds nothing");
  const first = await acquireRenderSlot({dir, command: "after a dead owner", wait: false});
  assert.equal(await ownerPid(dir), process.pid);
  first.release();
  assert.equal(await exists(dir), false);

  // After a reboot the pid can be alive again as another process.
  const other = sleeper(t);
  await holdAs(dir, {pid: other.pid, repo: "se-dev-kit", command: "render before a reboot", startedAt: "2000-01-01T00:00:00.000Z"});
  const second = await acquireRenderSlot({dir, command: "after a reboot", wait: false});
  assert.equal(await ownerPid(dir), process.pid);
  second.release();
});

test("a slot without owner.json is held for 10 s after its mkdir, then taken over", async (t) => {
  const dir = await slotFolder(t);
  await mkdir(dir);
  const age = async (seconds) => {
    const at = new Date(Date.now() - seconds * 1000);
    await utimes(dir, at, at);
  };
  await age(9);
  await assert.rejects(acquireRenderSlot({dir, command: "t", wait: false}), /still writing its owner file/);
  assert.deepEqual(renderSlotHolder(dir), {owner: null});
  await age(11);
  const slot = await acquireRenderSlot({dir, command: "t", wait: false});
  assert.equal(await ownerPid(dir), process.pid);
  slot.release();
});

test("the owner's children and nested calls run under its slot, an unrelated process does not, and only the owner removes it", async (t) => {
  const dir = await slotFolder(t);
  const slot = await acquireRenderSlot({dir, command: "parent", wait: false});
  try {
    assert.equal(process.env[HELD_ENV], String(process.pid));
    const nested = await acquireRenderSlot({dir, command: "nested", wait: false});
    assert.equal(nested.inherited, true);
    nested.release();
    assert.equal(await exists(dir), true, "a nested release keeps the slot");
    const mine = process.env[HELD_ENV];
    delete process.env[HELD_ENV];
    try {
      const own = await acquireRenderSlot({dir, command: "nested, without the variable", wait: false});
      assert.equal(own.inherited, true, "the owner never waits for its own slot");
    } finally {
      process.env[HELD_ENV] = mine;
    }

    const take = `try { const slot = await m.acquireRenderSlot({dir: ${JSON.stringify(dir)}, command: "child", wait: false}); console.log(slot.inherited); slot.release(); } catch (error) { console.log(error.code); }`;
    assert.equal(await inChild(take), "true");
    const {[HELD_ENV]: _held, ...unrelated} = process.env;
    assert.equal(await inChild(take, unrelated), "RENDER_SLOT_BUSY");
    assert.equal(await inChild(`console.log(m.releaseRenderSlot(${JSON.stringify(dir)}));`), "false");
    assert.equal(await ownerPid(dir), process.pid, "neither the child's release nor another process's removes the slot");
  } finally {
    slot.release();
  }
  assert.equal(await exists(dir), false);
  assert.equal(process.env[HELD_ENV], undefined);
  assert.equal(releaseRenderSlot(dir), false, "nothing is left to release");
});

test("the slot is released when its owner exits without releasing it and when it gets SIGTERM", {timeout: 30_000}, async (t) => {
  const dir = await slotFolder(t);
  await inChild(`await m.acquireRenderSlot({dir: ${JSON.stringify(dir)}, command: "exits", wait: false}); process.exit(0);`);
  assert.equal(await exists(dir), false, "released on exit");

  const child = spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(moduleUrl)});
await m.acquireRenderSlot({dir: ${JSON.stringify(dir)}, command: "signalled", wait: false});
console.log("held");
setInterval(() => {}, 1000);`], {stdio: ["ignore", "pipe", "inherit"]});
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100 && !output.includes("held"); attempt += 1) await sleep(50);
  assert.equal(await ownerPid(dir), child.pid);
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 143);
  assert.equal(await exists(dir), false, "released on SIGTERM");
});

test("local capture and render wait for the render slot another process holds, and a dry run does not", {timeout: 90_000}, async (t) => {
  const dir = await slotFolder(t);
  const output = await mkdtemp(join(tmpdir(), "sws-slot-cli-"));
  t.after(() => rm(output, {recursive: true, force: true}));
  const {[HELD_ENV]: _held, ...rest} = process.env;
  // A missing machine check leaves the slot alone to decide (tests/unit/machine-check.test.mjs covers the check).
  const env = {...rest, RENDER_SLOT_DIR: dir, MACHINE_CHECK: join(output, "no-machine-check.py")};
  const commands = {
    capture: ["capture", exampleRoot, "--scene", "hero"],
    render: ["render", exampleRoot, "--recipe", "listing-media"]
  };
  for (const [name, args] of Object.entries(commands)) {
    const other = sleeper(t);
    await holdAs(dir, {pid: other.pid, repo: "background-creator", command: "npm run render:mp4", startedAt: new Date().toISOString()});
    const base = [cliPath, ...args, "--json", "--output", join(output, name), "--allow-low-disk", "--allow-unsupported-node"];

    const dryRun = await execFileAsync(process.execPath, [...base, "--dry-run"], {env, maxBuffer: 16 * 1024 * 1024});
    assert.equal(JSON.parse(dryRun.stdout).status, "dry-run", `${name}: ${dryRun.stderr}`);

    const cli = spawn(process.execPath, [...base, "--browser-path", join(output, "missing-chrome")], {env, stdio: ["ignore", "ignore", "pipe"]});
    t.after(() => cli.kill("SIGKILL"));
    let stderr = "";
    cli.stderr.on("data", (chunk) => { stderr += chunk; });
    const waiting = `Waiting for the render slot, held by pid ${other.pid} (background-creator: npm run render:mp4)`;
    for (let attempt = 0; attempt < 200 && !stderr.includes(waiting); attempt += 1) await sleep(50);
    assert.ok(stderr.includes(waiting), `${name}: ${stderr}`);
    assert.equal(await ownerPid(dir), other.pid);

    other.kill("SIGKILL");
    const [code] = await once(cli, "exit");
    assert.equal(code, 3, `${name}: ${stderr}`);
    assert.match(stderr, /"code": "BROWSER_NOT_FOUND"/, `${name} ran once the holder was gone`);
    assert.equal(await exists(dir), false, `${name} gave the slot back`);
  }
});

test("src/shared/render-slot.ts is the vault source, byte for byte", async (t) => {
  const source = join(homedir(), "obsidian", "AI", "scripts", "render-slot.ts");
  if (!(await exists(source))) return t.skip("no vault on this machine");
  const copy = await readFile(fileURLToPath(new URL("../../src/shared/render-slot.ts", import.meta.url)));
  assert.ok(copy.equals(await readFile(source)), "src/shared/render-slot.ts differs from ~/obsidian/AI/scripts/render-slot.ts: edit the source, then run python3 ~/obsidian/AI/scripts/render_slot_copias.py --write");
});
