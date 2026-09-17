#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Sandbox} from '@vercel/sandbox';

const PLAYWRIGHT_VERSION = '1.54.2';
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const ROOT = '/vercel/sandbox/studio';
const args = process.argv.slice(2);

function fail(message) {throw new Error(message);}
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) fail(`${name} requires a value.`);
  if (args.indexOf(name, index + 1) >= 0) fail(`${name} may only appear once.`);
  return args[index + 1];
}
function progress(message) {process.stderr.write(`[sandbox-prepare] ${message}\n`);}
function decodeIdentity(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) fail('VERCEL_OIDC_TOKEN is not a JWT.');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (error) {
    fail(`Could not validate VERCEL_OIDC_TOKEN: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function binary(name) {
  const path = option(`--${name}`);
  if (!path.startsWith('/')) fail(`--${name} must be an absolute path.`);
  const content = await readFile(path);
  const elf64 = content.length >= 20 && content.subarray(0, 4).toString('hex') === '7f454c46' && content[4] === 2 && content[5] === 1;
  const x64 = elf64 && content.readUInt16LE(18) === 62;
  if (!x64 || content.length > MAX_BINARY_BYTES) fail(`${name} must be a Linux ELF64 x86-64 executable no larger than 256 MiB.`);
  return {content, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex')};
}

if (!args.includes('--allow-downloads')) {
  console.error('Explicit setup only. This creates a Vercel Sandbox, installs lockfile-pinned dependencies, Chromium, and Linux browser libraries. It consumes Sandbox quota. Supply reviewed Linux x64 FFmpeg and ffprobe binaries yourself.\nUsage: node scripts/sandbox-prepare.mjs --allow-downloads --expected-team-id <team> --expected-project-id <project> --ffmpeg /absolute/linux/ffmpeg --ffprobe /absolute/linux/ffprobe --report /private/output.json');
  process.exit(1);
}

const expectedTeamId = option('--expected-team-id');
const expectedProjectId = option('--expected-project-id');
const reportPath = resolve(option('--report'));
const oidc = process.env.VERCEL_OIDC_TOKEN;
if (!oidc) fail('VERCEL_OIDC_TOKEN is required. Pull a fresh project-scoped development identity before setup.');
const identity = decodeIdentity(oidc);
if (identity.owner_id !== expectedTeamId || identity.project_id !== expectedProjectId) fail('The Vercel identity does not match the explicitly selected team and project.');
if (!Number.isFinite(identity.exp) || identity.exp * 1000 < Date.now() + 30 * 60_000) fail('The Vercel identity expires too soon. Pull a fresh development identity and retry.');

progress('Validating local inputs and lockfile.');
const [ffmpeg,ffprobe,pkg,lock] = await Promise.all([
  binary('ffmpeg'), binary('ffprobe'), readFile(new URL('../package.json', import.meta.url)), readFile(new URL('../package-lock.json', import.meta.url))
]);
if (JSON.parse(pkg).dependencies['playwright-core'] !== PLAYWRIGHT_VERSION) fail('Review and update the snapshot recipe when changing Playwright.');

progress('Creating the project-scoped setup Sandbox.');
const sandbox = await Sandbox.create({runtime:'node22',timeout:20 * 60_000,persistent:false,snapshotExpiration:0,resources:{vcpus:2}});
try {
  async function run(label,cmd,commandArgs,options={}) {
    progress(label);
    const result = await sandbox.runCommand({cmd,args:commandArgs,cwd:ROOT,timeoutMs:options.timeoutMs ?? 5 * 60_000,...options});
    if (result.exitCode !== 0) fail(`${cmd} failed: ${(await result.stderr()).slice(-3000)}`);
    return result;
  }

  await sandbox.writeFiles([{path:`${ROOT}/package.json`,content:pkg},{path:`${ROOT}/package-lock.json`,content:lock}]);
  progress('Uploading reviewed FFmpeg.');
  await sandbox.writeFiles([{path:`${ROOT}/tools/ffmpeg`,content:ffmpeg.content}]);
  progress('Uploading reviewed ffprobe.');
  await sandbox.writeFiles([{path:`${ROOT}/tools/ffprobe`,content:ffprobe.content}]);
  await run('Installing Chromium system libraries.','dnf',['install','-y','nss','nspr','libxkbcommon','atk','at-spi2-atk','at-spi2-core','cups-libs','libdrm','libXcomposite','libXdamage','libXrandr','libXfixes','libXcursor','libXi','libXtst','libXScrnSaver','libXext','mesa-libgbm','mesa-libGL','mesa-libEGL','alsa-lib','pango','cairo','gtk3','dbus-libs','fontconfig','freetype'],{sudo:true,timeoutMs:8 * 60_000});
  await run('Installing lockfile-pinned production dependencies.','npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{timeoutMs:8 * 60_000});
  await run('Installing the pinned Chromium build.','node',['node_modules/playwright-core/cli.js','install','chromium'],{env:{PLAYWRIGHT_BROWSERS_PATH:`${ROOT}/browsers`},timeoutMs:8 * 60_000});
  await run('Marking media tools executable.','chmod',['755',`${ROOT}/tools/ffmpeg`,`${ROOT}/tools/ffprobe`]);
  const dependencies = await run('Checking Linux media dependencies.','sh',['-c',`ldd '${ROOT}/tools/ffmpeg' && ldd '${ROOT}/tools/ffprobe'`]);
  if ((await dependencies.stdout()).includes('not found')) fail('FFmpeg or ffprobe has an unavailable Linux runtime dependency.');
  await run('Launching Chromium and recording its version.','node',['--input-type=module','-e',`import {chromium} from 'playwright-core';import {mkdir,symlink,writeFile} from 'node:fs/promises';await mkdir('browser',{recursive:true});await symlink(chromium.executablePath(),'browser/chrome');const browser=await chromium.launch({executablePath:chromium.executablePath(),headless:true});const version=browser.version();await browser.close();await writeFile('browser/version.json',JSON.stringify({playwright:'${PLAYWRIGHT_VERSION}',chromium:version}));`],{env:{PLAYWRIGHT_BROWSERS_PATH:`${ROOT}/browsers`}});
  const ffmpegVersion = await run('Verifying FFmpeg.',`${ROOT}/tools/ffmpeg`,['-version']);
  const ffprobeVersion = await run('Verifying ffprobe.',`${ROOT}/tools/ffprobe`,['-version']);
  await run('Encoding a synthetic one-frame video.',`${ROOT}/tools/ffmpeg`,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=32x32:d=0.1','-frames:v','1','-c:v','libx264','-pix_fmt','yuv420p','-y',`${ROOT}/media-self-test.mp4`]);
  await run('Validating the synthetic video.',`${ROOT}/tools/ffprobe`,['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height','-of','json',`${ROOT}/media-self-test.mp4`]);
  await run('Removing setup-only media output.','rm',['-f',`${ROOT}/media-self-test.mp4`]);

  const metadata = {
    schemaVersion:1,createdAt:new Date().toISOString(),node:'22',playwright:PLAYWRIGHT_VERSION,
    lockSha256:createHash('sha256').update(lock).digest('hex'),
    ffmpeg:{bytes:ffmpeg.bytes,sha256:ffmpeg.sha256,version:(await ffmpegVersion.stdout()).split('\n')[0]},
    ffprobe:{bytes:ffprobe.bytes,sha256:ffprobe.sha256,version:(await ffprobeVersion.stdout()).split('\n')[0]},
    networkPolicy:'deny-all',target:{teamId:expectedTeamId,projectId:expectedProjectId}
  };
  await sandbox.writeFiles([{path:`${ROOT}/snapshot.json`,content:Buffer.from(JSON.stringify(metadata,null,2))}]);
  progress('Disabling outbound network access.');
  await sandbox.update({networkPolicy:'deny-all',persistent:false,snapshotExpiration:0});
  progress('Creating the non-expiring immutable snapshot.');
  const snapshot = await sandbox.snapshot({expiration:0});
  const report = {...metadata,snapshotId:snapshot.snapshotId,environment:{STUDIO_EXECUTION:'vercel',STUDIO_SANDBOX_SNAPSHOT_ID:snapshot.snapshotId}};
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:'created',snapshotId:snapshot.snapshotId,report:reportPath}));
} catch (error) {
  await sandbox.stop().catch(()=>{});
  throw error;
}
