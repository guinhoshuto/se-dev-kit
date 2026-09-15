import {readFile, writeFile, mkdir, stat} from 'node:fs/promises';
import {resolve, relative, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {renderRecipe, planRecipe, singleSceneRecipe} from '../dist/capture/renderer.js';
import {runScenarios, runBrowserSmoke} from '../dist/scenarios/runner.js';

// Trusted process entry point. Input is data; no submitted Node module is imported.
const [inputPath, resultPath] = process.argv.slice(2);
if (!inputPath || !resultPath) throw new Error('Worker input and result paths are required.');
const {job, project} = JSON.parse(await readFile(inputPath, 'utf8'));
const result = {ok: false, artifacts: [], progress: '', error: undefined};
try {
  await mkdir(project.outputRoot, {recursive: true});
  const artifactPaths = [];
  if (job.kind === 'test') {
    const smoke = await runBrowserSmoke(project);
    const scenarios = project.scenarios.length ? await runScenarios(project, job.selection === 'all' ? {} : {scenarioIds: [job.selection]}) : {results: []};
    const report = {schemaVersion: 1, revisionId: job.revisionId, simulationOnly: true, smoke, scenarios: scenarios.results};
    const reportPath = resolve(project.outputRoot, 'test-report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2), {flag: 'wx'});
    artifactPaths.push(reportPath);
    result.ok = smoke.status === 'passed' && scenarios.results.every(item => item.status === 'passed');
    result.progress = result.ok ? 'Smoke and scenario checks passed.' : 'One or more browser checks failed. See the test report.';
    if (!result.ok) result.error = result.progress;
  } else if (job.kind === 'render') {
    const configured = project.recipes.find(item => item.id === job.selection)?.value;
    const sceneId = job.selection.replace(/^(?:scene:|video:)/u, '');
    const scene = project.scenes.find(item => item.id === sceneId)?.value;
    const recipe = configured ?? (scene ? singleSceneRecipe(scene, {video: job.selection.startsWith('video:')}) : undefined);
    if (!recipe) throw new Error('Select an existing recipe or scene.');
    const video = recipe.outputs?.video;
    if (video?.enabled && (video.durationMs > 15000 || video.fps > 30)) throw new Error('Video limit is 15 seconds at 30 FPS.');
    const options = {matrixLimit: 48, allowIntermediate: true,
      ...(process.env.STUDIO_FFMPEG_PATH ? {ffmpegPath: process.env.STUDIO_FFMPEG_PATH} : {}),
      ...(process.env.STUDIO_FFPROBE_PATH ? {ffprobePath: process.env.STUDIO_FFPROBE_PATH} : {})};
    const plan = await planRecipe(project, recipe, options);
    if (plan.plan.variants.some(item => item.output.width > 4096 || item.output.height > 4096)) throw new Error('Output dimensions must not exceed 4096 pixels.');
    if (video?.enabled && plan.plan.totalFrames > 900) throw new Error('A video job is limited to 900 total frames. Split the recipe.');
    const rendered = await renderRecipe(project, recipe, options);
    // Successful videos retain final media only; intermediate frames are job-local and cleaned by the host.
    for (const file of rendered.artifacts) if (!file.includes('/frames/')) artifactPaths.push(file);
    if (rendered.status === 'intermediate') {
      const reportPath = resolve(project.outputRoot, 'intermediate.json');
      await writeFile(reportPath, JSON.stringify({status: 'intermediate', message: 'FFmpeg was not found. Install FFmpeg and ffprobe explicitly, then rerun. Use the local CLI with --allow-intermediate to retain the PNG frame sequence.', revisionId: job.revisionId}, null, 2), {flag: 'wx'});
      artifactPaths.push(reportPath);
    }
    result.ok = rendered.status === 'final';
    result.progress = result.ok ? 'Media rendered and validated.' : `Render status: ${rendered.status}. See the manifest; install missing media tools explicitly and rerun.`;
    if (!result.ok) result.error = result.progress;
  } else throw new Error('Unknown job kind.');
  let total = 0;
  for (const file of artifactPaths) {
    const name = relative(project.outputRoot, file);
    if (!name || name.startsWith('..') || isAbsolute(name)) throw new Error('Artifact escaped the output directory.');
    const metadata = await stat(file);
    total += metadata.size;
    if (metadata.size > 100 * 1024 * 1024 || total > 250 * 1024 * 1024) throw new Error('Artifact size limit exceeded.');
    const bytes = await readFile(file);
    result.artifacts.push({name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  result.progress = 'Job failed.';
}
await writeFile(resultPath, JSON.stringify(result));
