// references/se-editor-update.md
(() => {
  const out = JSON.stringify;
  if (!/^https:\/\/streamelements\.com\/overlay\/\w{24}\/editor/.test(location.href)) return out({ok: false, error: 'Not an overlay editor.'});
  document.getElementById('se-editor-load')?.remove();
  const input = document.body.appendChild(Object.assign(document.createElement('input'), {id: 'se-editor-load', type: 'file', multiple: true, ariaLabel: 'se-editor-load files', style: 'position:fixed;opacity:.01'}));
  globalThis.seEditorLoad = async () => {
    const files = [...input.files].filter((f) => /^se-editor-(read|update)\.js$/.test(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
    let r = {ok: false, error: 'Upload se-editor-read.js or se-editor-update.js.'};
    for (const f of files) {
      r = JSON.parse((0, eval)(await f.text()));
      if (!r.ok) break;
    }
    if (r.ok) input.remove();
    return out(r);
  };
  return out({ok: true, label: input.ariaLabel});
})();
