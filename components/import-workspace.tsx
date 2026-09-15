'use client';

import {useRef, useState} from 'react';
import {demoSnapshot} from '../lib/demo';
import type {WidgetSnapshot} from '../lib/model';

export function ImportWorkspace() {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  async function create(snapshot: WidgetSnapshot) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/projects', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(snapshot)});
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || 'Project creation failed.');
      sessionStorage.setItem(`studio:key:${result.projectId}`, result.token);
      window.location.assign(result.editorUrl);
    } catch (cause) {setError(cause instanceof Error ? cause.message : 'Project creation failed.'); setBusy(false);}
  }
  function submit() {
    try {void create(JSON.parse(source) as WidgetSnapshot);} catch {setError('Enter a valid WidgetSnapshot JSON document.');}
  }
  return <div className="app-shell">
    <header className="product-bar"><a className="brand" href="/"><span className="brand-mark">se</span>Widget Studio</a><span className="product-label">PERSONAL WORKSPACE</span><a className="top-link" href="https://github.com/guinhoshuto/se-dev-kit" target="_blank" rel="noreferrer">Documentation ↗</a></header>
    <main className="import-layout">
      <section className="import-main">
        <div className="eyebrow">NEW PROJECT</div><h1>Your widget workspace.</h1><p className="intro-copy">Import a snapshot to preview, test themes, and create visual assets.</p>
        <div className="import-toolbar"><h2>Project snapshot</h2><input ref={file} type="file" accept="application/json,.json" hidden onChange={async (event) => {const picked = event.target.files?.[0]; if (picked) {if (picked.size > 4 * 1024 * 1024) {setError('Snapshot JSON must be smaller than 4 MB.'); return;} setSource(await picked.text()); setError('');}}} /><button type="button" className="button subtle" onClick={() => file.current?.click()}>Choose JSON file</button></div>
        <label className="sr-only" htmlFor="snapshot">WidgetSnapshot JSON</label><textarea id="snapshot" className="snapshot-input code-input" spellCheck={false} value={source} onChange={event => setSource(event.target.value)} placeholder={'{\n  "schemaVersion": 1,\n  "name": "My widget",\n  "widget": { "html": "…", "css": "…", "js": "…", "fields": {} }\n}'} />
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="import-actions"><button className="button primary" disabled={busy || !source.trim()} onClick={submit}>{busy ? 'Creating project…' : 'Create project →'}</button><button className="button" disabled={busy} onClick={() => void create(demoSnapshot)}>Open demo project</button></div>
        <p className="muted fine-print">Your files stay unchanged. A private editing link is created for each project.</p>
      </section>
      <aside className="import-aside"><div className="eyebrow">WORKFLOW</div><ol className="workflow-list"><li><span>01</span><div><h3>Bring the source</h3><p>HTML, CSS, JavaScript, and the real FIELDS schema in one versioned snapshot.</p></div></li><li><span>02</span><div><h3>Set the scene</h3><p>Adjust fields, themes, backgrounds, and framing in an isolated preview.</p></div></li><li><span>03</span><div><h3>Make the assets</h3><p>Run smoke tests and recipes for images, theme sheets, and short videos.</p></div></li></ol><div className="api-note"><h3>Code-first, too.</h3><code>POST /api/v1/projects</code><p>The same snapshot works from your scripts and coding agents.</p></div><p className="security-note">Keep editing links private. Use synthetic data only. This is a local simulation, not a StreamElements or OBS compatibility guarantee.</p></aside>
    </main><footer className="app-footer">SE Widget Studio<span>No account · Private editing links · Immutable revisions</span></footer>
  </div>;
}
