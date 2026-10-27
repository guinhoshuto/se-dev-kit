import {readFile} from "node:fs/promises";
import {relative, sep} from "node:path";
import vm from "node:vm";
import type {Diagnostic, ResolvedProject} from "../types.js";
import {loadShippedThemes, type ShippedTheme} from "../config/catalog.js";
import {loadMarketplacePreset, marketplaceRecipeIssues} from "../config/presets.js";
import {expandRecipe} from "../capture/matrix.js";
import {findSensitiveTestData} from "./privacy.js";
import {loadSampleMediaCatalog, type SampleMediaCatalog} from "../config/sample-media.js";
import {collectSampleMediaReferences, sampleKindsForField} from "../studio-ui/sample-media.js";

const RECOGNIZED_FIELD_TYPES = new Set([
  "text",
  "number",
  "slider",
  "checkbox",
  "dropdown",
  "color",
  "colorpicker",
  "font",
  "googlefont",
  "image-input",
  "video-input",
  "sound-input",
  "hidden",
  "button"
]);

// A 79-character button label pushed the StreamElements editor's field panel out of place (WID-10).
const BUTTON_LABEL_MAX = 24;
// The editor shows a number or text field's label on one 280 px line and cuts the rest with an ellipsis (se-dev-kit#4).
const LINE_LABEL_MAX = 36;
const LINE_LABEL_TYPES = new Set(["number", "text"]);
const graphemes = new Intl.Segmenter("en", {granularity: "grapheme"});

/** Characters as a reader counts them: an emoji, even one built from several code points, is one. */
function characterCount(text: string): number {
  return [...graphemes.segment(text)].length;
}

function diagnostic(
  status: Diagnostic["status"],
  code: string,
  detail: string,
  hint?: string
): Diagnostic {
  const result: Diagnostic = {status, code, detail};
  if (hint) result.hint = hint;
  return result;
}

