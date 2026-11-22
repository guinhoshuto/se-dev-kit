// Run by tests/unit/run-tests.test.mjs through execute: Node's spec reporter prints each skip below as
// `﹣ <name> (<ms>ms) # <reason>`, indented when nested, and the runner lists the NOT COVERED ones (#48).
import test from "node:test";

test("a skip that names its command", (t) => t.skip("NOT COVERED: ffmpeg is missing; run brew install ffmpeg (x) --write"));
test("an options skip", {skip: "NOT COVERED: the option's reason"}, () => {});
test("a plain skip", (t) => t.skip("not today"));
test("a group", async (t) => {
  await t.test("a nested skip", (t) => t.skip("NOT COVERED: the nested reason"));
  await t.test("a nested pass", () => {});
});
test("a passing test", () => {});
