import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import test from "node:test";

import {buildInfo} from "../../dist/build-info.js";
import {STUDIO_VERSION} from "../../dist/version.js";

const packageVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

test("the engine version is the package version", () => {
  assert.equal(STUDIO_VERSION, packageVersion);
});

test("build:engine records the commit and whether tracked files were dirty", () => {
  const info = buildInfo();
  assert.equal(info.version, packageVersion);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  assert.equal(info.commit, process.env.VERCEL_GIT_COMMIT_SHA || head);
  assert.equal(typeof info.dirty, "boolean");
});
