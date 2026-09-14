import {basename, extname} from "node:path";
import fg from "fast-glob";
import type {ZodType} from "zod";
import type {
  CatalogItem,
  FixtureDefinition,
  JsonObject,
  JsonValue,
  RecipeDefinition,
  ScenarioDefinition,
  SceneDefinition,
  ThemeDefinition
} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {assertSafeId, slugify} from "../shared/ids.js";
import {isJsonObject, readJsonFile} from "../shared/json.js";
import {isInside, resolveExistingPath} from "../shared/paths.js";
import {fixtureSchema, recipeSchema, scenarioSchema, sceneSchema, themeSchema} from "./schemas.js";

function fileId(filePath: string): string {
  return slugify(basename(filePath, extname(filePath)));
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

async function catalogFiles(root: string, pattern: string): Promise<string[]> {
  const realRoot = await resolveExistingPath(root, "Widget root");
  const matches = await fg(pattern, {
    cwd: realRoot,
    absolute: true,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    unique: true
  });
  const result: string[] = [];
  for (const match of matches.sort()) {
    const realMatch = await resolveExistingPath(match, "Catalog file");
    if (!isInside(realRoot, realMatch)) {
      throw new StudioError("PATH_ESCAPE", `Catalog file escapes the widget root: ${match}`);
    }
    result.push(realMatch);
  }
  return result;
}

async function loadTypedCatalog<T extends {id: string}>(
  root: string,
  pattern: string | undefined,
  schema: ZodType<T>,
  kind: string
): Promise<CatalogItem<T>[]> {
  if (!pattern) return [];
  const files = await catalogFiles(root, pattern);
  const items: CatalogItem<T>[] = [];
  const ids = new Map<string, string>();
  for (const filePath of files) {
    const raw = await readJsonFile(filePath);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new StudioError(
        "INVALID_CATALOG_ITEM",
        `Invalid ${kind} file ${filePath}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
      );
    }
    assertSafeId(parsed.data.id, `${kind} id`);
    const previous = ids.get(parsed.data.id);
    if (previous) {
      throw new StudioError("DUPLICATE_ID", `Duplicate ${kind} id "${parsed.data.id}" in ${previous} and ${filePath}.`);
    }
    ids.set(parsed.data.id, filePath);
    items.push({id: parsed.data.id, filePath, value: parsed.data});
  }
  return items;
}

export async function loadThemes(root: string, pattern: string | undefined): Promise<CatalogItem<ThemeDefinition>[]> {
  if (!pattern) return [];
  const files = await catalogFiles(root, pattern);
  const items: CatalogItem<ThemeDefinition>[] = [];
  const ids = new Map<string, string>();

  for (const filePath of files) {
    const raw = await readJsonFile(filePath);
    if (!isJsonObject(raw)) {
      throw new StudioError("INVALID_THEME", `Theme must be a JSON object: ${filePath}`);
    }
    const derivedId = fileId(filePath);
    const wrapped = raw.fieldData !== undefined
      ? raw
      : ({schemaVersion: 1, id: derivedId, name: titleFromId(derivedId), fieldData: raw} as JsonObject);
    const candidate = isJsonObject(wrapped)
      ? ({...wrapped, id: wrapped.id ?? derivedId, name: wrapped.name ?? wrapped.label ?? titleFromId(derivedId)} as JsonObject)
      : wrapped;
    const parsed = themeSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new StudioError(
        "INVALID_THEME",
        `Invalid theme file ${filePath}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
      );
    }
    assertSafeId(parsed.data.id, "theme id");
    const previous = ids.get(parsed.data.id);
    if (previous) throw new StudioError("DUPLICATE_ID", `Duplicate theme id "${parsed.data.id}".`);
    ids.set(parsed.data.id, filePath);
    items.push({id: parsed.data.id, filePath, value: parsed.data as ThemeDefinition});
  }
  return items;
}

export function loadFixtures(root: string, pattern?: string): Promise<CatalogItem<FixtureDefinition>[]> {
  return loadTypedCatalog(root, pattern, fixtureSchema as ZodType<FixtureDefinition>, "fixture");
}

export function loadScenarios(root: string, pattern?: string): Promise<CatalogItem<ScenarioDefinition>[]> {
  return loadTypedCatalog(root, pattern, scenarioSchema as ZodType<ScenarioDefinition>, "scenario");
}

export function loadScenes(root: string, pattern?: string): Promise<CatalogItem<SceneDefinition>[]> {
  return loadTypedCatalog(root, pattern, sceneSchema as ZodType<SceneDefinition>, "scene");
}

export function loadRecipes(root: string, pattern?: string): Promise<CatalogItem<RecipeDefinition>[]> {
  return loadTypedCatalog(root, pattern, recipeSchema as ZodType<RecipeDefinition>, "recipe");
}
