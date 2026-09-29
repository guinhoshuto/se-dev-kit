# Runtime and integration

## Isolation model

The Studio starts two HTTP servers on `127.0.0.1`:

1. A control origin for the UI, catalog API, capture host, and reload stream.
2. A different widget origin for the generated frame, real production assets, and runtime bridge.

The widget iframe uses `sandbox="allow-scripts allow-same-origin"`. `allow-same-origin` applies only to the separate widget origin; it does not grant access to the control UI. The bridge requires the exact parent/frame origin, exact `event.source`, a random session id, and a random 128-bit nonce.

Chromium emits a generic warning for that sandbox flag combination. Keeping a concrete, separate frame origin lets the bridge reject opaque `null` origins; the frame cannot navigate the parent, and automated contexts block every non-loopback request.

The frame document is assembled in memory. A production HTML fragment is wrapped in a minimal document. A full document keeps its markup, receives a local `<base>`, and has the configured production script loaded once after the bridge is ready. Consumer files are read but never copied or modified.

## Bridge sequence

1. Frame bridge installs error capture and the partial `SE_API`.
2. Frame sends `frame:booted`.
3. Host sends `host:init` with synthetic state.
4. Frame loads the optional browser adapter and real production JavaScript.
5. Frame dispatches `onWidgetLoad`.
6. Frame runs `settle()` (stylesheets, forced layout, `document.fonts.ready`, and `fonts.load` for each family the DOM, canvas text, or a Google Fonts URL uses), sends the per-family report as `frame:fonts`, waits for decoded images and available video data, then announces `frame:assets-ready`.
7. Frame waits for the configured selector and sends `frame:widget-ready`.
8. The host may send events or field updates.

Host event and field-update commands carry correlation ids. The frame acknowledges each command only after an asynchronous adapter hook, synchronous DOM event dispatch, and a `settle()` finish, and the acknowledgement carries the font report; scenarios then continue to their next action. `host:settle` (also `__SE_WIDGET_STUDIO__.settle()`) runs `settle()` on demand and answers with `frame:fonts`. The report lists each family, weight, and style as `loaded` or in fallback with a reason (`stylesheet-blocked`, `upstream-4xx`, `not-in-cache`, `face-error`, `timeout`, or `partial`), plus `redrawNeeded` when a face loaded after canvas text was last drawn. Bridge startup and commands have bounded timeouts; in captures the frame's timers are virtual, so the deadlines are kept in real time in Node. The editor preview has real timers and gives fonts a 6 s budget: a family still loading then is reported as fallback (`timeout`) and the status bar names it.

In captures, tutorial videos, and scenarios, a field change follows `widget.fieldUpdate`:

- `reload`, the default: the host recreates the iframe with every field value so far. Placeholders are substituted again, `onWidgetLoad` fires again, and the frame settles before the change returns. This matches the StreamElements editor, whose documented events are only `onWidgetLoad`, `onEventReceived`, and `onSessionUpdate`: a widget sees new field values only when it loads, and a `{{field}}` in its CSS can only change with a new document. Like a reload in StreamElements, it clears what the widget built before, such as chat messages. When the ready selector needs the widget's timers, the virtual time that takes becomes part of the timeline, so the frames after it keep exact timestamps; the manifest records it (see [Capture and media](CAPTURE.md#manifest)). Requests the replaced document still had in flight end as aborted and do not count as failures, while its runtime errors still do.
- `event`: the frame stays, and the Studio dispatches `onWidgetUpdate` with the merged values. StreamElements has no such event; it suits only widgets written against the Studio that must keep their state across a field change. Placeholders keep the values the frame loaded with.

The hosted editor preview always recreates the iframe when a field changes. The local development UI dispatches `onWidgetUpdate` for field edits in both modes, and its frames substitute placeholders with the FIELDS defaults. Theme, fixture, or scene changes recreate the iframe everywhere, to prevent duplicate listeners and stale DOM.

## Placeholders

