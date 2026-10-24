/**
 * The read-only half of the page script that moves a sold widget's overlay to a new commit in the real StreamElements
 * overlay editor (references/se-editor-update.md). It never clicks, types, focuses, or writes code, so it runs before
 * the owner approves the update and again after the reload that checks the Save. `se-editor-update.js` adds the
 * functions that write.
 *
 * Paste this file into an agent's page-script tool (or the DevTools console) on
 * `https://streamelements.com/overlay/<id>/editor`, then call, in the same or a later call:
 *
 *   seEditor.use(<the JSON se-editor-plan.mjs printed>)
 *   seEditor.layers()          // the layer names
 *   await seEditor.canvas()    // for each widget in the canvas: its JS and CSS are the old commit's, the new one's, or other
 *   seEditor.labels()          // each new FIELDS label in the field panel: shown whole, or cut
 *
 * Every call evaluates to a JSON string. It refuses a page that is not a StreamElements overlay editor, so it never
 * runs on the Studio's private editor, and it reads no input's value: one of them is the overlay's link for OBS, with
 * its key.
 */
(() => {
  const VERSION = 1;
  const TABS = ['html', 'css', 'js', 'fields'];
  const HEX = /^[0-9a-f]{64}$/;
  const out = (result) => JSON.stringify(result);
  if (location.hostname !== 'streamelements.com' || !/^\/overlay\/[0-9a-f]{24}\/editor\/?$/.test(location.pathname)) {
    return out({ok: false, error: 'This page is not a StreamElements overlay editor. Nothing was defined.'});
  }
  const api = globalThis.seEditor && globalThis.seEditor.version === VERSION ? globalThis.seEditor : {version: VERSION, state: {}};
  globalThis.seEditor = api;

  const short = (hash) => (typeof hash === 'string' ? hash.slice(0, 12) : hash);
  const sha256 = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  // StreamElements reformats FIELDS when it saves and drops the final newline, so FIELDS compare as parsed JSON; HTML,
  // CSS, and JS come back byte for byte. FIELDS that do not parse hash to null, which matches nothing.
  const tabHash = async (tab, text) => {
    if (tab !== 'fields') return sha256(text);
    let normalized;
    try {
      normalized = JSON.stringify(JSON.parse(text));
    } catch {
      return null;
    }
    return sha256(normalized);
  };
  const plan = () => api.state.plan;
  // A tab whose code is the same in both commits reads NEW.
  const status = (expect, hash) => (hash === expect.new ? 'NEW' : hash === expect.old ? 'OLD' : 'OTHER');
  const visible = (el) => el.getClientRects().length > 0;
  const noPlan = {ok: false, error: 'Call seEditor.use(plan) first, with the JSON se-editor-plan.mjs printed.'};

  const use = (input) => {
    let given = input;
    try {
      if (typeof input === 'string') given = JSON.parse(input);
    } catch {
      given = undefined;
    }
    if (!given || given.version !== 1 || !given.tabs || typeof given.tabs !== 'object') {
      return {ok: false, error: 'Pass the JSON se-editor-plan.mjs printed.'};
    }
    const extra = Object.keys(given.tabs).filter((tab) => !TABS.includes(tab));
    if (extra.length) return {ok: false, error: `The plan names ${extra.join(', ')}: only ${TABS.join(', ')} are written, never DATA.`};
    const tabs = {};
    for (const tab of TABS) {
      const expect = given.tabs[tab];
      if (!expect || typeof expect.file !== 'string' || !expect.file || !HEX.test(expect.old) || !HEX.test(expect.new)) {
        return {ok: false, error: `The plan's ${tab} tab needs a file and the old and new SHA-256.`};
      }
      tabs[tab] = Object.freeze({file: expect.file, old: expect.old, new: expect.new});
    }
    const labels = Array.isArray(given.labels) ? given.labels.filter((label) => typeof label === 'string') : [];
    api.state.plan = Object.freeze({from: String(given.from || ''), to: String(given.to || ''), tabs: Object.freeze(tabs), labels});
    api.state.files = undefined;
    return {
      ok: true,
      from: api.state.plan.from.slice(0, 7),
      to: api.state.plan.to.slice(0, 7),
      changing: TABS.filter((tab) => tabs[tab].old !== tabs[tab].new),
      labels
    };
  };

  const layers = () => {
    const names = [...document.querySelectorAll('.widget-layers-list-item--name')].map((el) => el.textContent.trim());
    const twice = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
    if (!names.length) return {ok: false, error: 'No layer is listed: open the Layers section.'};
    return twice.length ? {ok: true, layers: names, duplicates: twice} : {ok: true, layers: names};
  };

  // Each custom widget in the canvas is a sandboxed blob: iframe whose document holds the widget's CSS in a <style>
  // and its JS in a <script>, as the editor last applied them (saved, or applied by Done and not saved yet).
  const canvasState = async () => {
    const current = plan();
    if (!current) return noPlan;
    const widgets = [];
    for (const frame of document.querySelectorAll('iframe')) {
      if (!frame.src.startsWith('blob:')) continue;
      let doc;
      try {
        doc = new DOMParser().parseFromString(await (await fetch(frame.src)).text(), 'text/html');
      } catch {
        widgets.push({js: 'UNREADABLE', css: 'UNREADABLE'});
        continue;
      }
      const match = async (selector, tab) => {
        let found = 'OTHER';
        for (const el of doc.querySelectorAll(selector)) {
          const result = status(current.tabs[tab], await sha256(el.textContent));
          if (result === 'NEW') return 'NEW';
          if (result === 'OLD') found = 'OLD';
        }
        return found;
      };
      widgets.push({js: await match('script', 'js'), css: await match('style', 'css')});
    }
    const count = (tab) => {
      const counts = {NEW: 0, OLD: 0, OTHER: 0, UNREADABLE: 0};
      for (const widget of widgets) counts[widget[tab]] += 1;
      return counts;
    };
    return {
      ok: widgets.length > 0 && widgets.every((widget) => widget.js === 'NEW' && widget.css === 'NEW'),
      widgets: widgets.length,
      js: count('js'),
      css: count('css'),
      each: widgets
    };
  };

  // The box a label's text is laid out in: the leaf itself, or its first ancestor that is not inline.
  const box = (el) => {
    let current = el;
    while (current.parentElement && getComputedStyle(current).display === 'inline') current = current.parentElement;
    return current;
  };

  const labels = (texts) => {
    const wanted = Array.isArray(texts) ? texts : plan() ? plan().labels : [];
    const panel = [...document.querySelectorAll('.widget-form')].find(visible);
    if (!panel) return {ok: false, error: 'No field panel is shown: select a custom widget layer and open its Settings.'};
    const edge = panel.getBoundingClientRect().right;
    const leaves = [...panel.querySelectorAll('*')].filter((el) => el.children.length === 0);
    const results = wanted.map((text) => {
      const matches = leaves.filter((el) => el.textContent.trim() === text);
      if (!matches.length) return {text, status: 'not found'};
      const shown = matches.filter(visible);
      if (shown.length) {
        for (const leaf of shown) {
          const range = document.createRange();
          range.selectNodeContents(leaf);
          const outer = box(leaf);
          if (outer.scrollWidth > outer.clientWidth + 1 || range.getBoundingClientRect().right > edge + 1) {
            return {text, status: 'cut', width: outer.scrollWidth, room: outer.clientWidth};
          }
        }
        return {text, status: 'whole'};
      }
      // A label inside a closed group has no box: its width on one line, against the panel's, is only an estimate.
      const copy = matches[0].cloneNode(true);
      copy.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;width:auto;max-width:none';
      panel.appendChild(copy);
      const width = copy.scrollWidth;
      copy.remove();
      return {text, status: width <= panel.clientWidth ? 'closed group, fits' : 'closed group, too wide', width, room: panel.clientWidth};
    });
    const overflow = panel.scrollWidth > panel.clientWidth;
    return {
      ok: !overflow && results.every((result) => result.status === 'whole' || result.status === 'closed group, fits'),
      panel: {overflow, scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth},
      labels: results
    };
  };

  api.core = {TABS, plan, short, sha256, tabHash, status, canvasState, noPlan};
  api.use = (input) => out(use(input));
  api.layers = () => out(layers());
  api.canvas = async () => out(await canvasState());
  api.labels = (texts) => out(labels(texts));
  return out({ok: true, version: VERSION, calls: ['use(plan)', 'layers()', 'await canvas()', 'labels([texts])']});
})();
