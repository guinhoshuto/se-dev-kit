import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

test("leaves a folder in the temporary directory", async () => {
  await mkdtemp(join(tmpdir(), "leaky-"));
});
