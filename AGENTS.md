# Repository instructions

This repository is the shared SE Widget Studio runtime. Keep widget-specific themes, fixtures, scenes, scenarios, recipes, and adapters in consumer widgets.

- Use English for UI text, CLI help, field names, errors, tests, and documentation.
- Preserve strict TypeScript and ESM.
- Do not add React or a consumer bundler requirement.
- Never copy or rewrite consumer production widget files.
- Keep the control UI and widget frame on distinct loopback origins.
- Never weaken path containment, bridge nonce/source/origin validation, external-network blocking, or output preflight.
- Never download browsers, FFmpeg, codecs, or fonts from runtime code.
- Require `--force` for exact output replacement; never recursively clean consumer output directories.
- Keep marketplace rules in dated JSON presets with official URLs.
- Run `npm run typecheck`, `npm test`, `npm run validate:example`, and the proportional browser/media checks after changes.
- Report local simulation separately from real StreamElements/OBS validation.
