import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {mkdir, mkdtemp, rm, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {buildFreshness, buildInfo} from "../../dist/build-info.js";
import {STUDIO_VERSION} from "../../dist/version.js";
import {runDoctor} from "../../dist/validation/doctor.js";

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

const COMMIT = "a".repeat(40);

/** A checkout-shaped folder: dist/build-info.json written at `builtAt`, and src/ files with their own times. */
async function checkout(t, {dirty = false, commit = COMMIT, builtAt, sources = {}}) {
  const root = await mkdtemp(join(tmpdir(), "sws-build-info-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, "dist"), {recursive: true});
  await mkdir(join(root, "src/capture"), {recursive: true});
  const info = join(root, "dist/build-info.json");
  await writeFile(info, JSON.stringify({version: "9.9.9", commit, dirty}));
  await utimes(info, builtAt, builtAt);
  for (const [path, time] of Object.entries(sources)) {
    await writeFile(join(root, path), "// source\n");
    await utimes(join(root, path), time, time);
  }
  return root;
}

const codes = (freshness) => freshness.warnings.map((warning) => warning.code);

test("a clean build newer than every source has no warning, and the doctor reports its commit", async (t) => {
  const root = await checkout(t, {builtAt: new Date("2026-09-28T12:00:00Z"), sources: {"src/index.ts": new Date("2026-09-28T11:00:00Z")}});
  const freshness = await buildFreshness(join(root, "dist"));
  assert.deepEqual(freshness.warnings, []);
  assert.deepEqual(freshness.newerSources, []);
  const doctor = await runDoctor({distDirectory: join(root, "dist")});
  const build = doctor.diagnostics.find((diagnostic) => diagnostic.code === "BUILD");
  assert.equal(build?.status, "ok");
  assert.match(build.detail, new RegExp(`built from commit ${COMMIT}`));
});

test("a dirty build and sources changed after it are warnings in the doctor", async (t) => {
  const builtAt = new Date("2026-09-28T12:00:00Z");
  const root = await checkout(t, {
    dirty: true,
    builtAt,
    sources: {
      "src/index.ts": new Date("2026-09-28T11:00:00Z"),
      "src/capture/renderer.ts": new Date("2026-09-28T12:05:00Z"),
      "src/version.ts": new Date("2026-09-28T12:10:00Z")
    }
  });
  const freshness = await buildFreshness(join(root, "dist"));
  assert.deepEqual(codes(freshness), ["BUILD_DIRTY", "BUILD_STALE"]);
  assert.deepEqual(freshness.newerSources, ["src/version.ts", "src/capture/renderer.ts"], "newest first, only files changed after the build");
  assert.match(freshness.warnings[0].detail, /uncommitted changes on top of aaaaaaaaaaaa/);
  assert.match(freshness.warnings[1].detail, /src\/version\.ts, src\/capture\/renderer\.ts changed after the build/);

  const doctor = await runDoctor({distDirectory: join(root, "dist")});
  const build = doctor.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("BUILD"));
  assert.deepEqual(build.map((diagnostic) => [diagnostic.status, diagnostic.code]), [["warning", "BUILD_DIRTY"], ["warning", "BUILD_STALE"]]);
  assert.ok(build.every((diagnostic) => /npm run build:engine/.test(diagnostic.hint)));
});

test("a build from another commit than the checkout's HEAD is stale; a build without a commit is unknown", async (t) => {
  const builtAt = new Date("2026-09-28T12:00:00Z");
  const root = await checkout(t, {builtAt, commit: "b".repeat(40)});
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
  git("init", "--quiet");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "test");
  const head = git("rev-parse", "HEAD");
  const moved = await buildFreshness(join(root, "dist"));
  assert.deepEqual(codes(moved), ["BUILD_STALE"]);
  assert.equal(moved.head, head);
  assert.match(moved.warnings[0].detail, new RegExp(`built from bbbbbbbbbbbb, but the checkout is at ${head.slice(0, 12)}`));

  await writeFile(join(root, "dist/build-info.json"), JSON.stringify({version: "9.9.9", commit: null, dirty: null}));
  assert.deepEqual(codes(await buildFreshness(join(root, "dist"))), ["BUILD_UNKNOWN"]);
  await rm(join(root, "dist/build-info.json"));
  assert.deepEqual(codes(await buildFreshness(join(root, "dist"))), ["BUILD_UNKNOWN"]);
});
