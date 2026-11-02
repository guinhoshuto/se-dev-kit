import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Two sessions recorded the same lesson on 2026-10-29 (cb7188d and c6f58ce), so «Known pitfalls» said twice that a
// test taking the render slot in its own process sets its own RENDER_SLOT_DIR (#26). One bullet keeps the lesson:
// the variables in a temporary folder atop the file, removed in `after`, the reason, and the example test file.
const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");
const pitfalls = readme.split(/^## Known pitfalls$/m)[1].split(/^## /m)[0];
const bullets = pitfalls.split(/^- /m).slice(1);

test("README Known pitfalls states the RENDER_SLOT_DIR lesson of a test taking the slot in its own process once", () => {
  const lesson = bullets.filter((b) => b.includes("in its own process") && b.includes("`RENDER_SLOT_DIR`"));
  assert.equal(lesson.length, 1, `expected one bullet on a test taking the slot in its own process, found ${lesson.length}`);
  const [bullet] = lesson;
  assert.ok(bullet.includes("removed in `after`"), "the bullet does not say the temporary folder is removed in `after`");
  assert.ok(bullet.includes("`tests/unit/cut-loop.test.mjs`"), "the bullet does not name tests/unit/cut-loop.test.mjs");
  assert.ok(bullet.includes("queue on the machine's real slot"), "the bullet does not give the reason: queueing on the machine's real slot");
});
