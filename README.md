# SE Widget Studio

SE Widget Studio is a standalone local workbench for developing, testing, and producing media from StreamElements Custom Widgets. It serves the widget's real production HTML, CSS, JavaScript, and FIELDS schema over loopback HTTP, then loads them inside an isolated iframe. It does not copy or rewrite consumer source files.

The Studio provides:

- Automatic detection of the two common StreamElements file layouts.
- An interactive editor generated from the real FIELDS schema.
- Themes, synthetic fixtures, declarative scenes, smoke scenarios, and capture recipes.
- Essential `onWidgetLoad`, `onWidgetUpdate`, and `onEventReceived` simulation.
- Deterministic Playwright screenshots, thumbnails, contact sheets, and PNG video frames.
- Optional FFmpeg conversion and ffprobe validation when those tools are already installed.
- Versioned marketplace presets, including an Etsy profile with official sources and a verification date.
- Stable English CLI output and JSON output for humans, agents, and CI.

## Requirements

- Node.js `>=22.20 <23` or `>=24 <25` (supported LTS lines only).
- npm, using the committed `package-lock.json`.
- A locally installed Chromium-family browser for browser commands.
- Optional FFmpeg and ffprobe for encoded video.

The package depends on `playwright-core`. It never downloads Chromium, FFmpeg, codecs, or fonts. Use `doctor` to see what is already available:

```bash
npm run build
node dist/cli/index.js doctor examples/basic-chat --json
```

If no browser is detected, install a system Chrome/Chromium yourself and pass `--browser-path /absolute/path` or set `SE_WIDGET_STUDIO_BROWSER`. Do not use an unpinned remote `npx ...@latest` command.

## Quick start

From this repository:

```bash
npm ci
npm run build
node dist/cli/index.js validate examples/basic-chat
node dist/cli/index.js dev examples/basic-chat --port 4173
```

From a widget that installs this package as an exact dependency:

```bash
npm exec -- se-widget-studio init .
npm exec -- se-widget-studio validate .
npm exec -- se-widget-studio dev .
```

This repository is currently a private package. For a reproducible consumer install, build a tarball from a reviewed commit and install that exact file:

```bash
# In se-widget-studio
npm ci
npm pack

# In the consumer widget
npm install --save-exact /absolute/path/to/se-widget-studio-0.1.0.tgz
```

The package `prepare` script builds `dist` for exact Git/local installs, and published tarballs include the CLI, library exports, presets, documentation, skill, and example. Record the repository commit and tarball SHA-256 in CI or release notes.

`dev` binds the control and widget servers to `127.0.0.1` by default. It prints the URL instead of opening a browser unless `--open` is explicit.

## Supported widget layouts

The Studio detects exactly one complete layout:

```text
widget.html + widget.css + widget.js + widget.json
index.html  + style.css  + script.js  + fields.json
```

If both are present, configuration must select explicit files. An explicit `se-widget-studio.config.mjs` always takes precedence:

```js
import {defineConfig} from "se-widget-studio";

export default defineConfig({
  schemaVersion: 1,
  widget: {
    root: ".",
    files: {
      html: "widget.html",
      css: "widget.css",
      js: "widget.js",
      fields: "widget.json"
    },
    assets: ["assets/**/*", "fonts/**/*", "media/**/*"],
    viewport: {width: 430, height: 640, deviceScaleFactor: 1},
    ready: {selector: "#chat", timeoutMs: 10_000},
    adapter: "adapters/studio.mjs"
  },
  channel: {username: "streamer"},
  themes: {glob: "themes/*.json"},
  fixtures: {glob: "fixtures/*.json"},
  scenarios: {glob: "scenarios/*.json"},
  scenes: {glob: "scenes/*.json"},
  recipes: {glob: "recipes/*.json"},
  output: {root: ".se-widget-studio/output"}
});
```

All paths are resolved relative to `widget.root` and must remain inside it after `realpath` resolution. `assets` extends the startup allowlist for resources that cannot be discovered from production HTML, CSS, or JavaScript references.

## CLI

Run `se-widget-studio <command> --help` for the installed contract.

| Command | Purpose |
| --- | --- |
| `init [root]` | Create configuration and Studio data directories without changing production files. |
| `doctor [root]` | Detect Node, browser, output, FFmpeg, and ffprobe without installing anything. |
| `list [root]` | List normalized fields and every configured catalog item. |
| `presets` | List versioned marketplace presets and official sources. |
| `validate [root]` | Validate files, schemas, references, safe paths, and synthetic-data rules. |
| `dev [root]` | Start the interactive workbench (`studio` is an alias). |
| `test [root]` | Run deterministic browser scenarios in fresh contexts. |
| `capture [root]` | Capture one scene. |
| `record [root]` | Record one scene as PNG frames and optionally encode video. |
| `render [root] --recipe <id>` | Expand and render a recipe matrix. |

