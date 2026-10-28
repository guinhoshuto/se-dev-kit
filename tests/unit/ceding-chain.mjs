// A chain of the harness that holds the render slot step by step and cedes its turn (hold --ceder, each round of the
// vault's mutar_copia.py), and a fake machine check that reads the slot and its queue as maquina_livre.py does. The
// wait-free test (tests/unit/machine.test.mjs) and the skill client's (tests/web/skill-client-machine.test.ts) share
// them (#15).
import {execFile, spawn} from "node:child_process";
import {once} from "node:events";
import {appendFileSync, readFileSync} from "node:fs";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

export const RENDER_SLOT = fileURLToPath(new URL("../../dist/shared/render-slot.js", import.meta.url));

/**
 * Two loops of `hold --ceder` that take turns, as the vault's two mutation chains did on 2026-10-27: while a step of one
 * holds the slot, the next step of the other waits in the queue, so the slot is never free with the queue empty and a
 * waiter that polls never sees the machine free. Each step holds `stepMs`, and longer while `gate()` is true, and
 * appends `chain <taken> <released>` (ms, both inside its hold) to `log`.
 */
export function cedingChain({env, log, stepMs = 800, gate = () => false}) {
  let stopped = false;
  const live = new Set();
  const loop = async (label) => {
    while (!stopped) {
      const hold = spawn(process.execPath, [RENDER_SLOT, "hold", "--rotulo", label, "--max", "5", "--ceder"], {env, stdio: ["ignore", "pipe", "ignore"]});
      live.add(hold);
      const exited = once(hold, "exit");
      let output = "";
      hold.stdout.on("data", (chunk) => { output += chunk; });
      while (!stopped && hold.exitCode === null && !output.includes("Holding the render slot")) await sleep(10);
      if (output.includes("Holding the render slot")) {
        const taken = Date.now();
        await sleep(stepMs);
        while (!stopped && gate()) await sleep(10);
        appendFileSync(log, `chain ${taken} ${Date.now()}\n`);
      }
      // What `render-slot release` sends.
      hold.kill("SIGTERM");
      await exited;
      live.delete(hold);
    }
  };
  const loops = [loop("chain-a"), loop("chain-b")];
  return {
    stop: async () => {
      stopped = true;
      for (const hold of live) hold.kill("SIGTERM");
      await Promise.all(loops);
    }
  };
}

/** The lines of `log` as {who, from, to}, in the order they were written. */
export function steps(log) {
  let text = "";
  try { text = readFileSync(log, "utf8"); } catch { /* nothing yet */ }
  return text.split("\n").filter(Boolean).map((line) => {
    const [who, from, to] = line.split(" ");
    return {who, from: Number(from), to: Number(to)};
  });
}

/** A heavy step that takes the slot as a product, with `render-slot run`, and appends `<who> <taken> <released>` to `log`. */
export function productStep(env, log, who, holdMs = 300) {
  const code = `const fs = require("node:fs"); const taken = Date.now(); setTimeout(() => fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(who)} + " " + taken + " " + Date.now() + "\\n"), ${holdMs});`;
  return promisify(execFile)(process.execPath, [RENDER_SLOT, "run", "--", process.execPath, "-e", code], {env});
}

/**
 * A fake maquina_livre.py in `folder` that reads the render slot of RENDER_SLOT_DIR as the real check does: busy with
 * the slot ("trava") while it is held, else with its queue ("fila") while a live ticket outside the asker's family (its
 * --familia pid and the processes under it, by ps) waits. Each call appends its arguments to calls.log.
 */
export async function slotCheck(folder) {
  const script = join(folder, "maquina_livre.py");
  await writeFile(script, [
    "import json, os, re, subprocess, sys",
    "with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'calls.log'), 'a') as f: f.write(' '.join(sys.argv[1:]) + '\\n')",
    "slot = os.environ['RENDER_SLOT_DIR']",
    "asker = int(sys.argv[sys.argv.index('--familia') + 1])",
    "table = subprocess.run(['ps', '-axo', 'pid=,ppid='], capture_output=True, text=True).stdout.split()",
    "parent = dict(zip(map(int, table[0::2]), map(int, table[1::2])))",
    "def family(pid):",
    "    while pid > 1:",
    "        if pid == asker: return True",
    "        pid = parent.get(pid, 0)",
    "    return False",
    "reasons, kinds = [], []",
    "if os.path.isdir(slot):",
    "    reasons.append('the render slot is held'); kinds.append('trava')",
    "else:",
    "    queue = slot + '.queue'",
    "    names = os.listdir(queue) if os.path.isdir(queue) else []",
    "    waiting = [n for n in names if re.match(r'^\\d{15}-\\d{7}\\.json$', n) and int(n[16:23]) in parent and not family(int(n[16:23]))]",
    "    if waiting: reasons.append('%d waiting in the render slot queue' % len(waiting)); kinds.append('fila')",
    "print(json.dumps({'livre': not reasons, 'motivos': reasons, 'reasons': reasons, 'tipos': kinds}))",
    "sys.exit(3 if reasons else 0)"
  ].join("\n"));
  return script;
}
