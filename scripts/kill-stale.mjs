// Kills this checkout's orphans only: a Chrome started by launchStudioBrowser (marked
// --se-widget-studio) whose launcher died, and a test or job worker whose runner died, with its
// Chrome. It never runs a global pkill: other sessions and consumer renders use the same Chrome binary.
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkoutOrphans, killTree, listProcesses, shortCommand} from './lib/machine.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function killStale(root = ROOT, log = console.log) {
  const {orphans, reported} = await checkoutOrphans(root, await listProcesses());
  const killed = orphans.filter(item => killTree(item.pid));
  for (const item of killed) log(`Killed PID ${item.pid}: ${shortCommand(item.command)}`);
  for (const item of reported) log(`Left running (PPID 1, maybe a job someone put in the background): PID ${item.pid} ${shortCommand(item.command)}`);
  if (!killed.length) log('Nothing to kill: this checkout has no orphan Chrome or test worker.');
  return {killed, reported};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await killStale();