As in StreamElements, a `{{name}}` in the widget's HTML, CSS, or JavaScript becomes the raw value of field `name` before the document loads: strings as written, numbers and booleans as text, `null` as nothing, and objects and arrays as JSON. Inner spaces are allowed (`{{ name }}`). Substitution happens in memory, in one pass, so a value that contains `{{…}}` is never expanded again, and the widget's files are never rewritten. A placeholder with no matching field stays as written and produces a warning. Because values are substituted raw, a value with quotes can break the CSS or JavaScript around it, as it would in StreamElements; the checks that refuse unsafe HTML at import run again on the substituted document.

Interactive Studio and Gallery frames install a fixed `Date` before production JavaScript runs, while keeping their human-facing timers live. Playwright capture frames declare their clock as externally managed instead, so `Date`, timers, CSS animations, and frame timestamps advance together under the paused browser clock. Both paths use the same configured `fixedTime` value.

The local `SE_API` subset follows the documented method shapes:

- `store.get(key)` resolves to the stored JSON object or `null`.
- `store.set(key, object)` resolves with no value and emits a synthetic `kvstore:update` event.
- `counters.get(name)` resolves to `{id, count}`; local counters start at zero.
- `getOverlayStatus()` resolves to `{isEditorMode: true, muted: false}`.

Store data is ephemeral to one isolated frame. Undocumented methods, store deletion, counter mutation, filtering, queue control, and editor persistence reject with `SWS_UNSUPPORTED_API`; they are not silently faked.

