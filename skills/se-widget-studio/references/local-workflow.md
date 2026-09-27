# Local workflow

Local mode is for developing or debugging SE Widget Studio itself, or for a local render the user explicitly asked for. Widget tests and media generation use hosted mode by default.

## Invoke the CLI

Use a pinned CLI, never an unpinned remote package, and do not recreate the runtime in the widget.

- The consumer's locked dependency, when the widget's `package.json` and lockfile declare `se-widget-studio`:

  ```text
  npm exec -- se-widget-studio <command> <widget-root>
  ```

- A reviewed Studio checkout, when the widget declares no such dependency (most widget repositories have no `package.json`). `dist/` is not versioned, so build the engine first and again after every source change:

  ```text
  npm run build:engine                       # inside the checkout
  node <checkout>/dist/cli/index.js <command> <widget-root>
  ```

`<cli>` below stands for either form. A widget without `se-widget-studio.config.mjs` needs `<cli> init <widget-root>` first.

## Commands

```text
<cli> doctor <widget-root> --json
<cli> validate <widget-root> --json
<cli> dev <widget-root>
<cli> test <widget-root> --json
<cli> capture <widget-root> --scene <id>
<cli> record <widget-root> --scene <id>
<cli> render <widget-root> --recipe <id> --dry-run
```

Check each command's current `--help` before selecting flags. Run `doctor` first; if it reports an unsupported Node.js version, say so in the report, because the supported range is `>=22.20 <23` or `>=24 <25` and renders on other versions can hang while the browser launches or closes. Start an interactive server only when the user wants a preview or when a browser check is required. Bind to loopback unless the user explicitly authorizes a wider interface.

Before rendering a matrix, report its variant, frame, and target counts from the dry run. `--allow-large-matrix` and `--allow-large-render` require deliberate workload review. If FFmpeg is unavailable, report the numbered PNG sequence and `frames.json` intermediate offered by the CLI; do not download a media tool implicitly.

Inspect final images/video and provenance. Report exact commands and output paths. Local Studio validation covers its documented bridge and partial `SE_API`, not undocumented StreamElements payloads or OBS parity.
