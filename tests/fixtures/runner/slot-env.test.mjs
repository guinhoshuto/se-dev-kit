import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";

import {acquireRenderSlot, historyDir} from "../../../dist/shared/render-slot.js";

test("runs with a render slot inside its own TMPDIR, and taking it leaves only the slot's history", async () => {
  assert.equal(process.env.RENDER_SLOT_DIR, join(process.env.TMPDIR, "render-slot"));
  // What a CLI render a test starts does: it takes the suite's slot, which writes its history beside it (#23).
  const slot = await acquireRenderSlot({command: "slot-env fixture", repo: "se-dev-kit", wait: false});
  slot.release();
  assert.ok(existsSync(historyDir()), `the slot wrote no history in ${historyDir()}`);
});
