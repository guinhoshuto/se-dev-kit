import {readFile} from "node:fs/promises";
import vm from "node:vm";
import type {Diagnostic, ResolvedProject} from "../types.js";
import {loadMarketplacePreset, marketplaceRecipeIssues} from "../config/presets.js";
import {expandRecipe} from "../capture/matrix.js";
import {findSensitiveTestData} from "./privacy.js";

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

export function hasValidationErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((item) => item.status === "error");
}
