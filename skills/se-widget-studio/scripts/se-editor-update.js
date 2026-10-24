/**
 * The writing half of the page script that moves a sold widget's overlay to a new commit in the real StreamElements
 * overlay editor (references/se-editor-update.md). Paste it after `se-editor-read.js`, in the same tab, and only once
 * the owner approved the update: it selects layers, opens the code editor and its HTML, CSS, JS, and Fields tabs,
 * writes code, and clicks Done. It never clicks Save and never opens or writes the Data tab.
 *
 *   seEditor.attach()                  // a file input, for the browser tool's file upload of the plan's `upload` paths
 *   await seEditor.files()             // the uploaded files, checked against the plan
 *   await seEditor.run(['name', ...])  // each widget in turn: open, check, write, Done, and the canvas shows it
 *
 * or one widget a step at a time: await seEditor.open(name), scan(), apply(), done(). A widget is written only when
 * every code tab holds the old commit's code or the new one's; a tab with any other code stops it with nothing written.
 * Every call evaluates to a JSON string.
 */
(() => {
  const api = globalThis.seEditor;
  const out = (result) => JSON.stringify(result);
  if (!api || api.version !== 1 || !api.core) return out({ok: false, error: 'Paste se-editor-read.js in this tab first.'});
  const {TABS, plan, short, tabHash, status, canvasState, noPlan} = api.core;
  // Each tab's md-nav-item name in the code editor, and the Monaco language of its model.
  const NAV = {html: 'html', css: 'css', js: 'js', fields: 'fields'};
  const LANGUAGE = {html: 'html', css: 'css', js: 'javascript', fields: 'json'};
  const INPUT_ID = 'se-editor-update-files';
  const LABEL = 'se-editor-update files';
  // Timers stall in a background tab (a setTimeout there held a page-script call for 45 s), so every wait is bounded
  // and nothing waits in a hidden tab.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (probe, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value || Date.now() >= end) return value;
      await sleep(50);
    }
  };
  // AngularJS Material keeps the click handler on the <button> it renders inside md-nav-item and md-button.
  const press = (el) => (el.matches('button') ? el : el.querySelector('button') || el).click();
  const dialog = () => document.querySelector('md-dialog.code-editor-dialog');
  const openEditorButton = () => document.querySelector('.custom-event-list-editor-button-container button');
  const hidden = () => (document.visibilityState === 'visible' ? null
    : {ok: false, error: 'The editor tab is in the background, where its timers stall: bring it to the front and call again.'});
  const needFiles = () => (!plan() ? noPlan : api.state.files ? null
    : {ok: false, error: 'Load the new files first: seEditor.attach(), the file upload, then await seEditor.files().'});
  const report = (found) => Object.fromEntries(TABS.map((tab) => {
    const entry = found[tab];
    return [tab, entry.hash ? `${entry.status} ${short(entry.hash)}` : entry.count > 1 ? `${entry.status} (${entry.count} models)` : entry.status];
  }));

  const attach = () => {
    if (!plan()) return noPlan;
    let input = document.getElementById(INPUT_ID);
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.id = INPUT_ID;
      input.setAttribute('aria-label', LABEL);
      input.style.cssText = 'position:fixed;left:0;bottom:0;z-index:2147483647;width:160px;height:24px;opacity:0.01';
      document.body.appendChild(input);
    }
    return {ok: true, label: LABEL, files: TABS.map((tab) => plan().tabs[tab].file)};
  };

  const files = async () => {
    if (!plan()) return noPlan;
    const input = document.getElementById(INPUT_ID);
    if (!input || !input.files || !input.files.length) {
      return {ok: false, error: 'No file was uploaded: call seEditor.attach(), then upload every path in the plan\'s "upload".'};
    }
    const texts = {};
    for (const file of input.files) texts[file.name] = await file.text();
    const checked = {};
    let ok = true;
    for (const tab of TABS) {
      const {file} = plan().tabs[tab];
      const hash = Object.hasOwn(texts, file) ? await tabHash(tab, texts[file]) : undefined;
      checked[file] = hash === undefined ? 'missing' : hash === plan().tabs[tab].new ? 'ok' : `MISMATCH ${short(hash)}`;
      if (checked[file] !== 'ok') ok = false;
    }
    if (ok) {
      api.state.files = Object.freeze(Object.fromEntries(TABS.map((tab) => [tab, texts[plan().tabs[tab].file]])));
      input.remove();
    }
    return {ok, files: checked};
  };

  // Opens each code tab, which creates its Monaco model, and finds the one model of the tab's language whose code is
  // the old commit's or the new one's.
  const inspect = async () => {
    const box = dialog();
    if (!box) return {ok: false, error: 'No code editor is open.'};
    if (typeof monaco === 'undefined') return {ok: false, error: 'The code editor has no Monaco.'};
    const found = {};
    for (const tab of TABS) {
      const item = box.querySelector(`md-nav-item[name="${NAV[tab]}"]`);
      if (!item) return {ok: false, error: `The code editor has no ${tab} tab.`};
      press(item);
      const models = await waitFor(() => {
        const matching = monaco.editor.getModels().filter((model) => model.getLanguageId() === LANGUAGE[tab]);
        return matching.length ? matching : null;
      }, 3000);
      if (!models) {
        found[tab] = {status: 'MISSING'};
        continue;
      }
      const hashed = [];
      for (const model of models) hashed.push({model, hash: await tabHash(tab, model.getValue())});
      const expected = hashed.filter(({hash}) => hash === plan().tabs[tab].old || hash === plan().tabs[tab].new);
      if (expected.length === 1) found[tab] = {status: status(plan().tabs[tab], expected[0].hash), ...expected[0]};
      else if (expected.length > 1) found[tab] = {status: 'AMBIGUOUS', count: expected.length};
      else found[tab] = {status: 'OTHER', hash: hashed.length === 1 ? hashed[0].hash : undefined, count: hashed.length};
    }
    return {ok: true, found};
  };

  const scan = async () => {
    const stop = hidden() || (plan() ? null : noPlan);
    if (stop) return stop;
    const result = await inspect();
    if (!result.ok) return result;
    return {ok: TABS.every((tab) => ['OLD', 'NEW'].includes(result.found[tab].status)), tabs: report(result.found)};
  };

  const apply = async () => {
    const stop = hidden() || needFiles();
    if (stop) return stop;
    const result = await inspect();
    if (!result.ok) return result;
    const {found} = result;
    const unexpected = TABS.filter((tab) => !['OLD', 'NEW'].includes(found[tab].status));
    if (unexpected.length) {
      return {ok: false, tabs: report(found), error: `Unexpected code in ${unexpected.join(', ')}: nothing was written.`};
    }
    const written = [];
    for (const tab of TABS) {
      if (found[tab].status !== 'OLD') continue;
      const {model} = found[tab];
      const before = model.getValue();
      model.setValue(api.state.files[tab]);
      written.push({tab, model, before});
      const after = await tabHash(tab, model.getValue());
      if (after === plan().tabs[tab].new) continue;
      const restored = {};
      for (const entry of written.reverse()) {
        entry.model.setValue(entry.before);
        restored[entry.tab] = (await tabHash(entry.tab, entry.model.getValue())) === plan().tabs[entry.tab].old ? 'restored' : 'NOT RESTORED';
      }
      const left = Object.keys(restored).filter((name) => restored[name] !== 'restored');
      return {ok: false, tabs: report(found), restored,
        error: `The editor changed the ${tab} code as it was written (${short(after)}): `
          + (left.length ? `the tabs written were put back but ${left.join(', ')}, which holds neither commit's code: click neither Done nor Save.`
            : 'the tabs written were put back.')};
    }
    return {ok: true, tabs: Object.fromEntries(TABS.map((tab) => [tab, found[tab].status === 'OLD' ? 'written' : 'already new']))};
  };

  const done = async () => {
    const box = dialog();
    if (!box) return {ok: false, error: 'No code editor is open.'};
    const button = box.querySelector('.exit-code-editor');
    if (!button) return {ok: false, error: 'The code editor has no Done button.'};
    press(button);
    return (await waitFor(() => !dialog(), 3000)) ? {ok: true} : {ok: false, error: 'The code editor did not close after Done.'};
  };

  const open = async (name) => {
    const stop = hidden();
    if (stop) return stop;
    if (dialog()) return {ok: false, error: 'A code editor is already open: close it with seEditor.done() first.'};
    const rows = [...document.querySelectorAll('.widget-layers-list-item--name')].filter((el) => el.textContent.trim() === name);
    if (rows.length !== 1) {
      return {ok: false, error: rows.length ? `${rows.length} layers are named "${name}": tell them apart by ref instead.` : `No layer is named "${name}".`};
    }
    const previous = openEditorButton();
    rows[0].click();
    // The selected layer's settings replace the previous one's; wait for its Open Editor button, then take what is there.
    const button = (await waitFor(() => {
      const current = openEditorButton();
      return current && current !== previous ? current : null;
    }, 1500)) || openEditorButton();
    if (!button) return {ok: false, error: `"${name}" shows no Open Editor button: it may not be a custom widget.`};
    press(button);
    return (await waitFor(dialog, 3000)) ? {ok: true} : {ok: false, error: `Open Editor did not open the code editor of "${name}".`};
  };

  const run = async (names) => {
    const stop = hidden() || needFiles();
    if (stop) return stop;
    if (!Array.isArray(names) || !names.length || names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length) {
      return {ok: false, error: 'Pass the layer names to update, each once.'};
    }
    // A widget whose JS or CSS changes shows it in the canvas after Done: one more iframe holds the new code.
    const watched = ['js', 'css'].filter((tab) => plan().tabs[tab].old !== plan().tabs[tab].new);
    const widgets = [];
    for (const name of names) {
      const before = await canvasState();
      const opened = await open(name);
      if (!opened.ok) {
        widgets.push({name, ...opened});
        break;
      }
      const applied = await apply();
      if (!applied.ok) {
        widgets.push({name, ...applied, error: `${applied.error} The code editor is still open.`});
        break;
      }
      const closed = await done();
      if (!closed.ok) {
        widgets.push({name, tabs: applied.tabs, ...closed});
        break;
      }
      const wrote = watched.filter((tab) => applied.tabs[tab] === 'written');
      const shown = !wrote.length || await waitFor(async () => {
        const now = await canvasState();
        return wrote.every((tab) => now[tab].NEW > before[tab].NEW);
      }, 5000);
      if (!shown) {
        widgets.push({name, ok: false, tabs: applied.tabs,
          error: `No more widgets in the canvas show the new ${wrote.join(' and ')} after Done: the code may not have reached the widget.`});
        break;
      }
      widgets.push({name, ok: true, tabs: applied.tabs});
    }
    const canvas = await canvasState();
    return {
      ok: widgets.length === names.length && widgets.every((widget) => widget.ok),
      widgets,
      canvas: {widgets: canvas.widgets, js: canvas.js, css: canvas.css},
      // Widgets in the canvas still on the old commit's JS or CSS: 0 once every widget of the overlay is done.
      left: watched.length ? canvas.each.filter((widget) => watched.some((tab) => widget[tab] === 'OLD')).length : null
    };
  };

  api.attach = () => out(attach());
  api.files = async () => out(await files());
  api.open = async (name) => out(await open(name));
  api.scan = async () => out(await scan());
  api.apply = async () => out(await apply());
  api.done = async () => out(await done());
  api.run = async (names) => out(await run(names));
  return out({ok: true, version: api.version, calls: ['attach()', 'await files()', 'await run([names])', 'await open(name)', 'await scan()', 'await apply()', 'await done()']});
})();
