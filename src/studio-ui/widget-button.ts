import type {JsonObject, JsonValue} from "../types.js";

/**
 * The event a StreamElements `button` field sends when it is pressed in the overlay editor, as the
 * widget's `onEventReceived` receives it: `detail.listener` is "event:test" and `detail.event` holds
 * the field, its value, and the "widget-button" marker. Checked on a test overlay on 2026-10-05
 * (the editor broadcasts `{event: "event:test", data: {field, value, listener: "widget-button"}}`).
 * The local UI and the tutorial both dispatch through this builder, so they never diverge.
 */
export function widgetButtonEvent(field: string, value: JsonValue): {listener: string; event: JsonObject} {
  return {listener: "event:test", event: {field, value, listener: "widget-button"}};
}

/**
 * The value the editor sends for a button: the field's saved value when fieldData has its key,
 * otherwise the FIELDS `value` (null when FIELDS has none).
 */
export function widgetButtonValue(fieldData: JsonObject, field: {id: string; value: JsonValue | undefined}): JsonValue {
  return Object.hasOwn(fieldData, field.id) ? fieldData[field.id]! : field.value ?? null;
}

/** A button with an `openUrl` opens that page in StreamElements instead of sending an event. */
export function widgetButtonOpenUrl(definition: JsonObject): string | undefined {
  return typeof definition.openUrl === "string" && definition.openUrl ? definition.openUrl : undefined;
}
