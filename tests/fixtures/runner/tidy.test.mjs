import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

test("removes the folder it creates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
});
