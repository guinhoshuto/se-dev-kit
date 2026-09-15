import type {JsonObject, JsonValue} from "../types.js";

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function mergeJsonObjects(...objects: (JsonObject | undefined)[]): JsonObject {
  const result: JsonObject = {};
  for (const object of objects) {
    if (!object) continue;
    for (const [key, value] of Object.entries(object)) {
      result[key] = cloneJson(value);
    }
  }
  return result;
}

export function stableStringify(value: JsonValue, space = 2): string {
  const sortValue = (input: JsonValue): JsonValue => {
    if (Array.isArray(input)) return input.map(sortValue);
    if (!isJsonObject(input)) return input;
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)])
    );
  };
  return JSON.stringify(sortValue(value), null, space);
}