Reference: [StreamElements Custom Widget & SE_API](https://docs.streamelements.com/overlays/custom-widget), checked 2026-08-05. The Studio intentionally implements only the subset listed above.

## Adapter

An adapter is an optional browser ESM module for behavior that opaque fixtures cannot express:

```js
export default {
  async beforeLoad(state) {
    return state;
  },

  async afterLoad({state}) {
    // Optional widget-specific setup.
  },

  async beforeDispatch({listener, event}) {
    return event;
  }
};
```

Keep adapters narrow. Generic StreamElements event delivery, error capture, storage, capture, and readiness logic belongs in the shared package.

Config files run as trusted Node.js modules. Adapters run as trusted browser modules on the widget origin. Do not use untrusted code in either location.

## Asset allowlist

The server starts with the four configured production files, follows static local references from HTML/CSS/JavaScript, and adds explicit `widget.assets` globs. Every resulting file is checked with `realpath`, must remain inside the widget root, must not be a dotfile or output, and must use a supported web asset type. Requests only look up this precomputed map.

The frame runtime also replaces a whole string equal to an allowlisted file's key, its path relative to the widget root such as `studio/media/a.jpg`, with that file's absolute frame URL, in field data, channel, recents, field updates, and events; `{{field}}` placeholders receive the same URL. The production HTML, CSS, JavaScript, FIELDS, and adapter are not mapped. The bootstrap reads the map from `/__sws/asset-map.json` on the frame origin before it installs the runtime. Hosted previews map captured asset paths to data URLs the same way, so a catalog names widget media identically in both modes. A value written as `/__sws/widget/<key>` is left alone and still loads.

Built-in sample media use a separate frame-origin route, `/__sws/sample/<file>`, that looks up the verified `sample-media/manifest.json` of the Studio package by exact name and serves bytes checked against their SHA-256 at load. It never consults the widget allowlist and returns 404 for the manifest, the README, and every unlisted path. The frame runtime replaces a whole `sws-sample:<file>` string in field data, channel, recents, field updates, and events with the absolute URL of that route, so widgets that resolve media with `new URL(value, location.href)` receive a same-origin `http:` URL. The catalog loads on first use; widgets without sample references do not depend on it.

The configured production JavaScript file is removed from both fragment and full-document HTML before the in-memory frame is assembled, then loaded exactly once after the runtime is installed. Other inline scripts remain part of the production HTML and may run during parsing; widgets that depend on Studio state should keep runtime code in the configured JavaScript file.

Automated contexts abort every non-loopback HTTP request and every WebSocket. A blocked stylesheet, font, image, media file, or other request is reported as a runtime error instead of silently producing degraded final media. Google Fonts requests (`fonts.googleapis.com`, `fonts.gstatic.com`) are classified by URL instead: blocked or unavailable ones fail with `FONT_UNAVAILABLE`, naming the family and URL (the local CLI always blocks them and points to the hosted Studio), `/icon`, `text=` and other URLs outside the allowlist fail with `FONT_UNSUPPORTED` (hosted import copies the `/icon` and `text=` stylesheets written in HTML or CSS into the revision, so only those built at runtime get here), and a family Google refuses with a 4xx is only an `upstream-4xx` warning, because StreamElements shows the fallback too. Capture backgrounds must be a local allowlisted widget asset, a data URL, or a known `sws-sample:` reference, and are decoded before readiness. Unknown sample references fail with `SAMPLE_MEDIA_NOT_FOUND`; any other scheme is still blocked.

## Google Fonts

Widgets load Google Fonts as they do in StreamElements, with nothing to prepare, vendor, or edit. Only trusted server code talks to Google: GET requests to `fonts.googleapis.com` `/css` and `/css2` and to `fonts.gstatic.com` `/s/*`, with a fixed User-Agent, no redirects, and bounded size and time. What it fetches goes into an append-only, content-addressed cache that is never overwritten or deleted. Each revision records every URL it used in its font lock (URL, status, and SHA-256), so a later render of the same revision receives the same bytes without contacting Google.

| Surface | Stylesheet written in HTML or CSS | Stylesheet the widget adds at runtime | Font files |
| --- | --- | --- | --- |
| Hosted editor preview | Turned into `data:` CSS on the server | Held back by the frame and resolved through the editor, whose key never enters the iframe | `/api/fonts/v1/f/<file>`, a public route that only reads the cache |
| Hosted render or test job | Answered from the job's font files with `route.fulfill` | The same; a URL outside them starts a discovery pass | The same |
| Local CLI | Blocked with `FONT_UNAVAILABLE` and a hint to use the hosted Studio | Blocked the same way | Blocked |

Render and test Sandboxes stay `deny-all`: a job carries the fonts its revision is known to use. When the widget asks for a URL outside them, that pass runs every timeline without screenshots or encoding and collects each missing URL; the workflow fetches them through the proxy and runs the job again, at most four passes (`Fetching Google Fonts (pass n/4)`), and then fails with `FONT_DISCOVERY_LIMIT`. Saving a revision prewarms the cache with the URLs it can already know: static links, and links whose placeholders the defaults, themes, and scenes fill. A prewarm failure is only a warning in the revision's `diagnostics`.

The manifest of a hosted render and the report of a hosted test carry `fonts`: the cache `epoch` and `userAgent`, what the job `served` (URL, status, SHA-256, and bytes), a `servedDigest` over it, and the font `issues`. The codes:

- `FONT_UNAVAILABLE`: a font is needed, is not cached, and cannot be fetched now (Google is down or the daily budget is spent), or the run is local. Retry the hosted job later.
- `FONT_SETTLE_TIMEOUT`: stylesheets or faces did not settle within the real-time deadline; the message names what was still pending.
- `FONT_UNSUPPORTED`: a URL outside the allowlist, such as `/icon` or `text=` built at runtime.
- `FONT_DISCOVERY_LIMIT`: four passes, or too little job time left for another; the fonts found so far are kept, so running the job again continues.
- `upstream-4xx` is a warning, not a failure: Google refused the family, and its text stays in fallback, as in StreamElements.

Known divergences from StreamElements and OBS:

- No flash of unstyled text: captures wait for every face before the frame.
- Geometry is measured with a cold cache: Playwright disables the HTTP cache while routes are active, so a widget that measures text in `document.fonts.ready.then` may compute once with fallback metrics. `settle()` corrects the glyphs, not that geometry.
- In the preview, a Google stylesheet's `cssRules` are readable and its `href` is a `data:` URL underneath, where StreamElements would raise `SecurityError`.
- `/icon` and `text=` stay outside the allowlist: written in HTML or CSS, hosted import copies them into the revision and they render; built at runtime, they fail with `FONT_UNSUPPORTED`.
- The cache keeps a family's CSS from the time it was first fetched, while StreamElements follows Google's updates.

## Known boundary

The emulator does not connect to StreamElements and does not implement undocumented APIs. Synthetic fixtures should model only the data a widget actually consumes. Live StreamElements/OBS checks remain a separate release step.
