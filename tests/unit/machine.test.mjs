import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {once} from "node:events";
import {existsSync} from "node:fs";
import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {homedir, tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {BROWSER_MARKER as ENGINE_MARKER} from "../../dist/capture/browser.js";
import {BROWSER_MARKER, HEAVY_PATTERNS, WRAPPERS, browserGate, checkoutOrphans, isHeavy, listProcesses, machineVerdict, otherSessionsWork, parseProcessList, parseUsage, parseVerdict, readUsage, splitStalled} from "../../scripts/lib/machine.mjs";
import {killStale} from "../../scripts/kill-stale.mjs";
import {cedingChain, productStep, RENDER_SLOT, slotCheck, steps} from "./ceding-chain.mjs";

const ROOT = "/work/se-dev-kit";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const cwds = new Map();
const cwd = async (pid) => cwds.get(pid);

function processes() {
  cwds.clear();
  const list = [
    {pid: 10, ppid: 1, command: `${CHROME} --headless --remote-debugging-pipe ${BROWSER_MARKER}=77-1`, cwd: ROOT},
    {pid: 11, ppid: 1, command: `${CHROME} --headless --remote-debugging-pipe ${BROWSER_MARKER}=78-1`, cwd: "/work/se-windows"},
    {pid: 12, ppid: 40, command: `${CHROME} --headless --remote-debugging-pipe ${BROWSER_MARKER}=40-1`, cwd: ROOT},
    {pid: 20, ppid: 1, command: "/opt/homebrew/bin/node --import tsx --test-force-exit /work/se-dev-kit/tests/web/jobs.test.ts", cwd: ROOT},
    {pid: 21, ppid: 20, command: `${CHROME} --headless --remote-debugging-pipe ${BROWSER_MARKER}=20-1`, cwd: ROOT},
    {pid: 22, ppid: 21, command: `${CHROME} Helper (Renderer) --type=renderer`, cwd: ROOT},
    {pid: 30, ppid: 1, command: "/opt/homebrew/bin/node --test --test-concurrency=1 tests/integration/tutorial.test.mjs", cwd: ROOT},
    {pid: 31, ppid: 1, command: "/opt/homebrew/bin/node /work/se-dev-kit/dist/cli/index.js render . --recipe listing", cwd: ROOT},
    {pid: 40, ppid: 900, command: "/opt/homebrew/bin/node /work/se-dev-kit/tests/integration/browser.test.mjs", cwd: ROOT},
    {pid: 50, ppid: 1, command: "/opt/homebrew/bin/node /work/remotion/node_modules/@remotion/cli/remotion-cli.js render", cwd: "/work/background-creator"},
    {pid: 60, ppid: 1, command: `${CHROME} --type=renderer`, cwd: "/"},
    {pid: 61, ppid: 1, command: "/opt/homebrew/bin/node /work/se-dev-kit/dist/cli/index.js dev .", cwd: ROOT}
  ];
  for (const item of list) cwds.set(item.pid, item.cwd);
  return list.map(({pid, ppid, command}) => ({pid, ppid, command}));
}

test("the kill-stale marker is the switch launchStudioBrowser puts on every Chrome", () => {
  assert.equal(BROWSER_MARKER, ENGINE_MARKER);
  assert.equal(BROWSER_MARKER, "--se-widget-studio");
});

test("ps output parses into pid, ppid and the full command", () => {
  assert.deepEqual(parseProcessList("    1     0 /sbin/launchd\n  402     1 /usr/libexec/UserEventAgent (System)\n\n"), [
    {pid: 1, ppid: 0, command: "/sbin/launchd"},
    {pid: 402, ppid: 1, command: "/usr/libexec/UserEventAgent (System)"}
  ]);
});

test("orphans are this checkout's marked Chromes and dead runners' workers with their Chrome, never a live launcher's", async () => {
  const {orphans, reported} = await checkoutOrphans(ROOT, processes(), {cwd});
  assert.deepEqual(orphans.map((item) => item.pid).sort((a, b) => a - b), [10, 20, 21]);
  // A PPID-1 runner or CLI render may be a job someone put in the background: reported, not killed.
  assert.deepEqual(reported.map((item) => item.pid).sort((a, b) => a - b), [30, 31, 61]);
});

test("a detached shell whose command line names node and a test file or the job worker is not an orphan; the node it leaves behind is", async () => {
  // #12: on 2026-10-25 this wrapper, started inside the checkout with `nohup ... &!` and adopted by launchd,
  // stopped its own run twice with `this checkout left 1 orphan process(es)`. ps shows it so, $PATH and $(date) unexpanded.
  const log = `${ROOT}/.cache/css-transition`;
  const wrapper = `/bin/zsh -c export PATH=/opt/homebrew/opt/node@24/bin:$PATH; cd ${ROOT}; echo "=== $(date '+%F %T') start css-transition-test1" >> ${log}/progress.log; node ~/obsidian/AI/scripts/render-slot.ts run -- npm run test:repeat -- tests/integration/css-transition.test.mjs 1 > ${log}/test-1.log 2>&1; rc=$?; python3 ~/obsidian/AI/scripts/fim_job.py --tarefa css-transition-test1 --rc $rc --log ${log}/progress.log --sem-notificacao`;
  const list = [
    {pid: 70, ppid: 1, command: wrapper},
    {pid: 71, ppid: 1, command: `-zsh -c node scripts/job-worker.mjs ${ROOT}/.studio-data/jobs/j1/input.json 1; echo "worker exited $?"`},
    {pid: 72, ppid: 1, command: `/opt/homebrew/opt/node@24/bin/node ${ROOT}/tests/integration/css-transition.test.mjs`},
    {pid: 73, ppid: 1, command: `/opt/homebrew/opt/node@24/bin/node ${ROOT}/scripts/job-worker.mjs ${ROOT}/.studio-data/jobs/j1/input.json 1`}
  ];
  const {orphans, reported} = await checkoutOrphans(ROOT, list, {cwd: async () => ROOT});
  assert.deepEqual(orphans.map((item) => item.pid), [72, 73]);
  assert.deepEqual(reported, []);
  const gate = (processes) => browserGate({root: ROOT, paths: ["/work"], ownRoots: [900], processes, free: async () => 10 * 1024 ** 3, cwd: async () => ROOT, usage: async () => new Map(), machine: async () => ({free: true, reasons: []})});
  assert.deepEqual(await gate(list.slice(0, 2)), {ok: true});
  assert.match((await gate(list)).reason, /this checkout left 2 orphan process\(es\) \(PID 72, 73\)/);
});

test("another session's work is any headless or piped Chrome, Remotion or local render outside the caller's own tree", () => {
  const busy = otherSessionsWork(processes(), [900]).map((item) => item.pid).sort((a, b) => a - b);
  // 12 and 40 belong to the caller (900). A test worker (20), a runner (30), a plain renderer (60)
  // and the dev server (61) are not renders themselves.
  assert.deepEqual(busy, [10, 11, 21, 31, 50]);
});

test("Remotion is another session's render only while its CLI renders or its compositor runs, never for naming the word", () => {
  // HAR-32, 2026-10-06: the bare `remotion` pattern reported a wrapper in a remotion-mock folder as a render.
  for (const command of [
    "node /x/node_modules/.bin/remotion render src/index.ts Comp out/a.mp4",
    "node /opt/homebrew/bin/npx remotion still src/index.ts RegistroDemo out/f30.png --frame=30",
    // The same npx once npm sets its process title: ps shows this, padded with the spaces left over.
    "npm exec remotion still src/index.ts RegistroDemo out/f30.png --frame=30    ",
    "/opt/homebrew/bin/node /x/node_modules/@remotion/cli/remotion-cli.js benchmark src/index.ts",
    '/x/node_modules/@remotion/compositor-darwin-arm64/remotion {"type":"x"}'
  ]) assert.equal(isHeavy(command), true, command);
  for (const command of [
    "node .cache/remotion-mock/slot-run.mts .cache/remotion-mock/all.sh",
    "tail -f /x/remotion-mock/progress.log",
    "vim remotion.config.ts",
    "node /x/node_modules/.bin/remotion studio",
    "node /x/node_modules/.bin/remotion compositions src/index.ts",
    "npm exec remotion bundle src/index.ts"
  ]) assert.equal(isHeavy(command), false, command);
});

test("Blender is another session's render only when its executable runs in the background (-b or --background)", () => {
  // HAR-32: a 511 s Blender render in a Codex session went unseen by the machine check.
  for (const command of [
    "/Applications/Blender.app/Contents/MacOS/Blender -b scene.blend -a",
    "/x/.cache/birthday-balloons/runtime/Blender.app/Contents/MacOS/Blender --background --factory-startup --python scripts/blender/birthday_balloons.py -- --output-dir out/review/2026-10-06-birthday-balloons",
    "blender -b scene.blend -f 1"
  ]) assert.equal(isHeavy(command), true, command);
  for (const command of [
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/Applications/Blender.app/Contents/MacOS/Blender scene.blend",
    // The Quick Look thumbnailer that ships inside Blender.app.
    "/Volumes/Sandisk/Applications/Blender.app/Contents/PlugIns/blender-thumbnailer.appex/Contents/MacOS/blender-thumbnailer -BSServiceDomains {}",
    // A command that only names it, like a request to an agent.
    "claude -p render it with blender -b scene.blend -a"
  ]) assert.equal(isHeavy(command), false, command);
});

test("ffmpeg is another session's render only while it writes many frames or encodes video, never for one frame or for naming it", () => {
  // HAR-32: the machine check counted ffmpeg from 2026-10-08, and this fallback did not.
  for (const command of [
    "ffmpeg -hide_banner -ss 0 -i in.mp4 -fps_mode passthrough -c:v png -f image2 -atomic_writing 1 out/frames/%06d.png",
    "ffmpeg -i in.mp4 -vf fps=2 -f image2 -strftime 1 out/%H%M%S.png",
    "ffmpeg -i in.webm frames/%06d.png",
    "ffmpeg -i in.mp4 -frames:v 100 out/%03d.png",
    "/opt/homebrew/bin/ffmpeg -y -i in.mov -c:v libx264 -crf 16 -pix_fmt yuv420p out.mp4",
    "ffmpeg -i in.mov -c:v libx265 out.mp4",
    "ffmpeg -i in.mov -c:v libvpx out.webm",
    "ffmpeg -i in.mov -c:v libvpx-vp9 -b:v 0 -crf 30 out.webm",
    "ffmpeg -i in.mov -c:v libaom-av1 out.mkv",
    "ffmpeg -i in.mov -c:v libsvtav1 out.mkv",
    "ffmpeg -i in.mov -c:v hevc_videotoolbox -tag:v hvc1 out.mp4",
    "/opt/homebrew/bin/ffmpeg -i in.mov -c:v prores_ks -profile:v 4 out.mov"
  ]) assert.equal(isHeavy(command), true, command);
  for (const command of [
    "/opt/homebrew/bin/ffmpeg -ss 3 -i in.mp4 -frames:v 1 -f image2 frame.png",
    "ffmpeg -c:v libvpx-vp9 -i stinger.webm -frames:v 1 -pix_fmt rgba a.png",
    "ffmpeg -i in.mp4 -vframes 1 -f image2 thumb.png",
    "ffmpeg -i in.mp4 -c:a aac out.m4a",
    "/opt/homebrew/bin/ffprobe -v error -show_streams out.mp4",
    "/usr/local/bin/myffmpeg -c:v libx264 out.mp4",
    "claude -p run ffmpeg -i a.mp4 -c:v libx264 b.mp4"
  ]) assert.equal(isHeavy(command), false, command);
});

test("ugrep, caffeinate and a login shell only wrap a render: the render they start counts, they do not", () => {
  const wrappers = [
    // Claude Code's grep, as ps lists it.
    "ugrep -G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn npx remotion render",
    "/opt/homebrew/bin/ugrep -rn npx remotion still src",
    "caffeinate -i npx remotion render src/index.ts Comp out/a.mp4",
    "/usr/bin/caffeinate -dims node /x/node_modules/.bin/remotion render src/index.ts Comp out/a.mp4",
    "-zsh -c until ! pgrep -f 'Chrome.*--headless'; do sleep 10; done"
  ];
  for (const command of wrappers) assert.equal(isHeavy(command), false, command);
  // Each line names a render: run by a program that is no wrapper, every one would count.
  for (const command of wrappers) assert.equal(isHeavy(`/usr/local/bin/tool ${command}`), true, command);
  // A program whose name only starts like a wrapper is no wrapper.
  assert.equal(isHeavy("/usr/local/bin/caffeinated npx remotion render A"), true);
  const list = [
    {pid: 500, ppid: 1, command: "/usr/bin/caffeinate -i node /x/node_modules/.bin/remotion render src/index.ts Comp out/a.mp4"},
    {pid: 510, ppid: 500, command: "node /x/node_modules/.bin/remotion render src/index.ts Comp out/a.mp4"}
  ];
  assert.deepEqual(otherSessionsWork(list, [900]).map((item) => item.pid), [510]);
});

test("the heavy patterns and wrappers are the machine check's, string for string", async (t) => {
  // The fallback saw neither ffmpeg nor caffeinate long after the check did (HAR-32). Not machineCheckScript():
  // the test runner points MACHINE_CHECK at a missing file.
  const check = join(homedir(), "obsidian", "AI", "scripts", "maquina_livre.py");
  if (!existsSync(check)) return t.skip("no vault on this machine");
  const read = 'import json, sys; sys.path.insert(0, sys.argv[1]); import maquina_livre as m; print(json.dumps({"heavy": [p.pattern for p in m.PESADO], "wrappers": sorted(m.EMBRULHO)}))';
  const vault = JSON.parse(execFileSync("python3", ["-c", read, dirname(check)], {encoding: "utf8"}));
  assert.ok(vault.heavy.length > 0 && vault.wrappers.length > 0, `read nothing from the check: ${JSON.stringify(vault)}`);
  const fix = "edit PESADO and EMBRULHO in ~/obsidian/AI/scripts/maquina_livre.py first, then copy them to HEAVY_PATTERNS and WRAPPERS in scripts/lib/machine.mjs";
  assert.deepEqual(HEAVY_PATTERNS, vault.heavy, fix);
  assert.deepEqual([...WRAPPERS].sort(), vault.wrappers, fix);
});

test("the caller's ancestors, and a shell or pgrep that only mentions a pattern, are not another session's render", () => {
  // The check names a heavy pattern (Chrome.*--headless), so only the wrapper rule keeps 700 and 710 out.
  const check = "pgrep -fl 'Chrome.*--headless|remotion|dist/cli/index.js'";
  const list = [
    // An agent whose prompt names a render, the shell that chains the machine check before npm test, npm, the runner.
    {pid: 100, ppid: 1, command: '/opt/homebrew/bin/node /opt/homebrew/bin/codex exec "run node dist/cli/index.js render . --recipe listing"'},
    {pid: 200, ppid: 100, command: `/bin/zsh -c ${check}; npm test`},
    {pid: 300, ppid: 200, command: "npm test"},
    {pid: 900, ppid: 300, command: "/opt/homebrew/bin/node scripts/run-tests.mjs unit integration"},
    // Another session runs the same check before a typecheck.
    {pid: 700, ppid: 1, command: `-zsh -c ${check}; npm run typecheck`},
    {pid: 710, ppid: 700, command: "pgrep -fl Chrome.*--headless|remotion|dist/cli/index.js"},
    // Another session's render, started through sh by npm.
    {pid: 800, ppid: 1, command: "sh -c node dist/cli/index.js render . --recipe listing"},
    {pid: 810, ppid: 800, command: "/opt/homebrew/bin/node /work/se-windows/node_modules/se-widget-studio/dist/cli/index.js render . --recipe listing"}
  ];
  const busy = otherSessionsWork(list, [900]).map((item) => item.pid);
  assert.ok(!busy.includes(100), "the agent that started the runner is the caller's own");
  assert.ok(!busy.includes(700) && !busy.includes(710), "another session's machine check renders nothing");
  assert.deepEqual(busy, [810]);
});

test("the browser gate refuses below 3 GiB free, for orphans and for another session's render, which alone is worth waiting for, and passes otherwise", async () => {
  const quiet = [{pid: 900, ppid: 1, command: "/opt/homebrew/bin/node scripts/run-tests.mjs"}];
  // No usage readings: a real `ps -p 11` would read whatever runs as PID 11 on this machine.
  const gate = (options) => browserGate({root: ROOT, paths: ["/work"], ownRoots: [900], cwd, usage: async () => new Map(), machine: async () => null, ...options});
  assert.deepEqual(await gate({processes: quiet, free: async () => 3 * 1024 ** 3}), {ok: true});
  const low = await gate({processes: quiet, free: async () => 3 * 1024 ** 3 - 1});
  assert.equal(low.ok, false);
  assert.match(low.reason, /only 2\.9 GiB free on the volume of \/work; browser suites need 3\.0 GiB/);
  assert.equal(low.wait, undefined, "waiting does not free the disk");
  const orphaned = await gate({processes: [...quiet, ...processes()], free: async () => 10 * 1024 ** 3});
  assert.match(orphaned.reason, /orphan process\(es\) \(PID 10, 20, 21\); run npm run kill-stale/);
  assert.equal(orphaned.wait, undefined, "waiting does not end this checkout's own orphan");
  const busy = await gate({processes: [...quiet, processes()[1]], free: async () => 10 * 1024 ** 3});
  assert.match(busy.reason, /another session is rendering: PID 11 /);
  assert.equal(busy.wait, true);
});

const HEADLESS = `${CHROME} --headless=new --dump-dom file:///work/page.html`;
const RENDERER = `${CHROME} Helper (Renderer) --type=renderer`;

/** Another session's renders, each with what ps reads of it (`use`) and its working directory. */
function stalledScene() {
  const rows = [
    // The review-notes test's Chrome of 2026-10-13: 2 h 10 min, 112 KiB, no CPU, with a big renderer child.
    {pid: 100, ppid: 1, command: HEADLESS, use: {rssKib: 112, ageS: 7800, pcpu: 0, cpuS: 0.4}, cwd: "/work/review-notes"},
    {pid: 101, ppid: 100, command: RENDERER, use: {rssKib: 900_000, ageS: 7800, pcpu: 0, cpuS: 0}},
    // Just old and small enough: exactly 30 min, and 1 KiB under 50 MiB.
    {pid: 110, ppid: 1, command: HEADLESS, use: {rssKib: 300, ageS: 1800, pcpu: 0, cpuS: 0}, cwd: "/work/a"},
    {pid: 120, ppid: 1, command: HEADLESS, use: {rssKib: 51_199, ageS: 7200, pcpu: 0, cpuS: 0}, cwd: "/work/b"},
    // Still renders: a second short of 30 min, and exactly 50 MiB.
    {pid: 200, ppid: 1, command: HEADLESS, use: {rssKib: 300, ageS: 1799, pcpu: 0, cpuS: 0}, cwd: "/work/c"},
    {pid: 210, ppid: 1, command: HEADLESS, use: {rssKib: 51_200, ageS: 7200, pcpu: 0, cpuS: 0}, cwd: "/work/d"},
    // Its family uses exactly 1% of CPU now, half of it in a child.
    {pid: 220, ppid: 1, command: HEADLESS, use: {rssKib: 300, ageS: 7200, pcpu: 0.5, cpuS: 0}, cwd: "/work/e"},
    {pid: 221, ppid: 220, command: RENDERER, use: {rssKib: 300, ageS: 7200, pcpu: 0.5, cpuS: 0}},
    // Its family spent exactly 1% of its age on CPU (36 s in 1 h), all in a child.
    {pid: 230, ppid: 1, command: HEADLESS, use: {rssKib: 300, ageS: 3600, pcpu: 0, cpuS: 0}, cwd: "/work/f"},
    {pid: 231, ppid: 230, command: RENDERER, use: {rssKib: 300, ageS: 3600, pcpu: 0, cpuS: 36}},
    // A light, long `nohup ffmpeg -f image2` that works: little CPU now, 300 s of it in 2 h.
    {pid: 240, ppid: 1, command: "/opt/homebrew/bin/ffmpeg -i in.mp4 -f image2 out/%06d.png", use: {rssKib: 20_000, ageS: 7200, pcpu: 0.4, cpuS: 300}, cwd: "/work/g"},
    // Its session is alive; its working directory was not read; ps no longer lists it.
    {pid: 250, ppid: 4242, command: HEADLESS, use: {rssKib: 300, ageS: 7200, pcpu: 0, cpuS: 0}, cwd: "/work/h"},
    {pid: 260, ppid: 1, command: HEADLESS, use: {rssKib: 300, ageS: 7200, pcpu: 0, cpuS: 0}},
    {pid: 270, ppid: 1, command: HEADLESS, cwd: "/work/i"}
  ];
  const asked = [];
  return {
    asked,
    list: rows.map(({pid, ppid, command}) => ({pid, ppid, command})),
    usage: async (pids) => { asked.push(pids); return new Map(rows.filter((row) => row.use && pids.includes(row.pid)).map((row) => [row.pid, row.use])); },
    cwd: async (pid) => rows.find((row) => row.pid === pid)?.cwd
  };
}

test("a PPID-1 render 30 min or older, below 50 MiB, whose family has no CPU now nor in its life, is stalled; any other still renders", async () => {
  const {asked, list, usage, cwd} = stalledScene();
  const {busy, stalled} = await splitStalled(otherSessionsWork(list, [900]), list, {usage, cwd});
  assert.deepEqual(stalled.map((item) => item.pid), [100, 110, 120]);
  assert.deepEqual(busy.map((item) => item.pid), [200, 210, 220, 230, 240, 250, 260, 270]);
  // The memory is the render's own, not its renderer's; the CPU is the family's.
  assert.deepEqual(stalled[0], {pid: 100, ppid: 1, command: HEADLESS, rssKib: 112, ageS: 7800, pcpu: 0, cpuS: 0.4, cwd: "/work/review-notes"});
  // One ps call, for the PPID-1 renders and their families only.
  assert.deepEqual(asked, [[100, 101, 110, 120, 200, 210, 220, 221, 230, 231, 240, 260, 270]]);
});

test("the browser gate passes a stalled render with a warning and its `! kill` line, and still refuses for a live one", async () => {
  const {list, usage, cwd} = stalledScene();
  const quiet = {pid: 900, ppid: 1, command: "/opt/homebrew/bin/node scripts/run-tests.mjs"};
  const gate = (pids) => browserGate({root: ROOT, paths: ["/work"], ownRoots: [900], processes: [quiet, ...list.filter((item) => pids.includes(item.pid))], free: async () => 10 * 1024 ** 3, cwd, usage, machine: async () => null});
  const warning = "orphan render (PPID 1) stalled for 2 h, without CPU (0% now, 0.4 s of CPU in its life), 112 KiB; it does not count as a render: " +
    "PID 100 (/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --dump-dom file:///work/page.html), in /work/review-notes; you end it: `! kill 100`";
  assert.deepEqual(await gate([100, 101]), {ok: true, warnings: [warning]});
  assert.deepEqual(await gate([100, 101, 200]), {ok: false, wait: true, reason: `another session is rendering: PID 200 ${HEADLESS}`, warnings: [warning]});
  assert.deepEqual(await gate([200]), {ok: false, wait: true, reason: `another session is rendering: PID 200 ${HEADLESS}`});
});

test("ps usage parses the macOS and Linux times and a decimal comma, and skips what it cannot read", () => {
  const usage = parseUsage([
    "63153    112   02:10:05   0.0   0:00.41",
    "    7   2048 1-02:03:04  12,5  75:12,50",
    "    8    100      05:00   0.3  00:01:23",
    "  PID    RSS    ELAPSED  %CPU   TIME",
    ""
  ].join("\n"));
  assert.deepEqual([...usage], [
    [63153, {rssKib: 112, ageS: 7805, pcpu: 0, cpuS: 0.41}],
    [7, {rssKib: 2048, ageS: 93_784, pcpu: 12.5, cpuS: 4512.5}],
    [8, {rssKib: 100, ageS: 300, pcpu: 0.3, cpuS: 83}]
  ]);
});

test("ps reads a live process's usage and leaves out one that is gone", {timeout: 30_000}, async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  t.after(() => child.kill("SIGKILL"));
  const gone = spawn(process.execPath, ["-e", ""], {stdio: "ignore"});
  await once(gone, "exit");
  assert.ok(child.pid > 1 && gone.pid > 1, `PIDs ${child.pid} and ${gone.pid}`);
  const usage = await readUsage([child.pid, gone.pid]);
  assert.deepEqual([...usage.keys()], [child.pid]);
  const own = usage.get(child.pid);
  assert.ok(own.rssKib > 0 && Number.isInteger(own.ageS) && own.ageS >= 0 && own.pcpu >= 0 && own.cpuS >= 0, JSON.stringify(own));
  assert.equal((await readUsage([gone.pid])).size, 0);
  child.kill("SIGKILL");
  await once(child, "exit");
});

