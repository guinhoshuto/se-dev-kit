/** Local runs and hosted jobs serve each widget file at this frame-origin path: `/__sws/widget/<key>`, each segment URI-encoded. */
export const WIDGET_ROUTE = "/__sws/widget/";

export function widgetRoutePath(key: string): string {
  return `${WIDGET_ROUTE}${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** The widget-relative key a `/__sws/widget/<key>` value stands for, or undefined when it is not one. */
export function widgetRouteKey(value: string): string | undefined {
  if (!value.startsWith(WIDGET_ROUTE)) return undefined;
  try {
    const key = (value.slice(WIDGET_ROUTE.length).split(/[?#]/, 1)[0] ?? "").split("/").map(decodeURIComponent).join("/");
    return key || undefined;
  } catch {
    return undefined;
  }
}
