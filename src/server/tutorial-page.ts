/**
 * Capture host variant that frames the widget inside a replica of the StreamElements
 * overlay editor. Every visual state is driven by `__SWS_TUTORIAL__.render(timeMs)`;
 * there are no CSS transitions, so each frame is a pure function of the timeline.
 * The editor sits inside `#se-camera`, the tutorial's zoom; captions live in `#se-hud`
 * above it, never scaled, and the cursor layer stays on top.
 * Colors and metrics were measured from the live editor on 2026-09-25. The color picker
 * dialog replicates md-color-picker 0.2.6 as bundled by the editor (Angular Material 1.1.20,
 * the editor's own CSS), measured in a headless reproduction on 2026-09-26 rather than live.
 */
export function renderTutorialPage(frameOrigin: string): string {
  const safeFrameOrigin = frameOrigin.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>SE Widget Studio Tutorial Host</title>
  <style>${TUTORIAL_CSS}</style>
</head>
<body data-frame-origin="${safeFrameOrigin}">
  <main id="capture-stage">
    <div class="se-camera" id="se-camera">
      <div class="se-editor" id="se-editor">
        <header class="se-toolbar" id="se-toolbar"></header>
        <aside class="se-sidebar" id="se-sidebar"></aside>
        <section class="se-canvas" id="se-canvas">
          <div class="se-overlay" id="se-overlay">
            <div id="widget-wrap">
              <iframe id="widget-frame" title="Widget capture" sandbox="allow-scripts allow-same-origin"></iframe>
              <div class="se-widget-box" id="se-widget-box"></div>
            </div>
          </div>
          <div class="se-bottom" id="se-bottom"></div>
          <div class="se-menu-layer" id="se-menu-layer"></div>
          <div class="se-toast" id="se-toast"></div>
        </section>
        <aside class="se-chat" id="se-chat"></aside>
        <div class="se-backdrop-layer" id="se-backdrop-layer"></div>
        <div class="se-popup-layer" id="se-popup-layer"></div>
      </div>
    </div>
    <div class="se-hud" id="se-hud"><div class="se-hud-canvas" id="se-hud-canvas"><div class="se-caption" id="se-caption"></div></div></div>
    <div class="se-cursor-layer" id="se-cursor-layer">
      <div class="se-ripple" id="se-ripple"></div>
      <svg class="se-cursor" id="se-cursor" viewBox="0 0 24 24" aria-hidden="true" data-shape="arrow">
        <path class="arrow" d="M5 2.5v17.2l4.3-4.1 2.8 6.6 3-1.3-2.8-6.5h6z" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
        <path class="cross" d="M12 .5v5.3M12 18.2v5.3M.5 12h5.3M18.2 12h5.3" fill="none" stroke="#fff" stroke-width="3.2"/>
        <path class="cross" d="M12 1.2v4.6M12 18.2v4.6M1.2 12h4.6M18.2 12h4.6" fill="none" stroke="#000" stroke-width="1.3"/>
      </svg>
    </div>
  </main>
  <script type="module" src="/__sws/ui/capture-host.js"></script>
  <script type="module" src="/__sws/ui/tutorial-host.js"></script>
</body>
</html>`;
}

// The packages' unicode ranges (src/studio-ui/fonts/README.md); other scripts fall back to the system font.
const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
/** The editor's Nunito Sans and the chat's Inter ship with the Studio (OFL) and are served at /__sws/ui/fonts/. */
const EDITOR_FONTS = [
  {family: "Nunito Sans Variable", weight: "200 1000", file: "nunito-sans-latin-wght-normal.woff2", range: LATIN},
  {family: "Nunito Sans Variable", weight: "200 1000", file: "nunito-sans-latin-ext-wght-normal.woff2", range: LATIN_EXT},
  {family: "Inter Variable", weight: "100 900", file: "inter-latin-wght-normal.woff2", range: LATIN},
  {family: "Inter Variable", weight: "100 900", file: "inter-latin-ext-wght-normal.woff2", range: LATIN_EXT}
];
export const EDITOR_FONT_FILES: readonly string[] = EDITOR_FONTS.map((font) => font.file);
const FONT_FACES = EDITOR_FONTS.map((font) =>
  `@font-face { font-family: "${font.family}"; font-style: normal; font-weight: ${font.weight}; src: url("/__sws/ui/fonts/${font.file}") format("woff2"); unicode-range: ${font.range}; }`
).join("\n");

const TUTORIAL_CSS = `
${FONT_FACES}
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #020923; }
#capture-stage { position: relative; overflow: hidden; isolation: isolate; background: #c0c0c0; }
/* The tutorial camera. No will-change, so Chrome re-rasterizes text sharply at every zoom; z-index 0 keeps
   it one stacking context below the HUD and the cursor layer whether its transform is none or not. */
.se-camera { position: absolute; inset: 0; z-index: 0; transform-origin: 0 0; }
/* Captions annotate the video: laid out like the editor canvas, above the camera, never scaled by it. */
.se-hud {
  position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; z-index: 15;
  font-family: "Nunito Sans Variable", "Nunito Sans", "Nunito", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px; letter-spacing: 1px; -webkit-font-smoothing: antialiased;
}
.se-hud-canvas { position: absolute; top: 52px; bottom: 0; left: 320px; }
.se-editor {
  --se-navy: #020923; --se-blue: #5787dc; --se-slider: #5771dc; --se-text: rgba(0,0,0,.87);
  --se-muted: rgba(0,0,0,.54); --se-line: rgba(0,0,0,.12); --se-header: #fafafa;
  position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: hidden;
  font-family: "Nunito Sans Variable", "Nunito Sans", "Nunito", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px; letter-spacing: 1px; color: var(--se-text); background: #c0c0c0;
  -webkit-font-smoothing: antialiased;
}
.se-editor svg.i { width: 24px; height: 24px; fill: currentColor; flex: none; display: block; }
.se-toolbar {
  position: absolute; left: 0; top: 0; right: 0; height: 52px; background: var(--se-navy); color: #fff;
  display: flex; align-items: center; padding: 0 8px 0 14px; z-index: 5;
}
.se-toolbar .title {
  margin-left: 13px; width: 420px; height: 30px; font-size: 20px; line-height: 30px; font-weight: 400;
  letter-spacing: 1px; border-bottom: 1px solid rgba(255,255,255,.42); white-space: nowrap; overflow: hidden;
}
.se-toolbar .spacer { flex: 1; }
.se-toolbar .icon-btn { width: 52px; height: 52px; display: grid; place-items: center; color: #fff; }
.se-btn {
  height: 36px; border-radius: 20px; font-size: 12px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase;
  display: inline-grid; place-items: center; padding: 0 6px; white-space: nowrap;
}
.se-btn.ghost { width: 132px; height: 38px; margin-left: 10px; color: var(--se-blue); border: 1px solid var(--se-blue); background: transparent; }
.se-btn.raised { width: 124px; margin-left: 16px; color: #fff; background: var(--se-blue); box-shadow: 0 2px 5px rgba(0,0,0,.26); }
.se-btn.pressed { filter: brightness(.86); }
.se-btn.ghost.pressed { background: rgba(87,135,220,.16); filter: none; }
.se-sidebar {
  position: absolute; left: 0; top: 52px; bottom: 0; width: 320px; background: #fff; z-index: 3;
  box-shadow: 1px 0 0 rgba(0,0,0,.08); overflow: hidden;
}
.se-section {
  height: 43px; display: flex; align-items: center; gap: 12px; padding: 0 12px 0 18px; background: var(--se-header);
  border-bottom: 1px solid var(--se-line); color: rgba(0,0,0,.7); font-weight: 400;
}
.se-section.open { color: var(--se-blue); font-weight: 700; }
.se-section .label { flex: 1; }
.se-section svg.i { color: rgba(0,0,0,.7); }
.se-section.open svg.i { color: var(--se-blue); }
.se-section.pressed { background: #ececec; }
.se-layers-head { height: 48px; display: flex; align-items: center; padding: 0 12px; gap: 16px; }
.se-layers-head .label { flex: 1; font-weight: 700; text-transform: uppercase; color: #000; }
.se-layers-head svg.i { color: rgba(0,0,0,.38); }
.se-layer {
  height: 46px; display: flex; align-items: center; gap: 9px; padding: 0 12px 0 14px; border-bottom: 1px solid var(--se-line);
}
.se-layer svg.i { width: 20px; height: 20px; color: var(--se-muted); }
.se-layer .label { flex: 1; }
.se-layer.selected { background: #dfe8f8; }
.se-layer.pressed { background: #cfdaf1; }
.se-layer .small { width: 16px; height: 16px; }
.se-open-editor { height: 51px; display: grid; place-items: center; }
.se-open-editor .se-btn { width: 125px; color: rgba(255,255,255,.87); background: var(--se-blue); box-shadow: 0 2px 5px rgba(0,0,0,.26); }
.se-group {
  height: 58px; display: flex; align-items: center; gap: 18px; padding: 0 16px; background: var(--se-header);
  color: var(--se-muted); font-weight: 500;
}
.se-group svg.i { color: rgba(0,0,0,.6); }
.se-group.pressed { background: #ececec; }
.se-fields { background: #fff; padding: 12px 0 20px; }
.se-field { position: relative; padding: 0 16px 0 18px; margin-bottom: 26px; }
.se-field .flabel { font-size: 11px; color: var(--se-muted); letter-spacing: .6px; line-height: 16px; }
.se-field .value {
  position: relative; height: 30px; line-height: 30px; font-size: 14px; border-bottom: 1px solid var(--se-line);
  white-space: nowrap; overflow: hidden; width: 276px;
}
.se-field.focused .flabel { color: var(--se-blue); }
.se-field.focused .value { border-bottom: 2px solid var(--se-blue); }
.se-field .sel { background: #b4d5fe; }
.se-caret { display: inline-block; width: 1px; height: 17px; background: #000; vertical-align: -3px; margin-left: 1px; }
.se-field.dropdown .value { padding-right: 24px; }
.se-field.dropdown svg.i { position: absolute; right: 2px; top: 3px; color: var(--se-muted); }
.se-field.color { padding-left: 16px; display: flex; gap: 4px; align-items: flex-end; }
.se-field.color .swatch-wrap { width: 24px; height: 24px; border-radius: 50%; margin-bottom: 4px; overflow: hidden; flex: none;
  border: 2px solid #fff; background-color: #fff;
  background-image: linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%,#ddd),linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%,#ddd);
  background-size: 8px 8px; background-position: 0 0,4px 4px;
  box-shadow: 0 3px 1px -2px rgba(0,0,0,.14), 0 2px 2px 0 rgba(0,0,0,.098), 0 1px 5px 0 rgba(0,0,0,.084); }
.se-field.color .swatch { width: 100%; height: 100%; }
.se-field.color .col { flex: 1; min-width: 0; }
.se-field.color .value { width: 252px; }
.se-field.slider { height: 66px; margin-bottom: 18px; }
.se-field.slider .flabel { position: absolute; left: 18px; top: 14px; font-size: 14px; color: rgba(0,0,0,.54); letter-spacing: 1px; }
.se-field.slider .track { position: absolute; left: 18px; top: 32px; width: 236px; height: 2px; background: rgba(0,0,0,.38); }
.se-field.slider .fill { position: absolute; left: 0; top: 0; height: 2px; background: var(--se-slider); }
.se-field.slider .thumb { position: absolute; top: -6px; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: var(--se-slider); }
.se-field.slider.pressed .thumb { transform: scale(1.35); }
.se-field.slider .num { position: absolute; left: 274px; top: 21px; font-size: 14px; }
.se-field.checkbox { display: flex; align-items: center; gap: 14px; height: 30px; }
.se-field.checkbox .box { width: 18px; height: 18px; border: 2px solid var(--se-muted); border-radius: 2px; display: grid; place-items: center; flex: none; }
.se-field.checkbox .box.on { background: var(--se-slider); border-color: var(--se-slider); }
.se-field.checkbox .box svg.i { width: 16px; height: 16px; color: #fff; }
.se-field.checkbox .flabel { font-size: 14px; color: var(--se-text); letter-spacing: 1px; }
.se-field.media .value { padding-right: 28px; }
.se-field.media svg.i { position: absolute; right: 16px; top: 20px; width: 20px; height: 20px; color: var(--se-muted); }
.se-select-menu {
  position: absolute; background: #fff; border-radius: 2px; padding: 8px 0; min-width: 276px;
  box-shadow: 0 1px 8px rgba(0,0,0,.2), 0 3px 4px rgba(0,0,0,.14), 0 3px 3px -2px rgba(0,0,0,.12);
}
.se-select-menu .opt { height: 48px; line-height: 48px; padding: 0 16px; font-size: 14px; white-space: nowrap; }
.se-select-menu .opt.current { color: var(--se-blue); }
.se-select-menu .opt.hover { background: #eee; }
.se-canvas { position: absolute; top: 52px; bottom: 0; left: 320px; background: #c0c0c0; overflow: hidden; }
.se-overlay {
  position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: hidden; background-color: #d3d3d6;
  background-image: radial-gradient(circle, rgba(118,118,214,.55) 1.7px, transparent 2px);
  background-size: 20px 20px; background-position: 10px 10px;
}
#widget-wrap { position: absolute; left: 50%; top: 50%; }
#widget-frame { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
.se-widget-box {
  position: absolute; inset: calc(-1px * var(--inv, 1)); border: calc(1px * var(--inv, 1)) solid rgba(40,40,48,.7);
  pointer-events: none; font-size: calc(6px * var(--inv, 1)); letter-spacing: 0;
}
.se-widget-box .tag { position: absolute; left: .3em; bottom: .15em; color: rgba(0,0,0,.5); }
.se-widget-box.selected { border-color: rgba(120,150,230,.85); }
.se-widget-box .dims { position: absolute; right: .2em; top: -1.4em; color: rgba(0,0,0,.65); }
.se-bottom { position: absolute; left: 18px; bottom: 10px; height: 72px; display: flex; align-items: center; }
.se-fab { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; color: #fff; box-shadow: 0 3px 6px rgba(0,0,0,.28); }
.se-fab.add { background: #5a78dd; position: relative; z-index: 2; }
.se-fab.back { background: #eb1c5a; position: absolute; left: 70px; z-index: 1; justify-content: start; padding-left: 6px; }
.se-emulate {
  position: relative; z-index: 3; margin-left: 38px; width: 84px; height: 72px; background: #f4f4f4; border-radius: 8px 0 0 8px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; color: rgba(0,0,0,.72);
  font-size: 12px; letter-spacing: .3px; box-shadow: -1px 2px 6px rgba(0,0,0,.2);
}
.se-emulate.active { color: var(--se-blue); }
.se-emulate.pressed { background: #e4e4e4; }
.se-tools {
  position: relative; z-index: 3; height: 72px; display: flex; background: #fff; border-radius: 0 8px 8px 0;
  box-shadow: 1px 2px 6px rgba(0,0,0,.2); color: #757575;
}
.se-tools .grp { display: flex; align-items: center; gap: 20px; padding: 0 22px; border-left: 1px solid #e0e0e0; }
.se-tools .grp:first-child { border-left: 0; padding-left: 26px; }
.se-tools .off { color: #bdbdbd; }
.se-menu-layer { position: absolute; inset: 0; z-index: 6; pointer-events: none; }
.se-emu { position: absolute; width: 204px; }
.se-emu .live {
  height: 44px; background: #fde5e8; display: flex; align-items: center; gap: 8px; padding: 0 14px; font-size: 13px; letter-spacing: .8px;
  line-height: 18px; margin-bottom: 1px;
}
.se-emu .live b { color: #d1124c; font-weight: 700; }
.se-emu .live .cb { width: 16px; height: 16px; border-radius: 2px; border: 2px solid rgba(0,0,0,.54); display: grid; place-items: center; flex: none; }
.se-emu .live .cb.on { background: var(--se-slider); border-color: var(--se-slider); }
.se-emu .live .cb svg.i { width: 14px; height: 14px; color: #fff; }
.se-emu .card, .se-emu .sub {
  background: #fff; border-radius: 4px; padding: 6px 0; box-shadow: 0 2px 8px rgba(0,0,0,.2);
}
.se-emu .row { height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 14px; font-size: 14px; letter-spacing: .4px; white-space: nowrap; }
.se-emu .row svg.i { width: 16px; height: 16px; color: #111; }
.se-emu .row .grow { flex: 1; }
.se-emu .row .chev { width: 14px; height: 14px; color: rgba(0,0,0,.35); }
.se-emu .row.hover { background: #f5f5f5; color: var(--se-blue); }
.se-emu .row.hover svg.i:not(.chev) { color: var(--se-blue); }
.se-emu .row.pressed { background: #e6ecf8; }
.se-emu .sub { position: absolute; left: 204px; top: 45px; width: 160px; border-radius: 0 4px 4px 0; }
.se-emu .sub .row { padding: 0 14px; }
.se-caption {
  position: absolute; left: 50%; bottom: 104px; transform: translateX(-50%); max-width: 78%;
  background: rgba(8,11,22,.9); color: #fff; font-size: 22px; line-height: 1.35; letter-spacing: .2px; font-weight: 600;
  padding: 14px 24px; border-radius: 14px; text-align: center; box-shadow: 0 8px 28px rgba(0,0,0,.28); display: none; z-index: 4;
}
.se-toast {
  position: absolute; left: 24px; bottom: 96px; background: #323232; color: #fff; padding: 14px 24px; border-radius: 4px;
  font-size: 14px; letter-spacing: .4px; display: none; z-index: 7; box-shadow: 0 3px 8px rgba(0,0,0,.3);
}
.se-chat {
  position: absolute; top: 52px; bottom: 0; right: 0; width: 340px; background: #18181b; color: #efeff1; display: none;
  flex-direction: column; font-family: "Inter Variable", Inter, "Helvetica Neue", Helvetica, Arial, sans-serif; letter-spacing: 0; z-index: 3;
  border-left: 1px solid #2f2f35;
}
.se-chat .head { height: 50px; flex: none; display: grid; place-items: center; font-size: 13px; font-weight: 600; letter-spacing: .6px;
  text-transform: uppercase; border-bottom: 1px solid #2f2f35; }
.se-chat .log { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden; padding: 10px 0; }
.se-chat .msg { padding: 5px 20px; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.se-chat .msg .badge { display: inline-block; width: 18px; height: 18px; border-radius: 3px; vertical-align: -4px; margin-right: 3px; }
.se-chat .msg .name { font-weight: 700; }
.se-chat .compose { flex: none; padding: 10px 10px 12px; }
.se-chat .input {
  height: 40px; border-radius: 6px; background: #2f2f35; border: 2px solid transparent; padding: 0 10px; line-height: 36px;
  font-size: 13px; color: #efeff1; white-space: nowrap; overflow: hidden;
}
.se-chat .input.focus { border-color: #a970ff; background: #000; }
.se-chat .input .ph { color: #adadb8; }
.se-chat .input .se-caret { background: #efeff1; height: 16px; }
.se-chat .actions { display: flex; justify-content: flex-end; margin-top: 10px; }
.se-chat .send { height: 30px; padding: 0 10px; border-radius: 4px; background: #9147ff; color: #fff; font-size: 13px; font-weight: 600; line-height: 30px; }
.se-chat .send.pressed { background: #772ce8; }
.se-backdrop-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 8; }
/* Popups anchor to the editor, and the pointer's hit test sees through the layer to the editor, not to its popups. */
.se-popup-layer { position: absolute; inset: 0; z-index: 10; pointer-events: none; }
.se-popup-layer > * { pointer-events: auto; }
.se-cp-backdrop { position: absolute; left: 0; top: 0; background: #212121; }
.se-cp {
  position: absolute; width: 347px; height: 445px; background: #fff; color: rgba(0,0,0,.87); border-radius: 4px; overflow: hidden;
  transform-origin: 50% 50%;
  box-shadow: 0 7px 8px -4px rgba(0,0,0,.2), 0 13px 19px 2px rgba(0,0,0,.14), 0 5px 24px 4px rgba(0,0,0,.12);
}
.se-cp-head, .se-cp-alpha {
  background-color: #fff;
  background-image: linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%,#ddd),linear-gradient(45deg,#ddd 25%,transparent 25%,transparent 75%,#ddd 75%,#ddd);
  background-size: 8px 8px; background-position: 0 0,4px 4px;
}
.se-cp-head { position: absolute; left: 0; top: 0; width: 347px; height: 91px; overflow: hidden; color: #eee; }
.se-cp-head.dark { color: #333; }
.se-cp-result { position: absolute; inset: 0; }
.se-cp-value { position: absolute; left: 0; width: 347px; height: 63px; display: grid; place-items: center; font-size: 18px; font-weight: 400;
  letter-spacing: 1px; white-space: nowrap; }
.se-cp-value span { display: inline-block; line-height: 24px; }
.se-cp-value .sel { background: rgba(128,188,254,.6); }
.se-cp-types { position: absolute; left: 0; top: 63px; width: 347px; height: 28px; overflow: hidden; }
.se-cp-types span { position: absolute; top: 0; height: 28px; padding-top: 2px; text-align: center; font-size: 13px; line-height: 24px; font-weight: 500;
  letter-spacing: 1.3px; text-transform: uppercase; background: rgba(255,255,255,.25); }
.se-cp-head.dark .se-cp-types span { background: rgba(0,0,0,.25); }
.se-cp-types span.on, .se-cp-head.dark .se-cp-types span.on { background: transparent; font-weight: 600; }
.se-cp-types .ink { position: absolute; bottom: 0; height: 2px; background: rgba(255,255,255,.5); }
.se-cp-head.dark .se-cp-types .ink { background: rgba(0,0,0,.5); }
.se-cp-body { position: absolute; left: 8px; top: 99px; width: 331px; height: 255px; }
.se-cp-spectrum, .se-cp-hue, .se-cp-alpha { position: absolute; top: 0; height: 255px; overflow: hidden; }
.se-cp-spectrum { left: 0; width: 255px; }
.se-cp-hue { left: 263px; width: 30px;
  background: linear-gradient(to bottom, #f00 1%, #f0f 16.7%, #00f 33.3%, #0ff 50%, #0f0 66.6%, #ff0 82.8%, #f00 99.9%); }
.se-cp-alpha { left: 301px; width: 30px; }
.se-cp-alpha .fill { position: absolute; inset: 0; }
.se-cp .mk { position: absolute; border: 2px solid #fff; box-shadow: 0 0 2px 0 rgba(0,0,0,.5); }
.se-cp-spectrum .mk { width: 11px; height: 11px; border-radius: 50%; box-shadow: 0 0 2px 0 rgba(0,0,0,.5), inset 0 0 2px 0 rgba(0,0,0,.5); }
.se-cp-hue .mk, .se-cp-alpha .mk { left: 0; width: 100%; height: 5px; border-left: 0; border-right: 0; }
.se-cp-spectrum .grab { position: absolute; width: 1px; height: 1px; }
.se-cp-panes { position: absolute; left: 0; top: 361px; width: 347px; height: 36px; overflow: hidden; }
.se-cp-panes span { position: absolute; top: 0; width: 69.8px; height: 36px; background: rgba(0,0,0,.075); color: rgba(0,0,0,.54); }
.se-cp-panes span.on { background: #fff; color: var(--se-blue); }
.se-cp-panes svg.i { position: absolute; left: 24px; top: 7.8px; }
.se-cp-panes b { position: absolute; left: 56px; top: 7px; font-size: 13px; line-height: 24px; font-weight: 400; letter-spacing: 0; color: rgba(0,0,0,.54); }
.se-cp-panes span.on b { color: var(--se-blue); }
.se-cp-panes .ink { position: absolute; left: 0; bottom: 0; width: 70px; height: 2px; background: var(--se-blue); }
.se-cp-actions { position: absolute; left: 0; top: 397px; width: 347px; height: 48px; }
.se-cp-btn { position: absolute; top: 6px; width: 157.5px; height: 36px; border-radius: 20px; overflow: hidden; text-align: center;
  font-size: 12px; line-height: 36px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: rgba(0,0,0,.87); }
.se-cp-anchor { position: absolute; }
.se-cp-btn .ink { position: absolute; left: 50%; top: 50%; width: 162px; height: 162px; border-radius: 50%; background: #000; }
.se-cursor-layer { position: absolute; inset: 0; pointer-events: none; z-index: 20; }
.se-cursor { position: absolute; left: 0; top: 0; width: 28px; height: 28px; transform-origin: 5px 2.5px;
  filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
.se-cursor .cross { display: none; }
.se-cursor[data-shape="crosshair"] .arrow { display: none; }
.se-cursor[data-shape="crosshair"] .cross { display: inline; }
.se-ripple { position: absolute; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
  background: rgba(87,135,220,.35); border: 2px solid rgba(87,135,220,.8); opacity: 0; }
.se-ripple.ring { background: transparent; }
`;
