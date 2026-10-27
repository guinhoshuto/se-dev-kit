import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {loadProject} from "../../dist/config/load.js";
import {fieldInventory, fieldInventoryLines} from "../../dist/validation/project.js";

// The curve text widget reached 77 fields, was approved and put on an overlay before anyone counted them, and
// the owner asked to simplify it afterwards: `validate` counts and lists the fields, with no cap yet (WID-13).

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

/** A new widget as it stands before its first build: FIELDS written, the other three files still empty. */
async function writeNewWidget(root, fields) {
  await Promise.all([
    writeFile(join(root, "index.html"), ""),
    writeFile(join(root, "style.css"), ""),
    writeFile(join(root, "script.js"), ""),
    writeFile(join(root, "fields.json"), `${JSON.stringify(fields, null, 2)}\n`)
  ]);
}

async function inventoryFor(t, fields) {
  const root = await temporaryDirectory(t, "sws-field-inventory-");
  await writeNewWidget(root, fields);
  return fieldInventory(await loadProject({inputDirectory: root}));
}

test("the inventory counts each type, most used first and ties by name, and lists every field in FIELDS order", async (t) => {
  const inventory = await inventoryFor(t, {
    title: {type: "text", label: "Title", value: ""},
    showBadge: {type: "checkbox", label: "Show badge", value: true},
    accent: {type: "colorpicker", label: "Accent", value: "#ffffff"},
    panel: {type: "colorpicker", label: "Panel", value: "#000000"},
    caption: {type: "text", value: ""},
    glow: {type: "colorpicker", label: "Glow", value: "#ff7518"},
    spin: {type: "button", label: "🎡 Spin", value: "spin"},
    size: {type: "slider", label: "Size", value: 10, min: 1, max: 20}
  });

  assert.equal(inventory.count, 8);
  assert.deepEqual(inventory.types, [
    {type: "colorpicker", count: 3},
    {type: "text", count: 2},
    {type: "button", count: 1},
    {type: "checkbox", count: 1},
    {type: "slider", count: 1}
  ]);
  assert.deepEqual(inventory.list, [
    {id: "title", type: "text", label: "Title"},
    {id: "showBadge", type: "checkbox", label: "Show badge"},
    {id: "accent", type: "colorpicker", label: "Accent"},
    {id: "panel", type: "colorpicker", label: "Panel"},
    // A field without a label shows its id, as the StreamElements editor does.
    {id: "caption", type: "text", label: "caption"},
    {id: "glow", type: "colorpicker", label: "Glow"},
    {id: "spin", type: "button", label: "🎡 Spin"},
    {id: "size", type: "slider", label: "Size"}
  ]);
  assert.deepEqual(fieldInventoryLines(inventory), [
    "8 fields: 3 colorpicker, 2 text, 1 button, 1 checkbox, 1 slider",
    "  ID         TYPE         LABEL",
    "  title      text         Title",
    "  showBadge  checkbox     Show badge",
    "  accent     colorpicker  Accent",
    "  panel      colorpicker  Panel",
    "  caption    text         caption",
    "  glow       colorpicker  Glow",
    "  spin       button       🎡 Spin",
    "  size       slider       Size"
  ]);
});

test("one field reads as one field, and a widget without fields says so with no table", async (t) => {
  assert.deepEqual(fieldInventoryLines(await inventoryFor(t, {headline: {type: "text", label: "Headline", value: ""}})), [
    "1 field: 1 text",
    "  ID        TYPE  LABEL",
    "  headline  text  Headline"
  ]);
  assert.deepEqual(fieldInventoryLines(await inventoryFor(t, {})), ["0 fields"]);
});

test("validate prints the field list before its diagnostics, also with --json, and never fails on the count", {timeout: 60_000}, async (t) => {
  const root = await temporaryDirectory(t, "sws-field-inventory-cli-");
  const types = [...Array(40).fill("colorpicker"), ...Array(20).fill("text"), ...Array(10).fill("slider"), ...Array(10).fill("checkbox")];
  const fields = Object.fromEntries(types.map((type, index) => [`field${index + 1}`, {type, label: `Field ${index + 1}`, value: ""}]));
  await writeNewWidget(root, fields);

  const text = await execFileAsync(process.execPath, [cliPath, "validate", root]);
  const lines = text.stdout.split("\n");
  assert.equal(lines[0], "80 fields: 40 colorpicker, 20 text, 10 checkbox, 10 slider");
  assert.equal(lines[1], "  ID       TYPE         LABEL");
  assert.equal(lines[2], "  field1   colorpicker  Field 1");
  assert.equal(lines[80], "  field79  checkbox     Field 79");
  assert.equal(lines[81], "  field80  checkbox     Field 80");
  assert.equal(lines[82], "", "a blank line parts the list from the diagnostics");
  assert.match(lines[83], /^OK +WIDGET_LAYOUT /);
  assert.equal(lines.filter((line) => /^ERROR /.test(line)).length, 0);

  const json = JSON.parse((await execFileAsync(process.execPath, [cliPath, "validate", root, "--json"])).stdout);
  assert.equal(json.fields.count, 80);
  assert.deepEqual(json.fields.types, [
    {type: "colorpicker", count: 40},
    {type: "text", count: 20},
    {type: "checkbox", count: 10},
    {type: "slider", count: 10}
  ]);
  assert.equal(json.fields.list.length, 80);
  assert.deepEqual(json.fields.list[79], {id: "field80", type: "checkbox", label: "Field 80"});
  assert.deepEqual(json.diagnostics.filter((item) => item.status !== "ok").map((item) => item.code), ["PARITY_BOUNDARY"]);
});

test("the skill shows a new widget's field list to the owner before its first build", async () => {
  const skill = await readFile(fileURLToPath(new URL("../../skills/se-widget-studio/SKILL.md", import.meta.url)), "utf8");
  const bullet = skill.split("\n").find((line) => line.startsWith("- For a new widget,"));
  assert.ok(bullet, "SKILL.md has no bullet for a new widget");
  assert.match(bullet, /run the CLI's `validate`/);
  assert.match(bullet, /show the owner the field list it prints/);
  assert.match(bullet, /before its first build or Studio run/);
});
