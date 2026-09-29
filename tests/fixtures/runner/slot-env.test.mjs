import assert from "node:assert/strict";
import {join} from "node:path";
import test from "node:test";

test("runs with a render slot inside its own TMPDIR", () => {
  assert.equal(process.env.RENDER_SLOT_DIR, join(process.env.TMPDIR, "render-slot"));
});
