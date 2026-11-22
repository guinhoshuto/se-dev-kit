#!/usr/bin/env node
/**
 * Commits the default Custom widget of the StreamElements overlay editor (the old code of a new layer, the event-list
 * example in the editor's public JS) to a new scratch repository, so that se-editor-plan.mjs can plan from it
 * (references/se-editor-update.md).
 *
 * The widget is found by its content, never by a name: its minified name changes between builds (`MZ` on 2026-11-13,
 * `aW` on 2026-11-21). It is the one object literal of the bundle with exactly the four keys `css`, `js`, `html`, and
 * `fields`, each a string literal, whose `js` has `onWidgetLoad` and whose `fields` is a JSON object. Only literals are
 * matched, and only literals are decoded, in an empty `node:vm` context: no code of the bundle ever runs.
 *
 * Usage: se-editor-default.mjs (--page <overlay editor link> | --bundle <saved bundle file>) --out <new folder>
 * --page fetches the editor page from https://streamelements.com and then its /overlay/assets/index-*.js bundle, with no
 * credentials and no redirects. --bundle reads a saved bundle instead. --out must not exist; it is never replaced. The
 * commit has a fixed author, committer, and date, so the same bundle gives the same commit.
 *
 * Then fetch the new commit into that repository and plan there, from the printed commit:
 *   git -C <out> fetch -q --no-tags <widget repository> <new commit>
 *   se-editor-plan.mjs --repo <out> --from <printed commit> --to <new commit> --out <scratchpad>/se-update-<new commit>
 * When no object matches, StreamElements changed the default widget: find it by its content in the bundle before
 * changing this script.
 */
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

export const HOST = 'streamelements.com';
export const USER_AGENT = 'se-widget-studio';
export const PAGE_LIMIT = 1024 * 1024;
export const BUNDLE_LIMIT = 32 * 1024 * 1024;
export const BUNDLE_PATH = /^\/overlay\/assets\/index-[A-Za-z0-9_-]+\.js$/;
export const FILES = {html: 'index.html', css: 'style.css', js: 'script.js', fields: 'fields.json'};
const IDENTITY = {name: 'SE Widget Studio', email: 'se-widget-studio@localhost', date: '2000-01-01T00:00:00Z'};

// A key is css, js, html, or fields, bare or quoted. A value is one string literal or a template literal without a
// `${` substitution (an escaped `\${` is text). Each alternation starts on a distinct character, so the scan is linear.
const KEY = /(?:css|js|html|fields|"(?:css|js|html|fields)"|'(?:css|js|html|fields)')/.source;
const LITERAL = /(?:"(?:[^"\\\r\n]|\\[\s\S])*"|'(?:[^'\\\r\n]|\\[\s\S])*'|`(?:[^`\\$]|\\[\s\S]|\$(?!\{))*`)/.source;
const PAIR = `${KEY}\\s*:\\s*${LITERAL}`;
export const CANDIDATE = new RegExp(`\\{\\s*${PAIR}(?:\\s*,\\s*${PAIR}){3}\\s*\\}`, 'g');

/** The bundle's `src` in the editor page's `<script src=".../overlay/assets/index-<hash>.js">`. */
export function bundlePath(html) {
  const found = /<script\b[^>]*?\ssrc\s*=\s*["']([^"']*\/overlay\/assets\/index-[A-Za-z0-9_-]+\.js)["']/i.exec(html);
  if (!found) throw new Error('The page has no <script src="/overlay/assets/index-<hash>.js">.');
  return found[1];
}

/** The literal an object text decodes to, in an empty context; undefined when it does not decode. */
function decode(text) {
  try {
    return vm.runInNewContext(`(${text})`, Object.create(null), {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}});
  } catch {
    return undefined;
  }
}

/** The default Custom widget in a bundle's source: {html, css, js, fields, object, offset}. */
export function findDefaultWidget(source, sourceLabel) {
  const kept = new Map();
  let checked = 0;
  for (const match of source.matchAll(CANDIDATE)) {
    checked += 1;
    const value = decode(match[0]);
    // Four pairs whose values are all strings under the four tab keys: the keys are distinct.
    if (!Object.keys(FILES).every((tab) => typeof value?.[tab] === 'string')) continue;
    if (!value.js.includes('onWidgetLoad')) continue;
    let fields;
    try {
      fields = JSON.parse(value.fields);
    } catch {
      continue;
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    const key = JSON.stringify([value.html, value.css, value.js, value.fields]);
    if (kept.has(key)) continue;
    const name = /([A-Za-z_$][\w$]*)\s*=\s*$/.exec(source.slice(Math.max(0, match.index - 64), match.index));
    kept.set(key, {html: value.html, css: value.css, js: value.js, fields: value.fields, object: name ? name[1] : null, offset: match.index});
  }
  if (kept.size === 0) {
    throw new Error(`No object literal with string literal keys css, js, html, and fields whose js has onWidgetLoad in ${sourceLabel} (checked ${checked} objects with those four keys).`);
  }
  if (kept.size > 1) {
    const offsets = [...kept.values()].map((widget) => widget.offset).join(', ');
    throw new Error(`${kept.size} different default widgets in ${sourceLabel}, at offsets ${offsets}.`);
  }
  return [...kept.values()][0];
}

function git(repo, args, env) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) {
    throw new Error(`git ${args.join(' ')}: ${String(error.stderr || error.message).trim()}`);
  }
}