test("kill-stale kills a real marked orphan of this checkout and leaves one from another folder alone", {timeout: 30_000}, async (t) => {
  const ours = await realpath(await mkdtemp(join(tmpdir(), "sws-orphan-ours-")));
  const theirs = await realpath(await mkdtemp(join(tmpdir(), "sws-orphan-theirs-")));
  const pids = [];
  t.after(async () => {
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {}
    await rm(ours, {recursive: true, force: true});
    await rm(theirs, {recursive: true, force: true});
  });
  // A launcher that starts a marked, detached child and exits: the child is left with PPID 1, like a
  // Chrome whose test process was killed.
  const orphanIn = async (folder, label) => {
    const launcher = spawn(process.execPath, ["-e", `const {spawn} = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "${BROWSER_MARKER}=${label}"], {detached: true, stdio: "ignore"});
process.stdout.write(String(child.pid)); child.unref();`], {cwd: folder, stdio: ["ignore", "pipe", "inherit"]});
    let output = "";
    launcher.stdout.on("data", (chunk) => { output += chunk; });
    await new Promise((done) => launcher.once("close", done));
    const pid = Number(output);
    pids.push(pid);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await listProcesses()).find((item) => item.pid === pid)?.ppid === 1) return pid;
      await sleep(100);
    }
    assert.fail(`PID ${pid} never became an orphan`);
  };
  const ourPid = await orphanIn(ours, "orphan-test-ours");
  const theirPid = await orphanIn(theirs, "orphan-test-theirs");
  const lines = [];
  const {killed} = await killStale(ours, (line) => lines.push(line));
  assert.deepEqual(killed.map((item) => item.pid), [ourPid]);
  assert.match(lines.join("\n"), new RegExp(`Killed PID ${ourPid}: `));
  for (let attempt = 0; attempt < 50 && (await listProcesses()).some((item) => item.pid === ourPid); attempt += 1) await sleep(100);
  assert.equal((await listProcesses()).some((item) => item.pid === ourPid), false, "our orphan is gone");
  assert.equal((await listProcesses()).find((item) => item.pid === theirPid)?.ppid, 1, "the other folder's orphan still runs");
});

