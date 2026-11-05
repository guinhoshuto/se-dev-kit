// One line per finished suite, in one file every checkout of this repository shares, so a failure can be counted
// against the runs around it. The logs cannot do that: each checkout keeps only its last runs of any suite, and a
// removed worktree's logs land in the live checkout's .cache/<task>/test-logs/. On 2026-11-05 the live checkout's own
// .cache/test-logs held neither failure of #33, while 3 of the 42 integration logs under .cache/*/test-logs had a
// BROWSER_LAUNCH_TIMEOUT and 2 of the 30 that ran css-transition had read 247 at the change instant.
import {execFileSync} from 'node:child_process';
import {appendFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

const ERROR_LENGTH = 300;
const RETRY_LINE = /Chrome launch retried: [^\n]*/g;

/** The live checkout's .cache/test-history.jsonl, from any of its worktrees. TEST_HISTORY_FILE names another file, or `off`. */
export function historyFile(root, environment = process.env) {
  if (environment.TEST_HISTORY_FILE) return environment.TEST_HISTORY_FILE;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    return join(dirname(common), '.cache', 'test-history.jsonl');
  } catch {
    return join(root, '.cache', 'test-history.jsonl');
  }
}

/** The tests a suite's log lists as failing, as Node's spec reporter prints them: file, name, first line of the error. */
export function failedTests(text) {
  const section = text.split('✖ failing tests:')[1] ?? '';
  return [...section.matchAll(/^test at (.+?):\d+:\d+\n✖ (.+?) \([\d.]+ms\)[^\n]*\n[ \t]*([^\n]*)/gm)]
    .map(([, file, test, error]) => ({file, test, error: error.slice(0, ERROR_LENGTH)}));
}

/** The lines a suite's log holds for a Chrome launch that was started again (LAUNCH_RETRY_NOTE in src/capture/browser.ts). */
export const launchRetries = text => text.match(RETRY_LINE) ?? [];

export async function appendHistory(entry, file) {
  if (file === 'off') return;
  await mkdir(dirname(file), {recursive: true});
  await appendFile(file, `${JSON.stringify(entry)}\n`);
}

const day = at => at.slice(0, 10);

/** The count a person asks for: for each suite how its runs ended, and how many times each test failed. */
export function historyReport(text, name = 'The test history') {
  const entries = text.split('\n').flatMap(line => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      // A line a crash cut short is not worth losing the count over.
      return [];
    }
  });
  if (!entries.length) return `${name} holds no runs yet.`;
  const lines = [`${name}: ${entries.length} suite run(s) from ${day(entries[0].at)} to ${day(entries.at(-1).at)}.`];
  for (const suite of new Set(entries.map(entry => entry.suite))) {
    const runs = entries.filter(entry => entry.suite === suite);
    const count = status => runs.filter(entry => entry.status === status).length;
    const retried = runs.filter(entry => entry.launchRetries > 0).length;
    lines.push(`${suite}: ${runs.length} run(s), ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped${retried ? `; a Chrome launch retried in ${retried}` : ''}`);
    const failures = new Map();
    for (const entry of runs) {
      for (const failure of entry.failures ?? []) {
        const key = `${failure.file}: ${failure.test}`;
        failures.set(key, {times: (failures.get(key)?.times ?? 0) + 1, at: entry.at, error: failure.error});
      }
    }
    for (const [key, {times, at, error}] of [...failures].sort((a, b) => b[1].times - a[1].times)) lines.push(`  ${times}× ${key}; last on ${day(at)}: ${error}`);
  }
  return lines.join('\n');
}

export const readHistory = file => readFile(file, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
