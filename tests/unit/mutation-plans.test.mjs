// Every mutation plan still matches the code it mutates: only `npm run mutate` read a plan, so a `from` the code
// moved away from went unnoticed until someone ran that plan (#20).
import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {checkPlans} from "../../scripts/mutate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("every entry of every tests/**/*.mutations.json names files that exist and a from that occurs as often as it says", async () => {
  const {plans, problems} = await checkPlans(ROOT);
  for (const plan of ["tests/integration/two-copies.mutations.json", "tests/unit/mutation-plans.mutations.json", "tests/web/held-slot.mutations.json"]) {
    assert.ok(plans.includes(plan), `${plan} was not found among ${plans.length} plan(s)`);
  }
  assert.deepEqual(problems, []);
});

const SOURCE = "export const sum = (a, b) => a + b;\nexport const pair = [1, 1];\n";
const entry = (from, extra = {}) => ({file: "lib/math.mjs", from, to: "0", test: "tests/unit/math.test.mjs", ...extra});
const FILES = {
  "lib/math.mjs": SOURCE,
  "tests/unit/math.test.mjs": "import test from 'node:test';\ntest('adds', () => {});\n",
  // Not a plan: only *.mutations.json files are read.
  "tests/unit/sample.lock.json": JSON.stringify({files: {}}),
  "tests/unit/empty.mutations.json": "[]",
  "tests/unit/math.mutations.json": JSON.stringify({mutations: [
    entry("a + b"),
    entry("a * b"),
    entry("1"),
    entry("1", {occurrences: 2}),
    entry("1", {occurrences: 3})
  ]}),
  "tests/web/nested/deep.mutations.json": JSON.stringify([
    entry("a + b", {file: "lib/gone.mjs"}),
    entry("a + b", {test: "tests/unit/gone.test.mjs"}),
    entry("pair")
  ])
};

test("a stale plan entry is named with its plan, its place, its from and the count", async t => {
  const root = await mkdtemp(join(tmpdir(), "sws-mutation-plans-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), text);
  }
  const {plans, problems} = await checkPlans(root);
  assert.deepEqual(plans, ["tests/unit/empty.mutations.json", "tests/unit/math.mutations.json", "tests/web/nested/deep.mutations.json"]);
  assert.deepEqual(problems, [
    'tests/unit/empty.mutations.json: A plan is a non-empty JSON array of mutations, or {"mutations": [...]}.',
    'tests/unit/math.mutations.json: Mutation 2 ("a * b"): lib/math.mjs: "from" occurs 0 time(s), expected 1.',
    'tests/unit/math.mutations.json: Mutation 3 ("1"): lib/math.mjs: "from" occurs 2 time(s), expected 1.',
    'tests/unit/math.mutations.json: Mutation 5 ("1"): lib/math.mjs: "from" occurs 2 time(s), expected 3.',
    'tests/web/nested/deep.mutations.json: Mutation 1: "file" does not exist: lib/gone.mjs.',
    'tests/web/nested/deep.mutations.json: Mutation 2: "test" does not exist: tests/unit/gone.test.mjs.'
  ]);
});
