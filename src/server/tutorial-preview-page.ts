/**
 * The dev Studio's tutorial preview: the tutorial host page in a same-origin iframe at its output
 * size, scaled to fit, with a transport bar that drives `__SWS_TUTORIAL__.render(timeMs)` from a
 * scrubber. The host keeps its own layout, so setup measures it exactly as a render does.
 */
export function renderTutorialPreviewPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Tutorial preview · SE Widget Studio</title>
  <style>${PREVIEW_CSS}</style>
</head>
<body>
  <header class="bar">
    <strong>Tutorial preview</strong>
    <label>Recipe <select id="recipe" aria-label="Recipe"></select></label>
    <label>Variant <select id="variant" aria-label="Variant"></select></label>
    <span class="status" id="status" role="status">Loading…</span>
  </header>
  <main class="viewer" id="viewer">
    <div class="fit" id="fit"><iframe id="host" title="Tutorial host"></iframe></div>
  </main>
  <footer class="transport">
    <div class="track">
      <div class="ticks" id="camera-ticks" aria-hidden="true"></div>
      <input id="scrubber" type="range" min="0" max="0" step="1" value="0" aria-label="Time">
      <div class="ticks events" id="event-ticks" aria-hidden="true"></div>
    </div>
    <div class="controls">
      <button id="play" type="button" aria-label="Play">Play</button>
      <button id="back" type="button" aria-label="Previous frame">−1 frame</button>
      <button id="forward" type="button" aria-label="Next frame">+1 frame</button>
      <output id="time">0 ms</output>
      <label class="toggle"><input id="full" type="checkbox"> Full editor (still camera)</label>
      <button id="copy" type="button">Copy --sheet-at</button>
      <span class="hint">Space plays · ←/→ one frame · Shift for 1 s · F full editor</span>
    </div>
    <p class="note">The editor, pointer, camera, and captions are drawn as the render draws them at this time. The widget runs in real time and replays its events on a seek back, so its animations are approximate: use <code>render --sheet-at</code> for exact frames.</p>
  </footer>
  <script type="module" src="/__sws/ui/tutorial-preview.js"></script>
</body>
</html>`;
}

const PREVIEW_CSS = `
:root { color-scheme: dark; --bg: #090c10; --surface: #10151b; --line: #222b35; --text: #e7edf3; --soft: #a2afbb; --muted: #697684; --accent: #45c9ee; --danger: #ff7c86; --event: #e5bd68;
  font: 13px Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); }
body { display: grid; grid-template-rows: auto 1fr auto; }
.bar, .transport { background: var(--surface); border-color: var(--line); border-style: solid; border-width: 0; }
.bar { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom-width: 1px; flex-wrap: wrap; }
.bar label, .toggle { display: flex; align-items: center; gap: 6px; color: var(--soft); }
select, button { font: inherit; color: var(--text); background: #1a222b; border: 1px solid #303b47; border-radius: 6px; padding: 5px 9px; }
button { cursor: pointer; }
button:hover, select:hover { border-color: var(--accent); }
.status { margin-left: auto; color: var(--muted); }
.status[data-kind="error"] { color: var(--danger); white-space: pre-wrap; }
.viewer { position: relative; overflow: hidden; min-height: 0; }
.fit { position: absolute; left: 50%; top: 50%; overflow: hidden; transform-origin: 0 0; box-shadow: 0 0 0 1px var(--line); }
.fit iframe { position: absolute; border: 0; display: block; background: #020923; }
.transport { padding: 10px 16px 12px; border-top-width: 1px; }
.track { position: relative; padding: 6px 0; }
#scrubber { width: 100%; margin: 0; accent-color: var(--accent); }
.ticks { position: relative; height: 8px; margin: 0 8px; }
.ticks i { position: absolute; top: 0; width: 2px; height: 8px; margin-left: -1px; background: var(--accent); opacity: 0.7; }
.ticks.events i { background: var(--event); }
.controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
#time { min-width: 210px; font-variant-numeric: tabular-nums; }
.hint { margin-left: auto; color: var(--muted); }
.note { margin: 8px 0 0; color: var(--muted); }
code { color: var(--soft); }
`;
