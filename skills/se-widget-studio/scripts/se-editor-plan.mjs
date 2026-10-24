#!/usr/bin/env node
/**
 * Plans the update of a sold widget's overlay in the real StreamElements overlay editor
 * (references/se-editor-update.md): reads the widget's HTML, CSS, JS, and FIELDS at the commit the overlay has and at
 * the commit it moves to, writes the new files into a new folder for the browser tool's file upload, and prints the
 * JSON plan that `seEditor.use()` takes in the page.
 *
 * Each tab is expected by its SHA-256. FIELDS hash as parsed JSON (`JSON.stringify(JSON.parse(text))`), as the page
 * script does: StreamElements reformats FIELDS when it saves, while HTML, CSS, and JS come back byte for byte. The
 * plan's `labels` are the FIELDS labels that are new or changed, for the label check before Save.
 *
 * Usage: se-editor-plan.mjs --repo <widget repository> --from <commit> [--to <commit>] --out <new folder>
 * --to defaults to HEAD. --out must not exist; it is never replaced. Reads committed files only, never the working tree.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// The two layouts the Studio detects (src/config/load.ts), each tab with its file at the repository root.
export const LAYOUTS = [
  {html: 'widget.html', css: 'widget.css', js: 'widget.js', fields: 'widget.json'},
  {html: 'index.html', css: 'style.css', js: 'script.js', fields: 'fields.json'}
];
export const TABS = ['html', 'css', 'js', 'fields'];

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The hash the page script compares a tab by: FIELDS as parsed JSON, the others as the exact text. */
export function tabHash(tab, text) {
  return sha256(tab === 'fields' ? JSON.stringify(JSON.parse(text)) : text);
}

/** The FIELDS labels of `next` that `previous` does not have under the same key. */
export function changedLabels(previous, next) {
  const labels = [];
  for (const [key, field] of Object.entries(next)) {
    if (!field || typeof field.label !== 'string' || !field.label.trim()) continue;
    if (previous[key]?.label !== field.label && !labels.includes(field.label)) labels.push(field.label);
  }
  return labels;
}

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) {
    throw new Error(`git ${args.join(' ')}: ${String(error.stderr || error.message).trim()}`);
  }
}

function commit(repo, rev) {
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).toString().trim();
  } catch {
    throw new Error(`${rev} is not a commit of ${repo}.`);
  }
}

function layoutAt(repo, sha) {
  const names = new Set(git(repo, ['ls-tree', '--name-only', sha]).toString().split('\n'));
  const complete = LAYOUTS.filter((layout) => TABS.every((tab) => names.has(layout[tab])));
  if (complete.length !== 1) {
    throw new Error(`${sha.slice(0, 7)} has ${complete.length ? 'both' : 'neither'} widget.html/widget.css/widget.js/widget.json `
      + 'and index.html/style.css/script.js/fields.json at the repository root.');
  }
  return complete[0];
}

function text(repo, sha, file) {
  const bytes = git(repo, ['show', `${sha}:${file}`]);
  const decoded = bytes.toString('utf8');
  // The page reads uploads with File.text() and the editor holds strings: a BOM or invalid UTF-8 would not round-trip.
  if (decoded.charCodeAt(0) === 0xfeff) throw new Error(`${file} at ${sha.slice(0, 7)} starts with a byte order mark.`);
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new Error(`${file} at ${sha.slice(0, 7)} is not valid UTF-8.`);
  return decoded;
}

function parseFields(file, sha, source) {
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new Error(`${file} at ${sha.slice(0, 7)} is not a JSON object.`);
}

/** Writes the `to` files into `out` (a new folder) and returns the plan. */
export function plan({repo, from, to = 'HEAD', out}) {
  if (!repo || !from || !out) throw new Error('--repo, --from, and --out are required.');
  const root = resolve(repo);
  const old = commit(root, from);
  const next = commit(root, to);
  if (old === next) throw new Error(`--from and --to are the same commit, ${old.slice(0, 7)}.`);
  const layout = layoutAt(root, next);
  const previousLayout = layoutAt(root, old);
  if (TABS.some((tab) => previousLayout[tab] !== layout[tab])) throw new Error('The widget layout changed between the two commits.');

  const tabs = {};
  const sources = {};
  let fields;
  for (const tab of TABS) {
    const file = layout[tab];
    const before = text(root, old, file);
    sources[tab] = text(root, next, file);
    if (tab === 'fields') fields = [parseFields(file, old, before), parseFields(file, next, sources[tab])];
    tabs[tab] = {file, old: tabHash(tab, before), new: tabHash(tab, sources[tab])};
  }
  if (TABS.every((tab) => tabs[tab].old === tabs[tab].new)) {
    throw new Error(`No code tab changes between ${old.slice(0, 7)} and ${next.slice(0, 7)}.`);
  }
  const labels = changedLabels(...fields);

  const folder = resolve(out);
  mkdirSync(folder); // throws when it exists: never replaced
  const upload = TABS.map((tab) => {
    const path = join(folder, layout[tab]);
    writeFileSync(path, sources[tab], {flag: 'wx'});
    return path;
  });
  return {version: 1, from: old, to: next, tabs, labels, upload};
}

function argument(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  return value;
}

// Node resolves symlinks for the ESM entry point, so import.meta.url is the real path while argv[1] keeps the linked
// path an installed skill is invoked through (~/.claude/skills/se-widget-studio). Compare real paths.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('Usage: se-editor-plan.mjs --repo <widget repository> --from <commit> [--to <commit>] --out <new folder>\n'
      + 'Writes the --to commit\'s HTML, CSS, JS, and FIELDS into --out (a new folder) and prints the JSON plan for '
      + 'seEditor.use() in the StreamElements overlay editor. --to defaults to HEAD.');
    process.exit(args.length ? 0 : 2);
  }
  try {
    const result = plan({repo: argument(args, '--repo'), from: argument(args, '--from'), to: argument(args, '--to'), out: argument(args, '--out')});
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`se-editor-plan: ${error.message}`);
    process.exit(1);
  }
}
