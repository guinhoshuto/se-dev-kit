# Local workflow

Local mode is for developing or debugging SE Widget Studio itself, or for a local render the user explicitly asked for. Widget tests and media generation use hosted mode by default.

The local CLI blocks Google Fonts and fails with `FONT_UNAVAILABLE`; validate a widget that depends on them in hosted mode. Do not reintroduce `--allow-google-fonts`.

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

  Run the checkout with Node 24, its `.node-version`. On the Studio's Mac the default `node` is 26, which is outside `engines`: use `/opt/homebrew/opt/node@24/bin/node` for `npm` and the CLI there, or put `/opt/homebrew/opt/node@24/bin` first in `PATH`.

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
<cli> render <widget-root> --recipe <id> --recipe <id>   # or --all: one process, one browser
```

Check each command's current `--help` before selecting flags. Run `doctor` first. With a Studio checkout, it also reports the engine build that render manifests will record (`studio.commit`, `studio.dirty`, and `studio.cliFlags`, the command-line options, with path values as `<path>`) and warns with `BUILD_DIRTY`, `BUILD_STALE`, or `BUILD_UNKNOWN` when that build has uncommitted changes, is older than the checkout, or names no commit: rebuild before a render whose provenance matters. It reports a Node.js version outside `>=22.20 <23` or `>=24 <25` as an error and exits with code 1, and `capture`, `record`, and `render` refuse to start on one with `NODE_UNSUPPORTED`, because renders on Node 26 have hung while the browser launched or closed. Switch to Node 24; pass `--allow-unsupported-node` only when the user accepts that risk, and say so in the report. It also warns with `BROWSER_NO_H264` when the detected browser is a Chromium build and the catalog uses MP4/MOV video, which would fail to load there and fail the capture: pass Google Chrome with `--browser-path`, or use WebM test media. The hosted client starts no browser, so this check applies only to local work. Start an interactive server only when the user wants a preview or when a browser check is required. Bind to loopback unless the user explicitly authorizes a wider interface.

Run one local render at a time on the machine, counting other sessions: `capture`, `record`, and `render` wait for the machine-wide render slot (`~/.cache/render-slot`, shared with background-creator), print `Waiting for the render slot, held by …` to stderr while another render holds it, and fail with `RENDER_SLOT_TIMEOUT` after 30 minutes; `--dry-run` does not wait. A headless Chrome or Remotion render from a tool that does not take the slot is not covered: before a local render, `node <checkout>/scripts/wait-free.mjs` waits, up to 30 minutes, until the machine check on this machine (`~/obsidian/AI/scripts/maquina_livre.py`: other renders, the slot, the game, free memory and disk) says the machine is free, or, where it is missing, for the slot and for those. Render several recipes in one `render` call rather than one process each. Without `--json`, a render prints a timestamped line per phase to stderr, so a render that stops names its phase: quote that line. A browser that does not start within 30 s fails with `BROWSER_LAUNCH_TIMEOUT`; one that does not close within 10 s is killed, and the CLI still exits with the render's result.

Before rendering a matrix, report its variant, frame, and target counts from the dry run, together with its disk estimate: `plan.disk.summary` gives the estimated peak of the files this render writes, the free space on the output volume, and the 70% limit. It does not count the browser profile, system swap, or other processes, so also check overall free space before a long render on a tight machine. The CLI refuses a render above that limit with `OUTPUT_DISK_LOW`. `--allow-large-matrix`, `--allow-large-render`, and `--allow-low-disk` require deliberate workload review. After a validated encode the CLI deletes the PNG frames and `frames.json`, and the manifest keeps their hashes (`frameSequence`, `framesRetained: false`); pass `--keep-frames` only when the user wants to inspect or post-process frames (loop cuts, posters, stills, a higher-quality re-encode). `plan.targets` includes those temporary frames; report final paths from the render's `artifacts` or the manifest. If FFmpeg is unavailable, report the numbered PNG sequence and `frames.json` intermediate offered by the CLI; do not download a media tool implicitly. On `OUTPUT_DISK_FULL`, relay the message: it says what finished, what remains, and which partial frame folder is left. Leave that folder for the user to delete; do not remove it yourself.

Built-in `sws-sample:` references (see [catalog-authoring.md](catalog-authoring.md#sample-media)) work in `dev`, `capture`, `record`, `test`, and `render`, and `validate` reports unknown ones; the `dev` UI lists them in the stage background menu and in image fields. Inspect final images/video and provenance. Report exact commands and output paths. Local Studio validation covers its documented bridge and partial `SE_API`, not undocumented StreamElements payloads or OBS parity.

## Develop SE Widget Studio itself

- Confirm what the user means before changing code. A new "mode" usually means a video mode (`outputs.video.mode`, currently `stage` or `tutorial`), but it can also mean an editor view or a CLI command; it never means a third operating mode of this skill. Ask when the request does not say.
- Work in the user's Studio checkout and follow its `AGENTS.md`, including `npm run typecheck`, `npm test`, and `npm run build`, and add tests for the new behavior.
- Exercise the change on the checkout's own `examples/` widgets through `node <checkout>/dist/cli/index.js`.
- To exercise the hosted path before a deployment, run `npm run dev` in the checkout (loopback, local storage, local job worker) and pass `--origin http://127.0.0.1:3000` to the hosted client. Production has the change only after it is deployed.