/** A stand-in for maquina_livre.py that answers `answer` with `exit`; a busy answer also lists its argv. */
async function fakeCheck(t, answer, exit) {
  const folder = await mkdtemp(join(tmpdir(), "sws-machine-check-"));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const script = join(folder, "maquina_livre.py");
  await writeFile(script, [
    "import json, sys",
    `answer = json.loads(${JSON.stringify(JSON.stringify(answer))})`,
    "if not answer['livre']: answer['reasons'].append('argv ' + ' '.join(sys.argv[1:]))",
    "print(json.dumps(answer))",
    `sys.exit(${exit})`
  ].join("\n"));
  return script;
}

test("the machine check answers busy (exit 3) with its reasons for the caller's family, free (exit 0) without, and null when missing or silent", async (t) => {
  const busy = await fakeCheck(t, {livre: false, motivos: ["o jogo está aberto"], reasons: ["the game (Client-Mac-Shipping) is open"]}, 3);
  assert.deepEqual(await machineVerdict([900, 901], busy), {free: false, reasons: ["the game (Client-Mac-Shipping) is open", "argv --json --familia 900 --familia 901"]});
  assert.deepEqual(await machineVerdict([900], await fakeCheck(t, {livre: true, motivos: [], reasons: []}, 0)), {free: true, reasons: []});
  assert.equal(await machineVerdict([900], join(tmpdir(), "sws-no-such-folder", "maquina_livre.py")), null);
  const silent = await fakeCheck(t, {livre: true, reasons: []}, 0);
  await writeFile(silent, "raise SystemExit(3)\n");
  assert.equal(await machineVerdict([900], silent), null);
  assert.equal(parseVerdict('{"livre": "no", "reasons": []}'), null);
});

