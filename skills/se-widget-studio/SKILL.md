---
name: se-widget-studio
description: Operate the reusable SE Widget Studio to preview, validate, test, capture, record, and render StreamElements Custom Widgets without creating bespoke local runtimes.
---

# SE Widget Studio

Use the installed, locked Studio package. Do not recreate its runtime inside a consumer widget.

## Establish the contract

1. Inspect repository instructions and the consumer working tree before changing files.
2. Run the installed CLI `--help` and `doctor <widget-root> --json`.
3. Run `validate <widget-root> --json` before preview, test, or media commands.
4. Never install dependencies, browsers, FFmpeg, codecs, or fonts without explicit authorization.
5. Never execute an unpinned remote `@latest` package.

## Work in the right layer

- Keep production widget HTML, CSS, and JavaScript unchanged unless the user requested a widget change.
- Put widget-specific behavior in config, themes, fixtures, scenes, scenarios, recipes, or one narrow adapter.
- Derive defaults from the real FIELDS schema.
- Keep `fieldData` separate from background, viewport, output, camera, crop, and device scale.
- Use only synthetic public-safe identities, messages, timestamps, and media.

## Normal workflow

```text
npm exec -- se-widget-studio doctor <widget-root> --json
npm exec -- se-widget-studio validate <widget-root> --json
npm exec -- se-widget-studio dev <widget-root>
npm exec -- se-widget-studio test <widget-root> --json
npm exec -- se-widget-studio capture <widget-root> --scene <id>
npm exec -- se-widget-studio record <widget-root> --scene <id>
npm exec -- se-widget-studio render <widget-root> --recipe <id> --dry-run
```

Check current `--help` before using flags. Run a recipe dry run before rendering a matrix. Require explicit `--force` before replacing output files. If FFmpeg is absent, report the numbered PNG sequence and frames manifest as an intermediate instead of downloading anything.

## Validation boundary

Inspect generated media and metadata. Report exact paths and commands. Local simulation covers only the Studio's documented bridge and partial `SE_API`; retain real StreamElements and OBS checks for undocumented platform behavior.
