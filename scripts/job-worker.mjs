import {readFile, writeFile, mkdir, stat, rename} from 'node:fs/promises';
import {resolve, relative, isAbsolute, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {renderRecipe, planRecipe, singleSceneRecipe} from '../dist/capture/renderer.js';
import {runScenarios, runBrowserSmoke} from '../dist/scenarios/runner.js';
import {assertSampleMediaPins} from '../dist/config/sample-media.js';
import {FontResolver, FONTS_MISSING_MAX_URLS, isFontsMissing} from '../dist/fonts/resolver.js';
import {acquireRenderSlot} from '../dist/shared/render-slot.js';
import {waitForMachine} from '../dist/shared/machine-check.js';

// Trusted process entry point. Input is data; no submitted Node module is imported.
// argv: <input.json> <pass>. Everything else derives from the input's directory, so the host never
// relocates more paths: fonts/lock-<pass>.json and fonts/objects/ (the Google Fonts package),
// output/pass-<pass>/ (a fresh output root per pass), and result-<pass>.json.
const [inputPath, passArgument] = process.argv.slice(2);
const pass = Number(passArgument);
if (!inputPath || !Number.isSafeInteger(pass) || pass < 1 || pass > 99) throw new Error('Worker input path and pass number are required.');
const jobDirectory = dirname(inputPath);
const resultPath = resolve(jobDirectory, `result-${pass}.json`);
const {job, project: inputProject, sampleMedia} = JSON.parse(await readFile(inputPath, 'utf8'));

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

// One worker per pass. A retried workflow step may start the same pass twice; the second worker
// waits for the first one's result instead of exiting without one, which would fail the job.
try {
  await writeFile(resolve(jobDirectory, `pass-${pass}.lock`), String(process.pid), {flag: 'wx'});
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
  const deadline = Date.now() + Number(process.env.STUDIO_PASS_WAIT_MS ?? 10 * 60_000);
  while (!(await exists(resultPath))) {
    if (Date.now() > deadline) throw new Error(`Another worker holds pass ${pass} and wrote no result in time.`);
    await new Promise(done => setTimeout(done, 500));
  }
  process.exit(0);
}

// The local Studio sets STUDIO_EXECUTION=local; a Sandbox worker gets no such variable and keeps the hosted limits.
const local = process.env.STUDIO_EXECUTION === 'local';
const limits = local ? {file: 512 * 1024 * 1024, job: 1024 * 1024 * 1024} : {file: 100 * 1024 * 1024, job: 250 * 1024 * 1024};
const project = {...inputProject, outputRoot: resolve(inputProject.outputRoot, `pass-${pass}`)};
const result = {ok: false, artifacts: [], progress: '', error: undefined, pass};
const needsFonts = urls => { result.needsFonts = urls.slice(0, FONTS_MISSING_MAX_URLS); result.progress = `Fetching Google Fonts (pass ${pass + 1}).`; };
try {
  // On the owner's machine a job is one more heavy render: it waits for the machine-wide slot like the CLI
  // does, and holds it until this process exits. Holding it, it waits while the machine check every repo
  // shares says busy (the game, memory, swap, disk), and each line of that wait is also a stdout line
  // {"progress": …}, which the host shows on the job (lib/jobs.ts). A job has two hours from its creation,
  // so it waits 30 minutes at most for the two together, never the CLI's 4 hours: past its life it would
  // render for a job already failed.
  if (local) {
    const waitStarted = Date.now();
    const waitLimitMs = 30 * 60_000;
    const log = message => process.stderr.write(`${message}\n`);
    await acquireRenderSlot({command: `studio ${job.kind} job ${job.id} pass ${pass}`, waitLimitMs, log});
    await waitForMachine({startedAt: waitStarted, waitLimitMs, log: message => { log(message); process.stdout.write(`${JSON.stringify({progress: message})}\n`); }});
  }
  const fonts = await FontResolver.load(resolve(jobDirectory, 'fonts'), pass);
  // Samples the revision pinned must still have identical bytes in this build (append-only catalog).
  await assertSampleMediaPins(sampleMedia);
  await mkdir(project.outputRoot, {recursive: true});
  const artifactPaths = [];
  if (job.kind === 'test') {
    // Smoke and scenarios share one font package, so one pass collects the misses of both.
    let smoke;
    let scenarios = {results: []};
    try { smoke = await runBrowserSmoke(project, {fonts}); } catch (error) { if (!isFontsMissing(error)) throw error; }
    try { if (project.scenarios.length) scenarios = await runScenarios(project, {...(job.selection === 'all' ? {} : {scenarioIds: [job.selection]}), fonts}); }
    catch (error) { if (!isFontsMissing(error)) throw error; }
    if (fonts.hasMissing()) {
      needsFonts(fonts.missing());
    } else {
      // The test report carries the same font account as a render manifest.
      const report = {schemaVersion: 1, revisionId: job.revisionId, simulationOnly: true, fonts: fonts.report(), smoke, scenarios: scenarios.results};
      const reportPath = resolve(project.outputRoot, 'test-report.json');
      await writeFile(reportPath, JSON.stringify(report, null, 2), {flag: 'wx'});
      artifactPaths.push(reportPath);
      result.ok = smoke.status === 'passed' && scenarios.results.every(item => item.status === 'passed');
      result.progress = result.ok ? 'Smoke and scenario checks passed.' : 'One or more browser checks failed. See the test report.';
      if (!result.ok) result.error = result.progress;
    }
  } else if (job.kind === 'render') {
    const configured = project.recipes.find(item => item.id === job.selection)?.value;
    const sceneId = job.selection.replace(/^(?:scene:|video:)/u, '');
    const scene = project.scenes.find(item => item.id === sceneId)?.value;
    const recipe = configured ?? (scene ? singleSceneRecipe(scene, {video: job.selection.startsWith('video:')}) : undefined);
    if (!recipe) throw new Error('Select an existing recipe or scene.');
    const video = recipe.outputs?.video;
    if (!local && video?.enabled && (video.durationMs > 15000 || video.fps > 30)) throw new Error('Video limit is 15 seconds at 30 FPS.');
    // Jobs never publish frames, so they are removed after each validated encode whatever the recipe says.
    // The Sandbox free space has not been measured yet, so the disk guard runs only in a local Studio.
    const options = {matrixLimit: 48, allowIntermediate: true, keepFrames: false, allowLowDisk: !local, outputRoot: project.outputRoot, fonts,
      ...(process.env.STUDIO_FFMPEG_PATH ? {ffmpegPath: process.env.STUDIO_FFMPEG_PATH} : {}),
      ...(process.env.STUDIO_FFPROBE_PATH ? {ffprobePath: process.env.STUDIO_FFPROBE_PATH} : {})};
    const plan = await planRecipe(project, recipe, options);
    if (plan.plan.variants.some(item => item.output.width > 4096 || item.output.height > 4096)) throw new Error('Output dimensions must not exceed 4096 pixels.');
    if (!local && video?.enabled && plan.plan.totalFrames > 900) throw new Error('A video job is limited to 900 total frames. Split the recipe.');
    let rendered;
    try { rendered = await renderRecipe(project, recipe, options); }
    catch (error) { if (!isFontsMissing(error)) throw error; needsFonts(error.urls); }
    if (rendered) {
      // Successful videos retain final media only; frames left by an unvalidated or intermediate encode are job-local and cleaned by the host.
      for (const file of rendered.artifacts) if (!file.includes('/frames/')) artifactPaths.push(file);
      if (rendered.status === 'intermediate') {
        const reportPath = resolve(project.outputRoot, 'intermediate.json');
        await writeFile(reportPath, JSON.stringify({status: 'intermediate', message: 'FFmpeg was not found. Install FFmpeg and ffprobe explicitly, then rerun. Use the local CLI with --allow-intermediate to retain the PNG frame sequence.', revisionId: job.revisionId}, null, 2), {flag: 'wx'});
        artifactPaths.push(reportPath);
      }
      result.ok = rendered.status === 'final';
      result.progress = result.ok ? 'Media rendered and validated.' : `Render status: ${rendered.status}. See the manifest; install missing media tools explicitly and rerun.`;
      if (!result.ok) result.error = result.progress;
    }
  } else throw new Error('Unknown job kind.');
  let total = 0;
  for (const file of artifactPaths) {
    const name = relative(project.outputRoot, file);
    if (!name || name.startsWith('..') || isAbsolute(name)) throw new Error('Artifact escaped the output directory.');
    const metadata = await stat(file);
    total += metadata.size;
    if (metadata.size > limits.file || total > limits.job) throw new Error('Artifact size limit exceeded.');
    const bytes = await readFile(file);
    result.artifacts.push({name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
  }
} catch (error) {
  // Keep a StudioError's code (for example OUTPUT_DISK_LOW) so the job failure can be matched to the docs.
  // The hint is left out: it names local CLI flags that a hosted job cannot pass.
  const code = typeof error?.code === 'string' && !String(error.message).startsWith(error.code) ? `${error.code}: ` : '';
  result.error = error instanceof Error ? `${code}${error.message}` : String(error);
  result.progress = 'Job failed.';
  delete result.needsFonts;
}
// The host decides on whether this file exists, so it appears whole or not at all.
await writeFile(`${resultPath}.tmp`, JSON.stringify(result));
await rename(`${resultPath}.tmp`, resultPath);
