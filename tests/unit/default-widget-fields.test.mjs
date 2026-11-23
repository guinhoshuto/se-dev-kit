import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {loadProject} from "../../dist/config/load.js";
import {hasValidationErrors, validateProject} from "../../dist/validation/project.js";

const execFileAsync = promisify(execFile);
const CODE = "FIELD_ID_DEFAULT_WIDGET";

// The 21 field ids of the default Custom widget (the event list), as se-parade's tests/static.test.mjs listed them at 343d248.
const DEFAULT_WIDGET_IDS = ["eventsLimit", "includeFollowers", "includeRedemptions", "includeHosts", "minHost", "includeRaids", "minRaid", "includeSubs", "includeTips", "minTip", "includeCheers", "minCheer", "direction", "textOrder", "fadeoutTime", "fontColor", "theme", "backgroundOpacity", "backgroundColor", "iconColor", "locale"];

// se-parade's FIELDS ids at 343d248, which renamed `direction` to `pathDirection`; at its parent the fifth id was `direction`.
const PARADE_IDS = ["images", "sizeMin", "sizeMax", "speed", "pathDirection", "shape", "amplitude", "waves", "rotate", "spread", "depth", "spacing", "spacingRandom", "maxOnScreen", "accentSource", "accentImages", "accents", "accentAmount", "sparkleColor1", "sparkleColor2", "dotColor", "widgetName"];

const HINT =
  'The StreamElements editor keeps a widget\'s stored field values by id when its FIELDS change: on 2026-11-21 Icon Parade pasted over the default widget showed its direction "top" in a dropdown without that option. Rename the field.';

/** A widget in the files layout whose FIELDS are text fields with these ids. */
async function widgetWith(t, ids) {
  const root = await mkdtemp(join(tmpdir(), "sws-default-widget-fields-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const fields = Object.fromEntries(ids.map((id) => [id, {type: "text", label: id, value: "", group: "Main"}]));
  await writeFile(join(root, "index.html"), '<main id="widget">Widget</main>\n');
  await writeFile(join(root, "style.css"), "#widget { color: white; }\n");
  await writeFile(join(root, "script.js"), "window.__widgetLoaded = true;\n");
  await writeFile(join(root, "fields.json"), `${JSON.stringify(fields, null, 2)}\n`);
  return root;
}

async function diagnosticsFor(root) {
  return validateProject(await loadProject({inputDirectory: root}));
}

const withCode = (diagnostics) => diagnostics.filter((item) => item.code === CODE);

test("a direction field gets one warning that names the id", async (t) => {
  const diagnostics = await diagnosticsFor(await widgetWith(t, PARADE_IDS.map((id) => (id === "pathDirection" ? "direction" : id))));

  assert.deepEqual(withCode(diagnostics), [
    {
      status: "warning",
      code: CODE,
      detail:
        'Field "direction" has the id of a field of the default Custom widget: a value stored under "direction" in an existing Custom widget shows through when this widget is pasted over it.',
      hint: HINT
    }
  ]);
  assert.equal(hasValidationErrors(diagnostics), false);
});

test("se-parade's FIELDS at 343d248 get no warning", async (t) => {
  assert.deepEqual(withCode(await diagnosticsFor(await widgetWith(t, PARADE_IDS))), []);
});

test("every id of the default widget is warned about, in FIELDS order", async (t) => {
  const ids = [...DEFAULT_WIDGET_IDS].reverse();
  const warned = withCode(await diagnosticsFor(await widgetWith(t, ["title", ...ids, "Direction"])));

  assert.deepEqual(
    warned.map((item) => item.detail.match(/^Field "([^"]+)"/)[1]),
    ids
  );
});

test("the validate command prints the warning and still exits 0", async (t) => {
  const root = await widgetWith(t, ["direction"]);
  const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

  const result = await execFileAsync(process.execPath, [cliPath, "validate", root]).then(
    ({stdout}) => ({code: 0, stdout}),
    (error) => ({code: error.code, stdout: error.stdout})
  );

  assert.equal(result.code, 0);
  assert.deepEqual(
    result.stdout.split("\n").filter((line) => line.includes(CODE)).map((line) => line.replace(/\s+/g, " ")),
    [
      'WARNING FIELD_ID_DEFAULT_WIDGET Field "direction" has the id of a field of the default Custom widget: a value stored under "direction" in an existing Custom widget shows through when this widget is pasted over it.'
    ]
  );
});
