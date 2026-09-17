#!/usr/bin/env node
/** Clone and verify an existing trusted renderer snapshot without downloading tools. */
import {Sandbox} from '@vercel/sandbox';

const args = process.argv.slice(2);
const ROOT = '/vercel/sandbox/studio';

function fail(message) {throw new Error(message);}
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) fail(`${name} requires a value.`);
  if (args.indexOf(name, index + 1) >= 0) fail(`${name} may only appear once.`);
  return args[index + 1];
}
function identity() {
  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!token) fail('VERCEL_OIDC_TOKEN is required. Pull a fresh project-scoped development identity before verification.');
  try {
    const parts = token.split('.');
    if (parts.length !== 3) fail('VERCEL_OIDC_TOKEN is not a JWT.');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (error) {
    fail(`Could not validate VERCEL_OIDC_TOKEN: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function run(sandbox, cmd, commandArgs) {
  const result = await sandbox.runCommand({cmd, args: commandArgs, cwd: ROOT, timeoutMs: 60_000});
  if (result.exitCode !== 0) fail(`${cmd} failed: ${(await result.stderr()).slice(-1500)}`);
  return (await result.stdout()).trim();
}

if (!args.includes('--allow-sandbox')) {
  console.error('Explicit verification only. This temporarily clones the selected snapshot and consumes Sandbox quota.\nUsage: node scripts/verify-sandbox-snapshot.mjs --allow-sandbox --snapshot-id <snapshot> --expected-team-id <team> --expected-project-id <project>');
  process.exit(1);
}

const snapshotId = option('--snapshot-id');
const expectedTeamId = option('--expected-team-id');
const expectedProjectId = option('--expected-project-id');
const claims = identity();
if (claims.owner_id !== expectedTeamId || claims.project_id !== expectedProjectId) fail('The Vercel identity does not match the explicitly selected team and project.');

const sandbox = await Sandbox.create({source: {type: 'snapshot', snapshotId}, networkPolicy: 'deny-all', timeout: 5 * 60_000, persistent: false, resources: {vcpus: 2}});
try {
  if (sandbox.sourceSnapshotId !== snapshotId) fail('The verification Sandbox did not start from the requested snapshot.');
  const metadata = JSON.parse(await run(sandbox, 'node', ['-e', `process.stdout.write(require('node:fs').readFileSync('${ROOT}/snapshot.json','utf8'))`]));
  if (metadata.target?.teamId !== expectedTeamId || metadata.target?.projectId !== expectedProjectId || metadata.networkPolicy !== 'deny-all') fail('Snapshot metadata does not match the expected target or network policy.');
  const ffmpeg = (await run(sandbox, `${ROOT}/tools/ffmpeg`, ['-version'])).split('\n')[0];
  const ffprobe = (await run(sandbox, `${ROOT}/tools/ffprobe`, ['-version'])).split('\n')[0];
  const browser = await run(sandbox, 'node', ['--input-type=module', '-e', `import {chromium} from 'playwright-core';const browser=await chromium.launch({executablePath:'${ROOT}/browser/chrome',headless:true});process.stdout.write(browser.version());await browser.close();`]);
  await run(sandbox, 'node', ['--input-type=module', '-e', `try{await fetch('https://example.com',{signal:AbortSignal.timeout(5000)});process.exit(7)}catch{process.stdout.write('blocked')}`]);
  console.log(JSON.stringify({status: 'passed', snapshotId, networkPolicy: 'deny-all', outboundNetwork: 'blocked', browser, ffmpeg, ffprobe}));
} finally {
  await sandbox.stop().catch(() => {});
}
