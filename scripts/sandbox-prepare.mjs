import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Sandbox} from '@vercel/sandbox';

const args = process.argv.slice(2);
if (!args.includes('--allow-downloads')) {
  console.error('Explicit setup only. This creates a Vercel Sandbox, installs locked npm dependencies, Chromium 1.54.2 browser binaries and Linux browser libraries. It consumes Sandbox quota. Supply Linux x64 static FFmpeg and ffprobe binaries yourself.\nUsage: node scripts/sandbox-prepare.mjs --allow-downloads --ffmpeg /absolute/linux/ffmpeg --ffprobe /absolute/linux/ffprobe');
  process.exit(1);
}
function option(name) {return args[args.indexOf(name) + 1];}
async function binary(name) {
  const path = option(`--${name}`);
  if (!args.includes(`--${name}`) || !path?.startsWith('/')) throw new Error(`An absolute --${name} Linux binary path is required.`);
  const content = await readFile(path);
  if (content.length > 100 * 1024 * 1024 || content.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error(`${name} must be a Linux ELF executable smaller than 100 MB.`);
  return content;
}
const [ffmpeg, ffprobe, pkg, lock] = await Promise.all([binary('ffmpeg'), binary('ffprobe'), readFile(new URL('../package.json', import.meta.url)), readFile(new URL('../package-lock.json', import.meta.url))]);
if (JSON.parse(pkg).dependencies['playwright-core'] !== '1.54.2') throw new Error('Review and update the snapshot recipe when changing Playwright.');
const root = '/vercel/sandbox/studio';
const sandbox = await Sandbox.create({runtime: 'node22', timeout: 20 * 60_000, persistent: false, resources: {vcpus: 2}});
try {
  async function run(cmd, commandArgs, options = {}) {
    const result = await sandbox.runCommand({cmd, args: commandArgs, cwd: root, ...options});
    if (result.exitCode !== 0) throw new Error(`${cmd} failed: ${(await result.stderr()).slice(-3000)}`);
    return result;
  }
  await sandbox.writeFiles([{path: `${root}/package.json`, content: pkg}, {path: `${root}/package-lock.json`, content: lock}, {path: `${root}/tools/ffmpeg`, content: ffmpeg}, {path: `${root}/tools/ffprobe`, content: ffprobe}]);
  await run('dnf', ['install', '-y', 'nss', 'atk', 'at-spi2-atk', 'cups-libs', 'libdrm', 'libXcomposite', 'libXdamage', 'libXrandr', 'mesa-libgbm', 'alsa-lib', 'pango', 'libXfixes'], {sudo: true});
  await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  await run('node', ['node_modules/playwright-core/cli.js', 'install', 'chromium'], {env: {PLAYWRIGHT_BROWSERS_PATH: `${root}/browsers`}});
  await run('chmod', ['755', `${root}/tools/ffmpeg`, `${root}/tools/ffprobe`]);
  await run('node', ['--input-type=module', '-e', `import {chromium} from 'playwright-core';import {mkdir,symlink,writeFile} from 'node:fs/promises';await mkdir('browser',{recursive:true});await symlink(chromium.executablePath(),'browser/chrome');const browser=await chromium.launch({executablePath:chromium.executablePath(),headless:true});const version=browser.version();await browser.close();await writeFile('browser/version.json',JSON.stringify({playwright:'1.54.2',chromium:version}));`], {env: {PLAYWRIGHT_BROWSERS_PATH: `${root}/browsers`}});
  const ffmpegVersion = await run(`${root}/tools/ffmpeg`, ['-version']);
  const ffprobeVersion = await run(`${root}/tools/ffprobe`, ['-version']);
  const metadata = {schemaVersion: 1, createdAt: new Date().toISOString(), lockSha256: createHash('sha256').update(lock).digest('hex'), playwright: '1.54.2', ffmpegSha256: createHash('sha256').update(ffmpeg).digest('hex'), ffprobeSha256: createHash('sha256').update(ffprobe).digest('hex'), ffmpegVersion: (await ffmpegVersion.stdout()).split('\n')[0], ffprobeVersion: (await ffprobeVersion.stdout()).split('\n')[0]};
  await sandbox.writeFiles([{path: `${root}/snapshot.json`, content: Buffer.from(JSON.stringify(metadata, null, 2))}]);
  await sandbox.update({networkPolicy: 'deny-all', persistent: false});
  const snapshot = await sandbox.snapshot({expiration: 0});
  console.log(JSON.stringify({...metadata, snapshotId: snapshot.snapshotId, environment: {STUDIO_EXECUTION: 'vercel', STUDIO_SANDBOX_SNAPSHOT_ID: snapshot.snapshotId}}, null, 2));
} catch (error) {
  await sandbox.stop().catch(() => {});
  throw error;
}
