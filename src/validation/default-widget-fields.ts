import type {Diagnostic, ResolvedProject} from "../types.js";

/**
 * The field ids of the Custom widget StreamElements adds to an overlay by default (the event list),
 * read from the overlay editor's bundle on 2026-11-21 and first listed in se-parade's
 * `tests/static.test.mjs` at 343d248. Refresh it with the editor extractor (SDK-83).
 */
export const DEFAULT_CUSTOM_WIDGET_FIELD_IDS: readonly string[] = [
  "eventsLimit",
  "includeFollowers",
  "includeRedemptions",
  "includeHosts",
  "minHost",
  "includeRaids",
  "minRaid",
  "includeSubs",
  "includeTips",
  "minTip",
  "includeCheers",
  "minCheer",
  "direction",
  "textOrder",
  "fadeoutTime",
  "fontColor",
  "theme",
  "backgroundOpacity",
  "backgroundColor",
  "iconColor",
  "locale"
];

const DEFAULT_WIDGET_FIELD_HINT =
  "The StreamElements editor keeps a widget's stored field values by id when its FIELDS change: on 2026-11-21 Icon Parade pasted over the default widget showed its direction \"top\" in a dropdown without that option. Rename the field.";

/** Warns once for each FIELDS id that the default Custom widget also has. */
export function defaultWidgetFieldDiagnostics(project: ResolvedProject): Diagnostic[] {
  const defaultIds = new Set(DEFAULT_CUSTOM_WIDGET_FIELD_IDS);
  return project.fields
    .filter((field) => defaultIds.has(field.id))
    .map((field) => ({
      status: "warning",
      code: "FIELD_ID_DEFAULT_WIDGET",
      detail: `Field "${field.id}" has the id of a field of the default Custom widget: a value stored under "${field.id}" in an existing Custom widget shows through when this widget is pasted over it.`,
      hint: DEFAULT_WIDGET_FIELD_HINT
    }));
}
