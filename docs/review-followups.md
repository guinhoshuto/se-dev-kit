# Review follow-ups

What a review found that does not block its change, so it is not lost in a session's `.cache/`. Each item says where
it came from and what would close it; remove it when it is done.

## Open

- **Four repo scripts keep the entry guard that failed `cut-loop.mjs` through the skill link** (orphan jobs and
  cut-loop, 2026-10-11). `scripts/kill-stale.mjs`, `scripts/run-tests.mjs`, `scripts/mutate.mjs` and
  `scripts/verify-hosted.mjs` run their main only when `argv[1]`, resolved but not real, names the module's real path.
  Through a symlink the two differ and the script exits 0 without doing anything. npm runs them by a path relative to
  the checkout, which resolves against the real working directory, so they work today; one invoked by an absolute
  path through a link would not. To close: the realpath comparison of `isEntryPoint()` in
  `skills/se-widget-studio/scripts/studio-client.mjs`, with a test that runs each one through a link (`mutate.mjs
  --help` can; `kill-stale.mjs` has no harmless mode and needs one first).