export async function validateProject(project: ResolvedProject): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  diagnostics.push(
    diagnostic(
      "ok",
      "WIDGET_LAYOUT",
      `Using ${project.relativeFiles.html}, ${project.relativeFiles.css}, ${project.relativeFiles.js}, and ${project.relativeFiles.fields}.`
    )
  );
  diagnostics.push(diagnostic("ok", "FIELDS_PARSED", `Normalized ${project.fields.length} field definitions.`));

  for (const field of project.fields) {
    if (!RECOGNIZED_FIELD_TYPES.has(field.type)) {
      diagnostics.push(
        diagnostic(
          "warning",
          "UNKNOWN_FIELD_TYPE",
          `Field "${field.id}" uses unsupported editor type "${field.type}"; its value is preserved and available in raw JSON.`
        )
      );
    }
  }

  try {
    const script = await readFile(project.files.js, "utf8");
    new vm.Script(script, {filename: project.relativeFiles.js});
    diagnostics.push(diagnostic("ok", "WIDGET_SCRIPT_SYNTAX", "Widget JavaScript parses as a classic browser script."));
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "error",
        "WIDGET_SCRIPT_SYNTAX",
        `Widget JavaScript could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }

  const fieldIds = new Set(project.fields.map((field) => field.id));
  for (const theme of project.themes) {
    const unknownKeys = Object.keys(theme.value.fieldData).filter((key) => !fieldIds.has(key));
    if (unknownKeys.length > 0) {
      diagnostics.push(
        diagnostic(
          "warning",
          "THEME_UNKNOWN_FIELDS",
          `Theme "${theme.id}" contains fields not present in the schema: ${unknownKeys.join(", ")}.`
        )
      );
    }
  }

  diagnostics.push(...buttonLabelDiagnostics(project));
  diagnostics.push(...lineLabelDiagnostics(project));
  diagnostics.push(...(await shippedThemeDiagnostics(project)));

  const sensitiveFindings = findSensitiveTestData(project);
  if (sensitiveFindings.length > 0) {
    diagnostics.push(
      diagnostic(
        "error",
        "SENSITIVE_TEST_DATA",
        `Studio inputs contain token, cookie, webhook, authorization, or live StreamElements API data at: ${sensitiveFindings.join(", ")}.`,
        "Replace it with synthetic public-safe values."
      )
    );
  }

  const themeIds = new Set(project.themes.map((item) => item.id));
  const fixtureIds = new Set(project.fixtures.map((item) => item.id));
  const sceneIds = new Set(project.scenes.map((item) => item.id));
  const scenarioIds = new Set(project.scenarios.map((item) => item.id));
  for (const scene of project.scenes) {
    if (scene.value.theme && !themeIds.has(scene.value.theme)) {
      diagnostics.push(diagnostic("error", "SCENE_THEME_MISSING", `Scene "${scene.id}" references missing theme "${scene.value.theme}".`));
    }
    if (scene.value.fixture && !fixtureIds.has(scene.value.fixture)) {
      diagnostics.push(
        diagnostic("error", "SCENE_FIXTURE_MISSING", `Scene "${scene.id}" references missing fixture "${scene.value.fixture}".`)
      );
    }
    const crop = scene.value.crop;
    const output = scene.value.output;
    if (crop && output && (crop.x + crop.width > output.width || crop.y + crop.height > output.height)) {
      diagnostics.push(diagnostic("error", "SCENE_CROP_BOUNDS", `Scene "${scene.id}" crop exceeds its output dimensions.`));
    }
  }
  for (const scenario of project.scenarios) {
    if (scenario.value.theme && !themeIds.has(scenario.value.theme)) {
      diagnostics.push(
        diagnostic("error", "SCENARIO_THEME_MISSING", `Scenario "${scenario.id}" references missing theme "${scenario.value.theme}".`)
      );
    }
    if (scenario.value.fixture && !fixtureIds.has(scenario.value.fixture)) {
      diagnostics.push(
        diagnostic(
          "error",
          "SCENARIO_FIXTURE_MISSING",
          `Scenario "${scenario.id}" references missing fixture "${scenario.value.fixture}".`
        )
      );
    }
    if (scenario.value.scene && !sceneIds.has(scenario.value.scene)) {
      diagnostics.push(
        diagnostic("error", "SCENARIO_SCENE_MISSING", `Scenario "${scenario.id}" references missing scene "${scenario.value.scene}".`)
      );
    }
  }
  for (const recipe of project.recipes) {
    for (const scene of recipe.value.scenes) {
      if (!sceneIds.has(scene)) {
        diagnostics.push(diagnostic("error", "RECIPE_SCENE_MISSING", `Recipe "${recipe.id}" references missing scene "${scene}".`));
      }
    }
    for (const theme of recipe.value.matrix?.themes ?? []) {
      if (theme !== "*" && !themeIds.has(theme)) {
        diagnostics.push(diagnostic("error", "RECIPE_THEME_MISSING", `Recipe "${recipe.id}" references missing theme "${theme}".`));
      }
    }
    if (recipe.value.marketplacePreset) {
      try {
        const preset = await loadMarketplacePreset(recipe.value.marketplacePreset);
        const issues = marketplaceRecipeIssues(
          recipe.value,
          preset,
          expandRecipe(project, recipe.value)
        );
        diagnostics.push(issues.length > 0
          ? diagnostic(
              "error",
              "MARKETPLACE_RECIPE_INVALID",
              `Recipe "${recipe.id}" does not satisfy preset "${preset.id}": ${issues.join("; ")}.`
            )
          : diagnostic(
              "ok",
              "MARKETPLACE_PRESET",
              `Recipe "${recipe.id}" satisfies ${preset.marketplace} preset "${preset.id}", verified ${preset.verifiedAt}.`
            ));
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "error",
            "MARKETPLACE_PRESET_MISSING",
            error instanceof Error ? error.message : String(error)
          )
        );
      }
    }
  }

  diagnostics.push(...(await sampleMediaDiagnostics(project)));

  diagnostics.push(
    diagnostic(
      "ok",
      "CATALOG",
      `${project.themes.length} themes, ${project.fixtures.length} fixtures, ${project.scenes.length} scenes, ${scenarioIds.size} scenarios, and ${project.recipes.length} recipes loaded.`
    )
  );
  diagnostics.push(
    diagnostic(
      "warning",
      "PARITY_BOUNDARY",
      "Local validation covers the Studio's essential simulation only; it does not prove undocumented StreamElements or OBS behavior."
    )
  );
  return diagnostics;
}

function buttonLabelDiagnostics(project: ResolvedProject): Diagnostic[] {
  return project.fields
    .filter((field) => field.type === "button" && characterCount(field.label) > BUTTON_LABEL_MAX)
    .map((field) =>
      diagnostic(
        "error",
        "FIELD_BUTTON_LABEL_LONG",
        `Button field "${field.id}" has a ${characterCount(field.label)}-character label; a button label over ${BUTTON_LABEL_MAX} characters pushes the StreamElements editor's field panel out of place.`,
        `Shorten it to ${BUTTON_LABEL_MAX} characters or fewer, and explain the button in another field or the README.`
      )
    );
}

