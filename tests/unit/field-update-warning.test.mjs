import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {fieldUpdateWarnings, planRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";

const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

test("fieldUpdateWarnings warns only for event mode, a tutorial that changes fields, and a script without onWidgetUpdate", () => {
  const silent = "window.addEventListener('onWidgetLoad', () => {});";
  assert.match(fieldUpdateWarnings({mode: "event", changesFields: true, widgetScript: silent}).join(), /^FIELD_UPDATE_NO_LISTENER: /);
  assert.deepEqual(fieldUpdateWarnings({mode: "reload", changesFields: true, widgetScript: silent}), []);
  assert.deepEqual(fieldUpdateWarnings({mode: "event", changesFields: false, widgetScript: silent}), []);
  assert.deepEqual(fieldUpdateWarnings({mode: "event", changesFields: true, widgetScript: "addEventListener('onWidgetUpdate', f)"}), []);
});

test("a dry run of a setField tutorial in event mode lists FIELD_UPDATE_NO_LISTENER when the widget never listens", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-field-update-"));
  try {
    const recipeOf = (project) => project.recipes.find((item) => item.id === "tutorial-setup").value;

    const reload = await loadProject({inputDirectory: exampleRoot});
    assert.equal((await planRecipe(reload, recipeOf(reload))).plan.warnings, undefined, "the default reload mode needs no listener");

    const listening = await loadProject({inputDirectory: exampleRoot});
    listening.config.widget.fieldUpdate = "event";
    assert.equal((await planRecipe(listening, recipeOf(listening))).plan.warnings, undefined, "the example's widget listens");

    const silent = await loadProject({inputDirectory: exampleRoot});
    silent.config.widget.fieldUpdate = "event";
    silent.files.js = join(root, "widget.js");
    await writeFile(silent.files.js, "window.addEventListener('onWidgetLoad', () => {});\n");
    const {plan} = await planRecipe(silent, recipeOf(silent));
    assert.equal(plan.warnings?.length, 1);
    assert.match(plan.warnings[0], /^FIELD_UPDATE_NO_LISTENER: widget\.fieldUpdate is "event"/);

    // listing-tutorial opens groups and chats but changes no field.
    const browsing = silent.recipes.find((item) => item.id === "listing-tutorial").value;
    assert.equal((await planRecipe(silent, browsing)).plan.warnings, undefined, "a tutorial without setField needs no listener");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
