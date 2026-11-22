import assert from "node:assert/strict";
import test from "node:test";

import {underLoad} from "./load.mjs";

test("underLoad keeps a deadline below one runnable process per core", () => {
  assert.equal(underLoad(2500, {load: 0, cores: 8}), 2500);
  assert.equal(underLoad(2500, {load: 5.5, cores: 8}), 2500);
  assert.equal(underLoad(2500, {load: 8, cores: 8}), 2500);
});

test("underLoad stretches a deadline by the load per core: 3x at the machine check's limit, 25x at 2026-11-20's load", () => {
  assert.equal(underLoad(10_000, {load: 24, cores: 8}), 30_000, "3 per core, where the machine check says busy");
  assert.equal(underLoad(10_000, {load: 200, cores: 8}), 250_000, "the load that stopped the gate at unit (issue #50)");
  assert.equal(underLoad(1000, {load: 10, cores: 3}), 3334, "a fraction rounds up");
});

test("underLoad reads the machine's load and cores when none are given, and never shortens", () => {
  const ms = underLoad(1000);
  assert.ok(Number.isInteger(ms) && ms >= 1000, `got ${ms}`);
});
