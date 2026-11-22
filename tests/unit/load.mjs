// A fixed deadline that passes on an idle machine misses on a loaded one: on 2026-11-20 the gate stopped at `unit`
// (issue #50) while the machine ran at load 100 to 200 on 8 cores, with nothing wrong in the change. A test that waits
// for a process it spawned takes its deadline from here, or grows it by observation (tests/unit/mutate.test.mjs).
import {availableParallelism, loadavg} from "node:os";

/**
 * `ms` stretched by the machine's load per core, never shortened: at or below one runnable process per core it is
 * `ms`; at the machine check's limit (3 per core) it is 3x; at load 200 on 8 cores, 25x.
 */
export function underLoad(ms, {load = loadavg()[0], cores = availableParallelism()} = {}) {
  return Math.ceil(ms * Math.max(1, load / cores));
}
