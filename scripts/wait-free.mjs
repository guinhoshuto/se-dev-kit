// Waits until no other session renders: nobody else holds the machine-wide render slot
// (~/.cache/render-slot), and no headless or automated Chrome, Remotion render, or local Studio render
// runs outside this process tree. It first kills this checkout's own orphans, which would otherwise
// hold the wait forever. Ported from the waitfree.sh of 2026-09-27 (one check a minute, 30 minutes at
// most). Exit 0 when the machine is free, 1 when it is still busy. Needs the built engine (dist/).
import {setTimeout as sleep} from 'node:timers/promises';
import {killStale} from './kill-stale.mjs';
import {freeBytes, listProcesses, MIN_FREE_BYTES, otherSessionsWork, shortCommand} from './lib/machine.mjs';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} needs a non-negative number.`);
  return value;
};
const {describeSlotHolder, renderSlotHolder, slotDir} = await import('../dist/shared/render-slot.js');
const minutes = option('--timeout-min', 30);
const interval = option('--interval-s', 60);

await killStale();
const deadline = Date.now() + minutes * 60_000;
for (let checks = 0; ; checks += 1) {
  const holder = renderSlotHolder();
  const busy = otherSessionsWork(await listProcesses(), [process.pid]);
  const reason = holder
    ? `the render slot ${slotDir()} is ${describeSlotHolder(holder.owner)}`
    : busy.length ? `PID ${busy[0].pid} ${shortCommand(busy[0].command)}${busy.length > 1 ? ` (+${busy.length - 1} more)` : ''}` : undefined;
  if (!reason) {
    const free = await freeBytes(process.cwd());
    console.log(`Machine free after ${checks} check(s).${free < MIN_FREE_BYTES ? ` Only ${(free / 1024 ** 3).toFixed(1)} GiB free on disk: do not start a render below 3 GiB.` : ''}`);
    process.exit(0);
  }
  if (Date.now() + interval * 1000 > deadline) {
    console.log(`Still busy after ${minutes} min: ${reason}`);
    process.exit(1);
  }
  if (checks === 0) console.log(`Busy: ${reason}. Checking every ${interval} s for up to ${minutes} min.`);
  await sleep(interval * 1000);
}
