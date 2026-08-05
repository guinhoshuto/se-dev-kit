import type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  NormalizedField,
  NormalizedFieldOption
} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {isJsonObject} from "../shared/json.js";

const EDITABLE_TYPES = new Set([
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
  "sound-input"
]);

function asJsonPrimitive(value: JsonValue, fallback: JsonPrimitive): JsonPrimitive {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
    ? value
    : fallback;
}

function normalizeOptions(value: JsonValue | undefined): NormalizedFieldOption[] {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.flatMap((option): NormalizedFieldOption[] => {
      if (typeof option === "string" || typeof option === "number" || typeof option === "boolean" || option === null) {
        return [{label: String(option), value: option}];
      }
      if (!isJsonObject(option)) return [];
      const rawValue = option.value ?? option.id ?? option.label ?? option.name;
      if (rawValue === undefined) return [];
      const primitive = asJsonPrimitive(rawValue, String(rawValue));
      const labelValue = option.label ?? option.name ?? primitive;
      return [{label: String(labelValue), value: primitive}];
    });
  }

  if (isJsonObject(value)) {
    return Object.entries(value).map(([optionValue, label]) => ({
      label: String(label),
      value: optionValue
    }));
  }

  return [];
}

function normalizeDefinition(id: string, value: JsonValue): NormalizedField {
  const definition = isJsonObject(value) ? value : ({value} as JsonObject);
  const rawType = definition.type;
  const type = typeof rawType === "string" ? rawType.toLowerCase() : "text";
  const defaultValue = definition.value ?? definition.default ?? "";
  const labelValue = definition.label ?? definition.name ?? id;
  const groupValue = definition.group;

  const field: NormalizedField = {
    id,
    label: String(labelValue),
    type,
    value: defaultValue,
    options: normalizeOptions(definition.options),
    definition,
    editable: EDITABLE_TYPES.has(type)
  };

  if (typeof groupValue === "string") field.group = groupValue;
  if (typeof definition.min === "number") field.min = definition.min;
  if (typeof definition.max === "number") field.max = definition.max;
  if (typeof definition.step === "number") field.step = definition.step;
  return field;
}

export function normalizeFields(raw: JsonValue): {fields: NormalizedField[]; defaults: JsonObject} {
  let definitions: JsonValue = raw;
  if (isJsonObject(raw) && raw.fields !== undefined) definitions = raw.fields;

  const fields: NormalizedField[] = [];
  if (Array.isArray(definitions)) {
    for (const [index, definition] of definitions.entries()) {
      if (!isJsonObject(definition)) {
        throw new StudioError("INVALID_FIELDS", `Field at array index ${index} must be an object.`);
      }
      const candidateId = definition.id ?? definition.name;
      if (typeof candidateId !== "string" || candidateId.length === 0) {
        throw new StudioError("INVALID_FIELDS", `Field at array index ${index} is missing an id or name.`);
      }
      fields.push(normalizeDefinition(candidateId, definition));
    }
  } else if (isJsonObject(definitions)) {
    for (const [id, definition] of Object.entries(definitions)) {
      fields.push(normalizeDefinition(id, definition));
    }
  } else {
    throw new StudioError("INVALID_FIELDS", "FIELDS schema must be an object, an array, or an object with a fields key.");
  }

  const seen = new Set<string>();
  const defaults: JsonObject = {};
  for (const field of fields) {
    if (seen.has(field.id)) {
      throw new StudioError("DUPLICATE_FIELD", `Duplicate field id: ${field.id}`);
    }
    seen.add(field.id);
    defaults[field.id] = structuredClone(field.value);
  }
  return {fields, defaults};
}
