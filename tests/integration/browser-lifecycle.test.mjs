import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {setTimeout as sleep} from "node:timers/promises";
import test from "node:test";

import {BROWSER_MARKER, closeStudioBrowser, detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {detectMediaTooling} from "../../dist/capture/media.js";
import {renderRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";

const execFileAsync = promisify(execFile);
const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

async function children() {
  const {stdout} = await execFileAsync("ps", ["-axww", "-o", "pid=,ppid=,command="], {maxBuffer: 32 * 1024 * 1024});
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && Number(match[2]) === process.pid ? [{pid: Number(match[1]), command: match[3]}] : [];
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a Chrome frozen at close is killed at the deadline, found by its launch marker", {timeout: 60_000, skip: process.platform === "win32"}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const {browser} = await launchStudioBrowser({browserPath: detection.executablePath});
  const marked = (await children()).filter((item) => item.command.includes(`${BROWSER_MARKER}=${process.pid}-`));
  assert.equal(marked.length, 1, "the launched Chrome carries this process's launch marker");
  const pid = marked[0].pid;
  t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
  // A stopped process never answers Browser.close, like the Chrome that held renders forever.
  process.kill(pid, "SIGSTOP");
  const started = Date.now();
  const result = await closeStudioBrowser(browser, {timeoutMs: 2_000});
  assert.equal(result.closed, false);
  assert.deepEqual(result.killed, [pid]);
  assert.ok(Date.now() - started < 10_000, `close returned after ${Date.now() - started} ms`);
  for (let attempt = 0; attempt < 50 && alive(pid); attempt += 1) await sleep(100);
  assert.equal(alive(pid), false, "the frozen Chrome is gone");
});

test("a render reports each phase in order, and two renders can share one browser", {timeout: 120_000}, async (t) => {
  const [detection, tooling] = await Promise.all([detectBrowser(), detectMediaTooling()]);
  if (!detection.executablePath || !tooling.ffmpegPath || !tooling.ffprobePath) {
    t.skip("A local Chromium and FFmpeg are needed for a video render; the Studio never downloads them.");
    return;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-trace-integration-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const project = await loadProject({inputDirectory: exampleRoot});
  project.scenes.push({
    id: "trace-smoke",
    filePath: "",
    value: {
      schemaVersion: 1,
      id: "trace-smoke",
      name: "Trace smoke",
      theme: "midnight",
      fixture: "launch-chat",
      viewport: {width: 320, height: 240, deviceScaleFactor: 1},
      output: {width: 320, height: 240, format: "png"}
    }
  });
  const recipe = (id) => ({
    schemaVersion: 1,
    id,
    name: id,
    scenes: ["trace-smoke"],
    outputs: {screenshots: true, video: {enabled: true, durationMs: 1000, fps: 2, format: "mp4", codec: "h264", pixelFormat: "yuv420p", audio: "none"}},
    limit: 1
  });
  const media = {browserPath: detection.executablePath, ffmpegPath: tooling.ffmpegPath, ffprobePath: tooling.ffprobePath};

  const events = [];
  await renderRecipe(project, recipe("trace-own"), {outputRoot, ...media, trace: (event) => events.push(event)});
  assert.deepEqual(events.map((event) => event.phase), [
    "browser launch", "browser ready", "input check", "screenshot", "video frames", "video encoding", "frame cleanup",
    "manifest", "manifest written", "browser close", "browser closed", "server close", "server closed"
  ]);
  assert.ok(events.every((event, index) => index === 0 || event.elapsedMs >= events[index - 1].elapsedMs), "elapsed time never goes back");
  assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.at))));
  assert.match(events.find((event) => event.phase === "video encoding").variant, /^trace-smoke-/);

  const shared = await launchStudioBrowser({browserPath: detection.executablePath});
  try {
    for (const id of ["trace-shared-a", "trace-shared-b"]) {
      const phases = [];
      const result = await renderRecipe(project, recipe(id), {outputRoot, ...media, browser: shared, trace: (event) => phases.push(event.phase)});
      assert.equal(result.status, "final");
      assert.ok(!phases.includes("browser launch") && !phases.includes("browser close"), `${id} used the shared browser`);
      assert.equal(shared.browser.isConnected(), true, `${id} left the shared browser open`);
    }
  } finally {
    await closeStudioBrowser(shared.browser);
  }
});