function lineLabelDiagnostics(project: ResolvedProject): Diagnostic[] {
  return project.fields
    .filter((field) => LINE_LABEL_TYPES.has(field.type) && characterCount(field.label) > LINE_LABEL_MAX)
    .map((field) =>
      diagnostic(
        "warning",
        "FIELD_LABEL_TRUNCATED",
        `The ${field.type} field "${field.id}" has a ${characterCount(field.label)}-character label; the StreamElements editor shows a ${field.type} field's label on one line of about ${LINE_LABEL_MAX} characters and cuts the rest with an ellipsis.`,
        `Shorten it to ${LINE_LABEL_MAX} characters or fewer, and explain the field in the README.`
      )
    );
}

/**
 * A theme that ships is pasted into the DATA tab as it is, so it sets every FIELDS key but buttons: a key
 * added to FIELDS needs a value chosen for each look. `themes.keepDefault` lists the keys that may stay out.
 */
async function shippedThemeDiagnostics(project: ResolvedProject): Promise<Diagnostic[]> {
  let themes: ShippedTheme[];
  try {
    themes = await loadShippedThemes(project.widgetRoot);
  } catch (error) {
    return [diagnostic("error", "SHIPPED_THEME_INVALID", error instanceof Error ? error.message : String(error))];
  }
  if (themes.length === 0) return [];
  const keepDefault = new Set(project.config.themes?.keepDefault ?? []);
  const keys = project.fields.filter((field) => field.type !== "button" && !keepDefault.has(field.id)).map((field) => field.id);
  const diagnostics: Diagnostic[] = [];
  for (const theme of themes) {
    const label = relative(project.widgetRoot, theme.filePath).split(sep).join("/");
    const fieldData = theme.fieldData;
    if (!fieldData) {
      diagnostics.push(diagnostic("error", "SHIPPED_THEME_INVALID", `Shipped theme ${label} is not a JSON object.`));
      continue;
    }
    const missing = keys.filter((key) => !Object.hasOwn(fieldData, key));
    if (missing.length > 0) {
      diagnostics.push(
        diagnostic(
          "error",
          "THEME_FIELDS_MISSING",
          `Shipped theme ${label} does not set ${missing.length} FIELDS key${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
          "Give each key the value that fits this look, or list it in themes.keepDefault in the Studio configuration when the widget behaves the same without it as with its FIELDS default."
        )
      );
    }
  }
  if (diagnostics.length === 0) {
    diagnostics.push(
      diagnostic(
        "ok",
        "SHIPPED_THEMES",
        `${themes.length} shipped theme${themes.length === 1 ? " sets" : "s set"} every FIELDS key${keepDefault.size > 0 ? " outside themes.keepDefault" : ""}.`
      )
    );
  }
  return diagnostics;
}

/** Checks every `sws-sample:` reference against the built-in manifest; loads it only when one is used. */
async function sampleMediaDiagnostics(project: ResolvedProject): Promise<Diagnostic[]> {
  const sources: [string, unknown][] = [
    ["FIELDS defaults", project.fieldDefaults],
    ["channel", project.config.channel ?? {}],
    ...project.themes.map((item): [string, unknown] => [`theme "${item.id}"`, item.value]),
    ...project.fixtures.map((item): [string, unknown] => [`fixture "${item.id}"`, item.value]),
    ...project.scenes.map((item): [string, unknown] => [`scene "${item.id}"`, item.value]),
    ...project.scenarios.map((item): [string, unknown] => [`scenario "${item.id}"`, item.value]),
    ...project.recipes.map((item): [string, unknown] => [`recipe "${item.id}"`, item.value])
  ];
  const used = sources.flatMap(([label, value]) => collectSampleMediaReferences(value).map((reference) => ({label, reference})));
  if (used.length === 0) return [];
  let catalog: SampleMediaCatalog;
  try {
    catalog = await loadSampleMediaCatalog();
  } catch (error) {
    return [diagnostic("error", "SAMPLE_MEDIA_CATALOG_INVALID", error instanceof Error ? error.message : String(error))];
  }
  const unknown = used.filter(({reference}) => catalog.entry(reference) === undefined);
  if (unknown.length > 0) {
    const describe = ({label, reference}: {label: string; reference: string}) => {
      const retiredOn = catalog.retiredOn(reference);
      return `${label} uses ${reference}${retiredOn ? ` (retired on ${retiredOn})` : ""}`;
    };
    return [
      diagnostic(
        "error",
        "SAMPLE_MEDIA_UNKNOWN",
        `Unknown sample media references: ${unknown.map(describe).join("; ")}.`,
        "See sample-media/manifest.json in the Studio package for the available sws-sample: references."
      )
    ];
  }
  const diagnostics: Diagnostic[] = [];
  // A clip is a video: CSS cannot draw it as a stage background.
  const backgrounds = [
    ...project.scenes.map((item) => ({label: `scene "${item.id}"`, image: item.value.background?.image})),
    ...project.recipes.flatMap((item) => (item.value.matrix?.backgrounds ?? []).map((background) => ({label: `recipe "${item.id}"`, image: background.image})))
  ].filter(({image}) => image !== undefined && catalog.entry(image)?.kind === "clip");
  if (backgrounds.length > 0) {
    diagnostics.push(
      diagnostic(
        "error",
        "SAMPLE_MEDIA_KIND",
        `Video clips cannot be stage backgrounds: ${backgrounds.map(({label, image}) => `${label} uses ${image}`).join("; ")}.`,
        "Use a gallery or backdrop sample as the background, and a clip only as a video-input value."
      )
    );
  }
  // A sample of the wrong kind still loads, but not as the field's element would load it on StreamElements.
  const fieldTypes = new Map(project.fields.map((field) => [field.id, field.type]));
  const mismatched: string[] = [];
  const catalogs: [string, {fieldData?: Record<string, unknown>} | undefined][] = [
    ...project.themes.map((item): [string, {fieldData?: Record<string, unknown>}] => [`theme "${item.id}"`, item.value]),
    ...project.scenes.map((item): [string, {fieldData?: Record<string, unknown>}] => [`scene "${item.id}"`, item.value])
  ];
  for (const [label, value] of catalogs) {
    for (const [fieldId, fieldValue] of Object.entries(value?.fieldData ?? {})) {
      const type = fieldTypes.get(fieldId);
      if (!type) continue;
      const kinds = sampleKindsForField(type);
      for (const reference of collectSampleMediaReferences(fieldValue)) {
        const kind = catalog.entry(reference)?.kind;
        if (kind && !kinds.includes(kind)) mismatched.push(`${label} sets ${type} field "${fieldId}" to the ${kind} sample ${reference}`);
      }
    }
  }
  if (mismatched.length > 0) {
    diagnostics.push(
      diagnostic(
        "warning",
        "SAMPLE_MEDIA_KIND",
        `Sample media of the wrong kind for its field: ${mismatched.join("; ")}.`,
        "Give image-input fields gallery, backdrop, or avatar samples, and video-input fields clip samples."
      )
    );
  }
  const distinct = new Set(used.map(({reference}) => reference)).size;
  diagnostics.push(diagnostic("ok", "SAMPLE_MEDIA", `${distinct} built-in sample media reference${distinct === 1 ? "" : "s"} resolved.`));
  return diagnostics;
}

export function hasValidationErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((item) => item.status === "error");
}

/**
 * The fields `validate` shows the owner before a new widget's first build, as information and never as an
 * error: the curve text widget reached 77 fields before anyone counted them, and the cap waits for this list (WID-13).
 */
export interface FieldInventory {
  count: number;
  /** Most used type first; types used as often, by name. */
  types: Array<{type: string; count: number}>;
  /** In FIELDS order. */
  list: Array<{id: string; type: string; label: string}>;
}

export function fieldInventory(project: ResolvedProject): FieldInventory {
  const counts = new Map<string, number>();
  for (const field of project.fields) counts.set(field.type, (counts.get(field.type) ?? 0) + 1);
  return {
    count: project.fields.length,
    types: [...counts]
      .map(([type, count]) => ({type, count}))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    list: project.fields.map(({id, type, label}) => ({id, type, label}))
  };
}

/** The inventory as text: a line with the count by type, then one aligned line per field. */
export function fieldInventoryLines(inventory: FieldInventory): string[] {
  const types = inventory.types.map(({type, count}) => `${count} ${type}`).join(", ");
  const summary = `${inventory.count} field${inventory.count === 1 ? "" : "s"}${types ? `: ${types}` : ""}`;
  if (inventory.list.length === 0) return [summary];
  const rows = [{id: "ID", type: "TYPE", label: "LABEL"}, ...inventory.list];
  const idWidth = Math.max(...rows.map((row) => row.id.length));
  const typeWidth = Math.max(...rows.map((row) => row.type.length));
  return [summary, ...rows.map((row) => `  ${row.id.padEnd(idWidth)}  ${row.type.padEnd(typeWidth)}  ${row.label}`)];
}
