# Local workflow

Use the consumer's exact installed dependency and committed lockfile. Do not recreate the runtime in the widget.

```text
npm exec -- se-widget-studio doctor <widget-root> --json
npm exec -- se-widget-studio validate <widget-root> --json
npm exec -- se-widget-studio dev <widget-root>
npm exec -- se-widget-studio test <widget-root> --json
npm exec -- se-widget-studio capture <widget-root> --scene <id>
npm exec -- se-widget-studio record <widget-root> --scene <id>
npm exec -- se-widget-studio render <widget-root> --recipe <id> --dry-run
```

Check each command's current `--help` before selecting flags. Start an interactive server only when the user wants a preview or when a browser check is required. Bind to loopback unless the user explicitly authorizes a wider interface.

Before rendering a matrix, report its variant, frame, and target counts from the dry run. `--allow-large-matrix` and `--allow-large-render` require deliberate workload review. If FFmpeg is unavailable, report the numbered PNG sequence and `frames.json` intermediate offered by the CLI; do not download a media tool implicitly.

Inspect final images/video and provenance. Report exact commands and output paths. Local Studio validation covers its documented bridge and partial `SE_API`, not undocumented StreamElements payloads or OBS parity.