Every command supports `--json` at the program level. Matrix rendering should begin with a dry run:

```bash
se-widget-studio render examples/basic-chat --recipe etsy-listing-images --dry-run --json
se-widget-studio render examples/basic-chat --recipe etsy-listing-video --dry-run --json
```

Matrix cardinality is calculated with integer-safe arithmetic before variants are expanded. The default matrix limit is 48 variants; a larger matrix requires `--allow-large-matrix`.

An independent render-workload guard counts video frames and every planned file before frame paths are created. The default limit is 10,000 planned files. A reviewed dry run or render can opt in with `--allow-large-render`; neither large-render flag can bypass the safe-integer boundary.

## Runtime boundary

The runtime deliberately simulates only the essential local contract:

```js
window.dispatchEvent(new CustomEvent("onWidgetLoad", {
  detail: {fieldData, channel, recents}
}));

window.dispatchEvent(new CustomEvent("onWidgetUpdate", {
  detail: {fieldData}
}));

window.dispatchEvent(new CustomEvent("onEventReceived", {
  detail: {listener, event}
}));
```

The partial `SE_API` implements the documented `store.get/set`, `counters.get`, and `getOverlayStatus` shapes. Local store writes emit a synthetic `kvstore:update`; isolated counters default to zero. Any other method rejects with `SWS_UNSUPPORTED_API` instead of returning a false success. Payloads in fixtures are opaque pass-through JSON; the Studio does not claim they are complete or official StreamElements payloads.

See [Runtime and integration](docs/RUNTIME.md) for the iframe, bridge, adapter, and readiness contracts.

## Data and precedence

FIELDS defaults, themes, fixtures, scenes, and explicit overrides stay separate. `fieldData` is merged shallowly in this order:

```text
FIELDS defaults → theme → fixture → scene → explicit override
```

Stage background, widget viewport, final output, crop, camera transform, and device scale are not inserted into `fieldData`.

Known editor types include text, number, slider, checkbox, dropdown, color/colorpicker, font/Google Font, image, video, and sound inputs. Hidden values remain in `fieldData`. Unknown field definitions remain available through the raw JSON editor.

See [Configuration](docs/CONFIGURATION.md) for catalog schemas.

StreamElements object-form dropdown options use option values as keys and human-readable labels as values, for example `{"compact": "Compact"}`.

## Capture safety and video fallback

The renderer calculates every target before writing. If any exact target exists, it aborts unless `--force` is present. With `--force`, it atomically replaces only those planned regular files. It never recursively clears an output directory, follows an output symlink, or removes unrelated files.

Video starts as deterministic numbered PNG frames plus `frames.json`. When an existing FFmpeg executable is detected, those frames can be encoded. When FFmpeg is missing, the frame sequence remains a documented intermediate and the command exits with code `3` unless `--allow-intermediate` is explicit.

See [Capture and media](docs/CAPTURE.md) for recipes, manifests, FFmpeg behavior, and marketplace profiles.

The example includes separate Etsy image and video recipes because their canvases and output rules differ. Both recipes reference the dated `etsy-listing-2026-08` preset, so its official sources and verification date are copied into each render manifest.

## Security and privacy

- The control UI and widget frame use separate loopback origins.
- The iframe bridge validates the origin, `event.source`, session id, and a 128-bit nonce.
- Widget assets come from a precomputed allowlist; URL paths are never translated directly into filesystem paths.
- Automated contexts are fresh, block service workers, and block non-loopback network requests.
- Config modules, scenario modules, and adapters are trusted local code with Node or browser privileges appropriate to where they run.
- Fixtures containing token, cookie, authorization, webhook, secret, password, or live StreamElements API values fail validation.
- No real messages, identities, cookies, tokens, webhooks, or StreamElements sessions belong in tests or public media.

## Validation boundary

Local Studio validation is not proof of complete StreamElements or OBS parity. For a production widget change, retain a final check in the real StreamElements editor and OBS when available. This repository never promises support for undocumented APIs or payload shapes.

## Repository checks

```bash
npm run typecheck
npm test
npm run validate:example
npm run smoke:example
```

Browser and visual checks require an explicitly available browser. FFmpeg checks are optional and always report whether the final video was probed or only an intermediate was produced.

See [Agent usage](docs/AGENT_USAGE.md) for the same pinned commands in Codex, Claude Code, and CI.