/** Commits the widget's four tabs, byte for byte, to a new repository at `out`; returns the commit. */
export function commitWidget(widget, out, bundleName) {
  try {
    mkdirSync(out); // throws when it exists: never replaced
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${out} already exists; --out must be a new folder.`);
    throw error;
  }
  const files = {'index.html': widget.html, 'style.css': widget.css, 'script.js': widget.js, 'fields.json': widget.fields};
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_AUTHOR_DATE: IDENTITY.date,
    GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email, GIT_COMMITTER_DATE: IDENTITY.date
  };
  git(out, ['-c', 'init.defaultBranch=main', 'init', '-q'], env);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text, 'utf8');
  git(out, ['-c', 'core.autocrlf=false', 'add', '--', ...Object.keys(files)], env);
  git(out, [
    '-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false',
    'commit', '-q', '--no-verify', '-m', `Default Custom widget from ${bundleName}`
  ], env);
  return git(out, ['rev-parse', 'HEAD'], env).toString().trim();
}

/** The body of a 2xx answer, read up to `limit` bytes. */
async function fetchText(url, limit, what) {
  const response = await fetch(url, {redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30_000), headers: {'user-agent': USER_AGENT}});
  if (!response.ok) throw new Error(`The ${what} ${url} answered ${response.status}.`);
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error(`The ${what} ${url} is larger than ${limit} bytes.`);
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The bundle's URL, resolved against the page's origin, refused unless it is that origin's /overlay/assets/index-<hash>.js. */
export function bundleLink(src, page) {
  const origin = new URL(page).origin;
  const url = new URL(src, origin);
  if (url.origin !== origin || !BUNDLE_PATH.test(url.pathname) || url.search || url.hash) {
    throw new Error(`The page's bundle ${url.href} is not ${origin}/overlay/assets/index-<hash>.js.`);
  }
  return url;
}

/** The editor page's URL, refused unless it is https on streamelements.com. */
export function pageUrl(page) {
  let url;
  try {
    url = new URL(page);
  } catch {
    throw new Error(`--page ${page} is not a URL.`);
  }
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password) {
    throw new Error(`--page must be an https://${HOST}/ link, not ${page}.`);
  }
  return url;
}

/** Finds the default widget in --bundle or --page and commits it to --out. */
export async function defaultWidget({page, bundle, out} = {}) {
  if (Boolean(page) === Boolean(bundle)) throw new Error('Give exactly one of --page and --bundle.');
  if (!out) throw new Error('--out is required.');
  let source;
  let label;
  let name;
  if (page) {
    const url = pageUrl(page);
    const bundleUrl = bundleLink(bundlePath(await fetchText(url, PAGE_LIMIT, 'page')), url);
    source = await fetchText(bundleUrl, BUNDLE_LIMIT, 'bundle');
    label = bundleUrl.href;
    name = basename(bundleUrl.pathname);
  } else {
    label = resolve(bundle);
    source = readFileSync(label, 'utf8');
    name = basename(label);
  }
  const widget = findDefaultWidget(source, label);
  const repo = resolve(out);
  const commit = commitWidget(widget, repo, name);
  return {repo, commit, bundle: label, object: widget.object, fields: Object.keys(JSON.parse(widget.fields))};
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
    console.log('Usage: se-editor-default.mjs (--page <overlay editor link> | --bundle <saved bundle file>) --out <new folder>\n'
      + 'Finds the default Custom widget of the StreamElements overlay editor by its content, commits its HTML, CSS, JS, '
      + 'and FIELDS to a new repository at --out, and prints that commit and the widget\'s field ids. --page fetches the '
      + 'editor page and its bundle from https://streamelements.com. --bundle reads a saved bundle instead. --out must not exist.\n'
      + 'Then: git -C <out> fetch -q --no-tags <widget repository> <new commit>\n'
      + '      se-editor-plan.mjs --repo <out> --from <printed commit> --to <new commit> --out <scratchpad>/se-update-<new commit>\n'
      + 'When no object matches, StreamElements changed the default widget: find it by its content in the bundle before changing this script.');
    process.exit(args.length ? 0 : 2);
  }
  try {
    const result = await defaultWidget({page: argument(args, '--page'), bundle: argument(args, '--bundle'), out: argument(args, '--out')});
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`se-editor-default: ${error.message}`);
    process.exit(1);
  }
}
