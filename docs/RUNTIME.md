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
6. Frame waits for `document.fonts.ready`, decoded images, and available video data, then announces `frame:assets-ready`.
7. Frame waits for the configured selector and sends `frame:widget-ready`.
8. The host may send events or field updates.

Host event and field-update commands carry correlation ids. The frame acknowledges each command only after an asynchronous adapter hook and synchronous DOM event dispatch finish; scenarios then continue to their next action. Bridge startup and commands have bounded timeouts.

Field edits dispatch `onWidgetUpdate`. Theme, fixture, or scene changes recreate the iframe to prevent duplicate listeners and stale DOM.

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

The configured production JavaScript file is removed from both fragment and full-document HTML before the in-memory frame is assembled, then loaded exactly once after the runtime is installed. Other inline scripts remain part of the production HTML and may run during parsing; widgets that depend on Studio state should keep runtime code in the configured JavaScript file.

Automated contexts abort every non-loopback HTTP request and every WebSocket. A blocked stylesheet, font, image, media file, or other request is reported as a runtime error instead of silently producing degraded final media. Capture backgrounds must be a local allowlisted widget asset or a data URL and are decoded before readiness.

## Known boundary

The emulator does not connect to StreamElements and does not implement undocumented APIs. Synthetic fixtures should model only the data a widget actually consumes. Live StreamElements/OBS checks remain a separate release step.