test("the browser gate follows the machine check, and the process list only where the check is missing", async () => {
  const quiet = [{pid: 900, ppid: 1, command: "/opt/homebrew/bin/node scripts/run-tests.mjs"}];
  const rendering = [...quiet, processes()[1]];
  const asked = [];
  const gate = (machine) => browserGate({root: ROOT, paths: ["/work"], ownRoots: [900], cwd, usage: async () => new Map(), processes: rendering, free: async () => 10 * 1024 ** 3, machine: async (roots) => { asked.push(roots); return machine; }});
  assert.deepEqual(await gate({free: true, reasons: []}), {ok: true}, "the check already looked at the renders");
  assert.deepEqual(await gate({free: false, reasons: ["12% of memory free, below 30%", "the game (Client-Mac-Shipping) is open"]}), {ok: false, wait: true, reason: "the machine check says to wait: 12% of memory free, below 30%; the game (Client-Mac-Shipping) is open"});
  assert.match((await gate(null)).reason, /another session is rendering: PID 11 /);
  assert.deepEqual(asked, [[900], [900], [900]], "the check is asked for the runner's family");
});

test("wait-free waits for what the machine check says, and exits 0 once it says free", {timeout: 60_000}, async (t) => {
  const waitFree = fileURLToPath(new URL("../../scripts/wait-free.mjs", import.meta.url));
  const run = async (script) => {
    const child = spawn(process.execPath, [waitFree, "--timeout-min", "0", "--interval-s", "0"], {cwd: fileURLToPath(new URL("../../", import.meta.url)), env: {...process.env, MACHINE_CHECK: script}, stdio: ["ignore", "pipe", "pipe"]});
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "exit");
    return {code, output};
  };
  const busy = await run(await fakeCheck(t, {livre: false, motivos: [], reasons: ["the game (Client-Mac-Shipping) is open"]}, 3));
  assert.equal(busy.code, 1, busy.output);
  assert.match(busy.output, /Still busy after 0 min: the game \(Client-Mac-Shipping\) is open/);
  const free = await run(await fakeCheck(t, {livre: true, motivos: [], reasons: []}, 0));
  assert.equal(free.code, 0, free.output);
  assert.match(free.output, /^Machine free after 0 check\(s\)\.$/m);
});

