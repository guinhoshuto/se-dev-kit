import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {CONFIG_FILE_NAME, loadProject} from "../../dist/config/load.js";
import {hasValidationErrors, validateProject} from "../../dist/validation/project.js";

const execFileAsync = promisify(execFile);

const HINT =
  "Runtime network is blocked: a widget that loads one of these fails the video render with VIDEO_RUNTIME_ERROR, even after the test run passed. Use a sws-sample: reference or a widget file instead.";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

/** The Studio configuration that loads every catalog folder, with this `channel`. */
function configSource(channel) {
  const config = {
    schemaVersion: 1,
    widget: {root: "."},
    ...(channel ? {channel} : {}),
    themes: {glob: "themes/*.json"},
    fixtures: {glob: "fixtures/*.json"},
    scenes: {glob: "scenes/*.json"},
    scenarios: {glob: "scenarios/*.json"},
    recipes: {glob: "recipes/*.json"}
  };
  return `export default ${JSON.stringify(config, null, 2)};\n`;
}

/** Writes an index-layout widget with these FIELDS and its catalog files (a JSON value or a source string). */
async function writeWidget(root, fields, files = {}, channel = undefined) {
  const contents = {
    "index.html": '<main id="widget">Widget</main>\n',
    "style.css": "#widget { color: white; }\n",
    "script.js": "window.__widgetLoaded = true;\n",
    "fields.json": fields,
    [CONFIG_FILE_NAME]: configSource(channel),
    ...files
  };
  for (const [name, value] of Object.entries(contents)) {
    await mkdir(dirname(join(root, name)), {recursive: true});
    await writeFile(join(root, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

async function diagnosticsFor(root) {
  return validateProject(await loadProject({inputDirectory: root}));
}

const withCode = (diagnostics, code) => diagnostics.filter((item) => item.code === code);

/** A fixture named `chat` whose only event is a chat message with this data. */
const chatFixture = (data) => ({
  schemaVersion: 1,
  id: "chat",
  name: "Chat",
  events: [{atMs: 0, listener: "message", event: {data}}]
});

/** This value inside `levels` arrays, one in the other. */
const nested = (value, levels) => (levels === 0 ? value : [nested(value, levels - 1)]);

const LOGO_FIELD = {logo: {type: "image-input", label: "Logo", value: ""}};

test("an emote URL in a fixture is reported as one warning that names the fixture", async (t) => {
  const root = await temporaryDirectory(t, "sws-network-url-emote-");
  // The se-matrix-chat fixture of 2026-11-07: the test run passed, the video render failed on this URL.
  await writeWidget(
    root,
    {},
    {
      "fixtures/chat.json": chatFixture({
        text: "hello Kappa",
        emotes: [{type: "twitch", name: "Kappa", id: "25", urls: {1: "https://emotes.invalid/broken.png"}}]
      })
    }
  );

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(withCode(diagnostics, "FIXTURE_NETWORK_URL"), [
    {
      status: "warning",
      code: "FIXTURE_NETWORK_URL",
      detail: 'External URLs in test data: fixture "chat" uses https://emotes.invalid/broken.png.',
      hint: HINT
    }
  ]);
  assert.equal(hasValidationErrors(diagnostics), false);
});

test("a catalog that uses only sws-sample: references gets no new diagnostic", async (t) => {
  const root = await temporaryDirectory(t, "sws-network-url-samples-");
  await writeWidget(root, LOGO_FIELD, {
    "themes/night.json": {schemaVersion: 1, id: "night", name: "Night", fieldData: {logo: "sws-sample:backdrops/aero.jpg"}},
    "fixtures/chat.json": chatFixture({text: "hello", avatar: "sws-sample:avatars/pixel-1.png"})
  });

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(withCode(diagnostics, "FIXTURE_NETWORK_URL"), []);
  assert.deepEqual(
    diagnostics.map((item) => item.code),
    ["WIDGET_LAYOUT", "FIELDS_PARSED", "WIDGET_SCRIPT_SYNTAX", "SHIPPED_THEMES", "SAMPLE_MEDIA", "CATALOG", "PARITY_BOUNDARY"]
  );
});

test("every catalog source is checked and named by its label, in catalog order", async (t) => {
  const root = await temporaryDirectory(t, "sws-network-url-sources-");
  await writeWidget(
    root,
    LOGO_FIELD,
    {
      "themes/night.json": {schemaVersion: 1, id: "night", name: "Night", fieldData: {logo: "https://cdn.invalid/shared.png"}},
      "scenes/stage.json": {schemaVersion: 1, id: "stage", name: "Stage", fieldData: {logo: "https://cdn.invalid/shared.png"}},
      "scenarios/greeting.json": {
        schemaVersion: 1,
        id: "greeting",
        name: "Greeting",
        steps: [
          {
            action: "dispatch",
            listener: "message",
            event: {data: {text: "hi", emotes: [{urls: {1: "https://cdn.invalid/scenario.png"}}]}}
          }
        ]
      },
      "recipes/listing.json": {
        schemaVersion: 1,
        id: "listing",
        name: "Listing",
        scenes: ["stage"],
        matrix: {backgrounds: [{id: "photo", image: "https://cdn.invalid/recipe.png"}]}
      }
    },
    {username: "studio_channel", avatar: "https://cdn.invalid/channel.png"}
  );

  const found = withCode(await diagnosticsFor(root), "FIXTURE_NETWORK_URL");

  // The theme and the scene share a URL: it is listed for each source.
  assert.deepEqual(
    found.map((item) => item.detail),
    [
      "External URLs in test data: channel uses https://cdn.invalid/channel.png; " +
        'theme "night" uses https://cdn.invalid/shared.png; ' +
        'scene "stage" uses https://cdn.invalid/shared.png; ' +
        'scenario "greeting" uses https://cdn.invalid/scenario.png; ' +
        'recipe "listing" uses https://cdn.invalid/recipe.png.'
    ]
  );
});

test("http://, upper case, padded and unparseable URLs count; values past level 64 and Google Fonts hosts do not", async (t) => {
  const root = await temporaryDirectory(t, "sws-network-url-schemes-");
  await writeWidget(
    root,
    {},
    {
      "fixtures/chat.json": chatFixture({
        avatar: "http://cdn.invalid/a.png",
        badge: "  https://cdn.invalid/padded.png\n",
        banner: "HTTPS://CDN.INVALID/UPPER.PNG",
        // `new URL` refuses this host: it cannot be told apart from an external one, so it is reported.
        broken: "https://[cdn.invalid/unparsed.png",
        // A field of the event data sits 5 levels below the fixture: 59 arrays put a string at level 64, the last one walked.
        edge: nested("https://cdn.invalid/level-64.png", 59),
        deep: nested("https://cdn.invalid/level-65.png", 60),
        stylesheet: "https://fonts.googleapis.com/css2?family=Inter",
        font: "https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2"
      })
    }
  );

  const found = withCode(await diagnosticsFor(root), "FIXTURE_NETWORK_URL");

  assert.deepEqual(
    found.map((item) => item.detail),
    [
      'External URLs in test data: fixture "chat" uses http://cdn.invalid/a.png; ' +
        'fixture "chat" uses https://cdn.invalid/padded.png; ' +
        'fixture "chat" uses HTTPS://CDN.INVALID/UPPER.PNG; ' +
        'fixture "chat" uses https://[cdn.invalid/unparsed.png; ' +
        'fixture "chat" uses https://cdn.invalid/level-64.png.'
    ]
  );
});

test("a text with a link and a FIELDS default URL are not reported", async (t) => {
  const root = await temporaryDirectory(t, "sws-network-url-text-");
  await writeWidget(
    root,
    {logo: {type: "image-input", label: "Logo", value: "https://cdn.invalid/default.png"}},
    {"fixtures/chat.json": chatFixture({text: "visit https://example.com today"})}
  );

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(withCode(diagnostics, "FIXTURE_NETWORK_URL"), []);
});

test("a repeated URL is listed once per source, and entries past the fifth are counted", async (t) => {
  const root = await temporaryDirectory(t, "sws-network-url-many-");
  await writeWidget(
    root,
    {},
    {
      "fixtures/chat.json": chatFixture({
        avatar: "https://cdn.invalid/1.png",
        emotes: [
          {urls: {1: "https://cdn.invalid/2.png", 2: "https://cdn.invalid/3.png", 4: "https://cdn.invalid/1.png"}},
          {urls: {1: "https://cdn.invalid/4.png", 2: "https://cdn.invalid/5.png"}},
          {urls: {1: "https://cdn.invalid/6.png", 2: "https://cdn.invalid/7.png"}}
        ]
      })
    }
  );

  const found = withCode(await diagnosticsFor(root), "FIXTURE_NETWORK_URL");

  assert.deepEqual(
    found.map((item) => item.detail),
    [
      'External URLs in test data: fixture "chat" uses https://cdn.invalid/1.png; ' +
        'fixture "chat" uses https://cdn.invalid/2.png; ' +
        'fixture "chat" uses https://cdn.invalid/3.png; ' +
        'fixture "chat" uses https://cdn.invalid/4.png; ' +
        'fixture "chat" uses https://cdn.invalid/5.png; and 2 more.'
    ]
  );
});

test("the validate command prints the warning and still exits 0", async (t) => {
  const root = await temporaryDirectory(t, "sws-network-url-cli-");
  await writeWidget(
    root,
    {},
    {"fixtures/chat.json": chatFixture({emotes: [{urls: {1: "https://emotes.invalid/broken.png"}}]})}
  );
  const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

  const result = await execFileAsync(process.execPath, [cliPath, "validate", root]).then(
    ({stdout}) => ({code: 0, stdout}),
    (error) => ({code: error.code, stdout: error.stdout})
  );

  assert.equal(result.code, 0);
  assert.deepEqual(
    result.stdout.split("\n").filter((line) => line.includes("FIXTURE_NETWORK_URL")),
    ['WARNING FIXTURE_NETWORK_URL          External URLs in test data: fixture "chat" uses https://emotes.invalid/broken.png.']
  );
});
