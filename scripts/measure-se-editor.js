/**
 * Measures the live StreamElements overlay editor for the tutorial replica (`docs/tutorial-reference/`).
 *
 * Read only: it reads computed styles and layout boxes and never clicks, types, focuses, or dispatches
 * anything. Run it on a test overlay only, never on an overlay that is sold or on stream:
 *
 * 1. Open `https://streamelements.com/overlay/<test-overlay-id>/editor` in a 1440x756 window
 *    (the 2026-09-25 viewport; other sizes still run, and the result says so).
 * 2. For `view: "layers"`, leave the Layers section open with the widget layer listed. For
 *    `view: "settings"`, select the layer and open Settings yourself; the script does not.
 * 3. Paste this file into the DevTools console (or an agent's page-script tool), preceded by
 *    `globalThis.SE_MEASURE = {testOverlayId: "<id>", view: "layers"};`. It evaluates to the JSON.
 *
 * It refuses any page that is not the editor of `testOverlayId`. The output leaves out the overlay id
 * and the query string, so it can be committed as `docs/tutorial-reference/<date>-<view>.json`.
 */
(() => {
  const STYLE_KEYS = [
    'backgroundColor', 'color', 'fontSize', 'fontWeight', 'letterSpacing',
    'textTransform', 'borderRadius', 'borderTop', 'borderBottom'
  ];

  // Selector probes run in both views. A selector matching several elements reads the first one with a
  // layout box, then the first one.
  const SELECTORS = [
    ['toolbar', '.overlay-editor__toolbar'],
    ['title', '.overlay-editor__toolbar-actions__rename'],
    ['previewButton', '.overlay-editor__toolbar-actions__preview'],
    ['saveButton', '.overlay-editor__toolbar .md-raised.md-primary'],
    ['sidebar', 'md-sidenav'],
    ['editorBackground', '.editor'],
    ['overlay', '.overlay'],
    ['groupHeader', '.md-subheader'],
    ['sliderTrackFill', 'md-slider .md-track-fill'],
    ['sliderTrack', 'md-slider .md-track'],
    ['sliderThumb', 'md-slider .md-thumb'],
    ['checkboxIcon', 'md-checkbox .md-icon'],
    ['switchThumb', 'md-switch .md-thumb'],
    ['switchBar', 'md-switch .md-bar'],
    ['colorPreview', '.md-color-picker-preview']
  ];

  // Point probes read whatever is drawn at a 1440x756 viewport point, so they only mean something in
  // the view they were taken in.
  const POINTS = {
    layers: [
      ['menuIcon', 28, 25],
      ['canvas', 800, 120],
      ['sectionLayersOpen', 160, 72],
      ['layersHead', 40, 116],
      ['layersHeadIcon', 176, 116],
      ['layerRowName', 80, 162],
      ['layerRowIcon', 20, 162],
      ['layerDivider', 160, 184]
    ],
    settings: [
      ['sectionLayersClosed', 160, 76],
      ['sectionSettingsOpen', 160, 119],
      ['openEditorButton', 163, 165],
      ['groupHeaderText', 200, 219],
      ['selectValue', 60, 270],
      ['fieldRow', 296, 295]
    ]
  };

  const config = globalThis.SE_MEASURE || {};
  const fail = (message) => JSON.stringify({error: message}, null, 2);
  if (typeof config.testOverlayId !== 'string' || !/^[0-9a-f]{24}$/.test(config.testOverlayId)) {
    return fail('Set globalThis.SE_MEASURE = {testOverlayId: "<24-hex test overlay id>", view: "layers" | "settings"} first.');
  }
  if (!Object.hasOwn(POINTS, config.view)) return fail('view must be "layers" or "settings".');
  if (location.hostname !== 'streamelements.com' || location.pathname !== `/overlay/${config.testOverlayId}/editor`) {
    return fail('This page is not the editor of the test overlay. Nothing was read.');
  }

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
  };
  const style = (el) => {
    const s = getComputedStyle(el);
    return Object.fromEntries(STYLE_KEYS.map((key) => [key, s[key]]));
  };
  const read = (el) => ({tag: el.tagName, rect: box(el), style: style(el)});

  const probes = {};
  for (const [id, selector] of SELECTORS) {
    const all = [...document.querySelectorAll(selector)];
    const el = all.find((node) => node.getBoundingClientRect().width > 0) || all[0];
    probes[id] = el ? {selector, ...read(el)} : {selector, missing: true};
  }
  const overlay = document.querySelector('.overlay');
  if (overlay) probes.overlay.inlineStyle = overlay.style.cssText;
  const thumb = document.querySelector('md-slider .md-thumb');
  if (thumb) {
    const after = getComputedStyle(thumb, '::after');
    probes.sliderThumb.after = {backgroundColor: after.backgroundColor, width: after.width};
  }
  const preview = probes.colorPreview;
  if (!preview.missing) {
    const el = [...document.querySelectorAll('.md-color-picker-preview')].find((node) => node.getBoundingClientRect().width > 0);
    if (el) preview.backgroundSize = getComputedStyle(el).backgroundSize;
  }
  for (const [id, x, y] of POINTS[config.view]) {
    const el = document.elementFromPoint(x, y);
    probes[id] = el ? {point: [x, y], ...read(el)} : {point: [x, y], missing: true};
  }

  return JSON.stringify({
    schemaVersion: 1,
    measuredAt: new Date().toISOString().slice(0, 10),
    source: 'scripts/measure-se-editor.js on a test overlay',
    view: config.view,
    viewport: {width: innerWidth, height: innerHeight},
    viewportMatchesReference: innerWidth === 1440 && innerHeight === 756,
    fontFamily: getComputedStyle(document.body).fontFamily,
    probes
  }, null, 2);
})();
