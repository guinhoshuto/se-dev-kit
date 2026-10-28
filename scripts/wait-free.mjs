// Waits until the machine is free for a render. Where the machine check every repo shares is on this
// machine (~/obsidian/AI/scripts/maquina_livre.py, see machineVerdict), free is what it says: no other
// render, nobody else holding the render slot or waiting in its queue, the game closed, enough free memory
// and disk. Elsewhere, nobody else holds the machine-wide render slot (~/.cache/render-slot) or waits in its
// queue, and no headless or automated Chrome, Remotion render, or local Studio render runs outside this
// process tree; a stalled one (splitStalled) is only a warning. While the slot or its queue is the reason
// (with at most memory besides), it waits in that queue with a product ticket, "vez: wait-free", which a
// chain that holds the slot step by step and cedes its turn (hold --ceder) lets go first between two of its
// steps; polling never saw such a chain's slot free (#15). At its turn it exits 0, and those that cede leave
// the free slot for 30 s to the render that follows. It first kills this checkout's own orphans, which would
// otherwise hold the wait forever. Ported from the waitfree.sh of 2026-09-27 (one check a minute, 30 minutes
// at most, counted from its start, in the queue too). Exit 0 when the machine is free, 1 when it is still
// busy. Needs the built engine (dist/).
import {killStale} from './kill-stale.mjs';
import {freeBytes, listProcesses, MIN_FREE_BYTES, otherSessionsWork, shortCommand, splitStalled, stalledWarning} from './lib/machine.mjs';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} needs a non-negative number.`);
  return value;
};
const {describeSlotHolder, renderSlotHolder, renderSlotQueue, slotDir} = await import('../dist/shared/render-slot.js');
const {machineVerdict, waitForMachine} = await import('../dist/shared/machine-check.js');
const minutes = option('--timeout-min', 30);
const interval = option('--interval-s', 60);

// A stalled render does not hold the wait; its warning is printed once.
const warned = new Set();
// How many checks said to wait; whether the last answer came from the shared check, and its reasons.
let checks = 0;
let checked = false;
let reasons = [];

/**
 * The shared check's verdict; where it is missing, the slot ("trava"), its queue ("fila") and the process list
 * ("render"), each reason with its kind, as the shared check names them.
 */
async function verdict() {
  const answer = await machineVerdict();
  checked = answer !== null;
  if (answer) {
    reasons = answer.reasons;
    if (!answer.free) checks += 1;
    return answer;
  }
  const holder = renderSlotHolder();
  const queue = renderSlotQueue();
  const processes = await listProcesses();
  const {busy, stalled} = await splitStalled(otherSessionsWork(processes, [process.pid]), processes);
  for (const item of stalled.filter(item => !warned.has(item.pid))) {
    warned.add(item.pid);
    console.log(`Warning: ${stalledWarning(item)}`);
  }
  const found = [
    ...(holder ? [[`the render slot ${slotDir()} is ${describeSlotHolder(holder.owner)}`, 'trava']] : []),
    ...(!holder && queue.length ? [[`${queue.length} waiting in the render slot queue, the first pid ${queue[0].pid} (${queue[0].repo}: ${queue[0].command})`, 'fila']] : []),
    ...(busy.length ? [[`PID ${busy[0].pid} ${shortCommand(busy[0].command)}${busy.length > 1 ? ` (+${busy.length - 1} more)` : ''}`, 'render']] : [])
  ];
  reasons = found.map(([reason]) => reason);
  if (found.length) checks += 1;
  return found.length ? {free: false, reasons, kinds: found.map(([, kind]) => kind)} : {free: true, reasons: []};
}

await killStale();
try {
  const {turn} = await waitForMachine({check: verdict, queue: 'wait-free', pollMs: interval * 1000, waitLimitMs: minutes * 60_000, log: message => console.log(message)});
  // The shared check already waits for the disk; without it, only a warning.
  const free = checked ? MIN_FREE_BYTES : await freeBytes(process.cwd());
  const where = turn ? ', at its turn in the render slot queue: start the render now, while those that cede leave the slot to it (30 s)' : '';
  console.log(`Machine free after ${checks} check(s)${where}.${free < MIN_FREE_BYTES ? ` Only ${(free / 1024 ** 3).toFixed(1)} GiB free on disk: do not start a render below 3 GiB.` : ''}`);
  process.exit(0);
} catch (error) {
  if (error?.code !== 'MACHINE_BUSY_TIMEOUT') throw error;
  console.log(`Still busy after ${minutes} min: ${reasons.join('; ')}`);
  process.exit(1);
}