test("wait-free waits in the render slot queue with a ticket, which a chain that cedes lets in between two of its steps", {timeout: 90_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-wait-free-chain-"));
  const log = join(root, "steps.log");
  const {RENDER_SLOT_HELD: _held, ...rest} = process.env;
  const env = {...rest, RENDER_SLOT_DIR: join(root, "slot"), RENDER_SLOT_CHECK: "off", MACHINE_CHECK: await slotCheck(root)};
  const status = () => JSON.parse(execFileSync(process.execPath, [RENDER_SLOT, "status", "--json"], {env, encoding: "utf8"}));
  const until = async (condition, ms) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) if (await condition()) return true;
    return condition();
  };
  // A step of the chain holds the slot until the test has seen the waiter's ticket in the queue.
  let gate = true;
  const chain = cedingChain({env, log, gate: () => gate});
  let waiter;
  try {
    assert.ok(await until(() => status().holder?.command.startsWith("hold: chain-"), 20_000), "the chain holds the slot");
    waiter = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/wait-free.mjs", import.meta.url)), "--timeout-min", "0.5", "--interval-s", "1"], {cwd: fileURLToPath(new URL("../../", import.meta.url)), env, stdio: ["ignore", "pipe", "pipe"]});
    let output = "";
    waiter.stdout.on("data", (chunk) => { output += chunk; });
    waiter.stderr.on("data", (chunk) => { output += chunk; });
    const exited = once(waiter, "exit");
    // 2026-10-27: a wait-free that polled waited 22 min behind the vault's chain, and the queue named nobody (#15).
    const ticket = () => status().queue.find((waiting) => waiting.command === "vez: wait-free");
    assert.ok(await until(ticket, 20_000), `render-slot status lists the ticket of wait-free while the chain holds the slot: ${output}`);
    assert.equal(ticket().cede, false, "a product ticket, which goes ahead of the chain's");
    gate = false;
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.match(output, /^Machine free after \d+ check\(s\), at its turn in the render slot queue: start the render now/m);
    // The render that follows takes the slot that the chain leaves it, and the chain goes on after it.
    await productStep(env, log, "render");
    const render = () => steps(log).find((step) => step.who === "render");
    assert.ok(await until(() => steps(log).some((step) => step.who === "chain" && step.from > render().to), 20_000), "the chain takes the slot again after the render");
    const chainSteps = steps(log).filter((step) => step.who === "chain");
    assert.ok(chainSteps.some((step) => step.to < render().from), "a step of the chain held the slot before the render");
    assert.ok(chainSteps.every((step) => step.to < render().from || step.from > render().to), "no step of the chain overlaps the render");
  } finally {
    // SIGTERM, which takes its ticket out of the queue with it.
    if (waiter?.exitCode === null) { waiter.kill("SIGTERM"); await once(waiter, "exit"); }
    await chain.stop();
    await rm(root, {recursive: true, force: true});
  }
});
