# Local workflow

Local mode is for developing or debugging SE Widget Studio itself, or for a local render the user explicitly asked for. Widget tests and media generation use hosted mode by default.

## Invoke the CLI

Use a pinned CLI, never an unpinned remote package, and do not recreate the runtime in the widget.

- The consumer's locked dependency, when the widget's `package.json` and lockfile declare `se-widget-studio`:

  ```text
  npm exec -- se-widget-studio <command> <widget-root>
  ```

- A reviewed Studio checkout, when the widget declares no such dependency (most widget repositories have no `package.json`). `dist/` is not versioned, so install and build first, and build again after every source change:

  ```text
  npm ci && npm run build:engine             # inside the checkout
  node <checkout>/dist/cli/index.js <command> <widget-root>
  ```

`<cli>` below stands for either form. The CLI runs without `se-widget-studio.config.mjs` and detects the widget layout. Do not run `init` in a consumer repository: it writes files there, and the config it writes imports `se-widget-studio`, which resolves only when the widget declares that dependency.

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

Check each command's current `--help` before selecting flags. Run `doctor` first. It reports a Node.js version outside `>=22.20 <23` or `>=24 <25` as an error and exits with code 1; say so in the report before any browser or media work, since renders on unsupported versions have been observed to hang while the browser launches or closes. The hosted client starts no browser, so this check applies only to local work. Start an interactive server only when the user wants a preview or when a browser check is required. Bind to loopback unless the user explicitly authorizes a wider interface.

Before rendering a matrix, report its variant, frame, and target counts from the dry run. `--allow-large-matrix` and `--allow-large-render` require deliberate workload review. If FFmpeg is unavailable, report the numbered PNG sequence and `frames.json` intermediate offered by the CLI; do not download a media tool implicitly.

Inspect final images/video and provenance. Report exact commands and output paths. Local Studio validation covers its documented bridge and partial `SE_API`, not undocumented StreamElements payloads or OBS parity.

## Develop SE Widget Studio itself

- Confirm what the user means before changing code. A new "mode" usually means a video mode (`outputs.video.mode`, currently `stage` or `tutorial`), but it can also mean an editor view or a CLI command; it never means a third operating mode of this skill. Ask when the request does not say.
- Work in the user's Studio checkout and follow its `AGENTS.md`, including `npm run typecheck`, `npm test`, and `npm run build`, and add tests for the new behavior.
- Exercise the change on the checkout's own `examples/` widgets through `node <checkout>/dist/cli/index.js`.
- To exercise the hosted path before a deployment, run `npm run dev` in the checkout (loopback, local storage, local job worker) and pass `--origin http://127.0.0.1:3000` to the hosted client. Production has the change only after it is deployed.
