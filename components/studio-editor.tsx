'use client';

import {useCallback, useEffect, useMemo, useState} from 'react';
import type {Artifact, Job, ProjectView, WidgetSnapshot} from '../lib/model';
import type {JsonObject, JsonValue, NormalizedField, SceneDefinition} from '../src/types';
import {normalizeFields} from '../src/config/fields';
import {WidgetPreview} from './widget-preview';

type SourceTab = 'HTML' | 'CSS' | 'JavaScript' | 'FIELDS' | 'Themes' | 'Fixtures' | 'Scenes' | 'Scenarios' | 'Recipes' | 'Assets' | 'Channel';
type InspectorTab = 'Fields' | 'Scene' | 'Export' | 'History';
const sourceTabs: SourceTab[] = ['HTML', 'CSS', 'JavaScript', 'FIELDS', 'Themes', 'Fixtures', 'Scenes', 'Scenarios', 'Recipes', 'Assets', 'Channel'];
const jsonMap = {Themes: 'themes', Fixtures: 'fixtures', Scenes: 'scenes', Scenarios: 'scenarios', Recipes: 'recipes', Assets: 'assets', Channel: 'channel'} as const;
const emptyFields: JsonObject = {};
function errorMessage(cause: unknown) {return cause instanceof Error ? cause.message : 'The request could not be completed.';}
function sources(snapshot: WidgetSnapshot): Record<SourceTab, string> {return {HTML: snapshot.widget.html, CSS: snapshot.widget.css, JavaScript: snapshot.widget.js, FIELDS: JSON.stringify(snapshot.widget.fields, null, 2), Themes: JSON.stringify(snapshot.themes, null, 2), Fixtures: JSON.stringify(snapshot.fixtures, null, 2), Scenes: JSON.stringify(snapshot.scenes, null, 2), Scenarios: JSON.stringify(snapshot.scenarios, null, 2), Recipes: JSON.stringify(snapshot.recipes, null, 2), Assets: JSON.stringify(snapshot.assets, null, 2), Channel: JSON.stringify(snapshot.channel, null, 2)};}
function parsedDraft(base: WidgetSnapshot, texts: Record<SourceTab, string>): WidgetSnapshot {
  function json(tab: SourceTab) {try {return JSON.parse(texts[tab]) as JsonValue;} catch {throw new Error(`${tab} contains invalid JSON. Your draft has been kept.`);}}
  const output = structuredClone(base);
  output.widget = {...output.widget, html: texts.HTML, css: texts.CSS, js: texts.JavaScript, fields: json('FIELDS')};
  for (const [tab, key] of Object.entries(jsonMap)) Object.assign(output, {[key]: json(tab as SourceTab)});
  return output;
}

export function StudioEditor({projectId}: {projectId: string}) {
  const [token, setToken] = useState('');
  const [view, setView] = useState<ProjectView | null>(null);
  const [draft, setDraft] = useState<WidgetSnapshot | null>(null);
  const [texts, setTexts] = useState<Record<SourceTab, string> | null>(null);
  const [preview, setPreview] = useState<WidgetSnapshot | null>(null);
  const [sourceTab, setSourceTab] = useState<SourceTab>('HTML');
  const [inspector, setInspector] = useState<InspectorTab>('Fields');
  const [sceneId, setSceneId] = useState('');
  const [themeId, setThemeId] = useState('');
  const [fieldData, setFieldData] = useState<JsonObject>(emptyFields);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [recipeId, setRecipeId] = useState('');
  const [scenarioId, setScenarioId] = useState('all');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reload, setReload] = useState(0);
  const [gallery, setGallery] = useState(false);
  const [galleryPage, setGalleryPage] = useState(0);
  const [showSource, setShowSource] = useState(true);

  const request = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(path, {...init, headers: {Authorization: `Bearer ${token}`, ...(init?.body ? {'Content-Type': 'application/json'} : {}), ...init?.headers}});
    const data = await response.json();
    if (!response.ok) {if (response.status === 409 || response.status === 412) setConflict(true); throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `Request failed (${response.status}).`);}
    return data as T;
  }, [token]);

  const acceptView = useCallback((next: ProjectView) => {
    setView(next); setDraft(next.revision.snapshot); setTexts(sources(next.revision.snapshot)); setPreview(next.revision.snapshot); setJobs(next.jobs ?? []); setDirty(false); setConflict(false); setFieldData(emptyFields);
    setSceneId(previous => next.revision.snapshot.scenes.some(item => item.id === previous) ? previous : next.revision.snapshot.scenes[0]?.id ?? '');
    setRecipeId(previous => next.revision.snapshot.recipes.some(item => item.id === previous) ? previous : next.revision.snapshot.recipes[0]?.id ?? '');
  }, []);

  useEffect(() => {
    const key = new URLSearchParams(window.location.hash.slice(1)).get('key') || sessionStorage.getItem(`studio:key:${projectId}`);
    if (!key) {setError('This project needs its private editing link. Open the full link including #key=…'); return;}
    sessionStorage.setItem(`studio:key:${projectId}`, key); setToken(key);
  }, [projectId]);
  useEffect(() => {if (!token) return; let active = true; void request<ProjectView>(`/api/v1/projects/${projectId}`).then(next => {if (active) acceptView(next);}).catch(cause => {if (active) setError(errorMessage(cause));}); return () => {active = false;};}, [projectId, token, request, acceptView]);
  useEffect(() => {if (!dirty) return; const guard = (event: BeforeUnloadEvent) => {event.preventDefault();}; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);}, [dirty]);
  const activeJob = jobs.some(job => job.status === 'queued' || job.status === 'running');
  useEffect(() => {if (!token || !activeJob) return; const timer = setInterval(() => {void request<Job[]>(`/api/studio/projects/${projectId}/jobs`).then(setJobs).catch(cause => setError(errorMessage(cause)));}, 2500); return () => clearInterval(timer);}, [activeJob, token, projectId, request]);

  const fields = useMemo(() => {try {return normalizeFields(texts ? JSON.parse(texts.FIELDS) as JsonValue : {}).fields;} catch {return []; }}, [texts]);
  const scene = draft?.scenes.find(item => item.id === sceneId);
  const theme = draft?.themes.find(item => item.id === (themeId || scene?.theme));
  const fixture = draft?.fixtures.find(item => item.id === scene?.fixture);
  const values = useMemo(() => ({...Object.fromEntries(fields.map(field => [field.id, field.value])), ...theme?.fieldData, ...fixture?.fieldData, ...scene?.fieldData, ...fieldData}), [fields, theme, fixture, scene, fieldData]);

  function buildDraft() {
    if (!draft || !texts) throw new Error('Project is not loaded.');
    const next = parsedDraft(draft, texts);
    if (Object.keys(fieldData).length) {
      const selected = next.scenes.find(item => item.id === sceneId);
      if (selected) selected.fieldData = {...selected.fieldData, ...fieldData};
      else {const normalized = normalizeFields(next.widget.fields); for (const field of normalized.fields) if (field.id in fieldData) field.definition.value = fieldData[field.id]!; next.widget.fields = Object.fromEntries(normalized.fields.map(field => [field.id, field.definition]));}
    }
    return next;
  }
  function applyPreview() {try {const next = buildDraft(); setDraft(next); setPreview(next); setTexts(sources(next)); setFieldData(emptyFields); setReload(value => value + 1); setError(''); setNotice('Draft applied to preview. Save a revision before running tests or exports.');} catch (cause) {setError(errorMessage(cause));}}
  async function save() {
    if (!view) return; setBusy('save'); setError(''); setNotice('');
    try {const next = await request<ProjectView>(`/api/v1/projects/${projectId}`, {method: 'PUT', headers: {'If-Match': view.etag}, body: JSON.stringify(buildDraft())}); acceptView(next); setNotice('Revision saved.');}
    catch (cause) {setError(errorMessage(cause));} finally {setBusy('');}
  }
  async function latestBase() {
    setBusy('latest'); try {const latest = await request<ProjectView>(`/api/v1/projects/${projectId}`); setView(latest); setJobs(latest.jobs); setConflict(false); setNotice('Latest revision loaded as the save base. Your local draft is unchanged; review before saving.');} catch (cause) {setError(errorMessage(cause));} finally {setBusy('');}
  }
  async function restore(revisionId: string) {
    if (!view || (dirty && !window.confirm('Restore this revision? Export your draft first if you want to keep unsaved edits.')) || !window.confirm('Create a new revision from this historical snapshot?')) return;
    setBusy('restore'); setError('');
    try {acceptView(await request<ProjectView>(`/api/studio/projects/${projectId}/restore`, {method: 'POST', headers: {'If-Match': view.etag}, body: JSON.stringify({revisionId})})); setNotice('Historical snapshot restored as a new revision.');} catch (cause) {setError(errorMessage(cause));} finally {setBusy('');}
  }
  async function run(kind: 'test' | 'render') {
    if (dirty) {setError('Save your draft first. Jobs always use a saved, immutable revision.'); return;}
    setBusy(kind); setError('');
    try {const job = await request<Job>(`/api/studio/projects/${projectId}/jobs`, {method: 'POST', body: JSON.stringify({kind, selection: kind === 'render' ? recipeId : scenarioId})}); setJobs(previous => [job, ...previous]); setNotice(`${kind === 'render' ? 'Export' : 'Test'} job queued.`);} catch (cause) {setError(errorMessage(cause));} finally {setBusy('');}
  }
  async function download(artifact: Artifact) {
    try {const response = await fetch(`/api/studio/projects/${projectId}/artifacts/${artifact.id}`, {headers: {Authorization: `Bearer ${token}`}}); if (!response.ok) throw new Error('Artifact download failed.'); const blob = await response.blob(); downloadBlob(blob, artifact.name);} catch (cause) {setError(errorMessage(cause));}
  }
  function exportDraft() {try {downloadBlob(new Blob([JSON.stringify(buildDraft(), null, 2)], {type: 'application/json'}), 'widget-snapshot.json');} catch (cause) {setError(errorMessage(cause));}}
  function updateScene(patch: Partial<SceneDefinition>) {
    if (!draft || !texts) return;
    try {const next = parsedDraft(draft, texts); const selected = next.scenes.find(item => item.id === sceneId); if (!selected) return; Object.assign(selected, patch); setDraft(next); setTexts(sources(next)); setDirty(true);} catch (cause) {setError(errorMessage(cause));}
  }
  function addScene() {
    if (!draft || !texts) return;
    try {const next = parsedDraft(draft, texts); const id = `scene-${Date.now().toString(36)}`; next.scenes.push({schemaVersion: 1, id, name: 'New scene', viewport: next.widget.viewport, output: {...next.widget.viewport, format: 'png'}, background: {id: 'transparent', checkerboard: true}, captureAtMs: 1000}); setDraft(next); setTexts(sources(next)); setSceneId(id); setDirty(true); setInspector('Scene');} catch (cause) {setError(errorMessage(cause));}
  }
  function setText(value: string) {if (texts) {setTexts({...texts, [sourceTab]: value}); setDirty(true); setNotice('');}}

  if (!view || !draft || !texts || !preview) return <div className="app-shell"><header className="product-bar"><a className="brand" href="/"><span className="brand-mark">se</span>Widget Studio</a></header><main className="loading-workspace"><h1>{error ? 'Project unavailable' : 'Opening your workspace…'}</h1>{error && <p role="alert" className="notice error">{error}</p>}<a href="/" className="button">Back to projects</a></main></div>;
  return <div className="editor-shell">
    <header className="product-bar"><a className="brand" href="/"><span className="brand-mark">se</span>Widget Studio</a><span className="header-divider" /><input aria-label="Project name" className="project-name" value={draft.name} onChange={e => {setDraft({...draft, name: e.target.value}); setDirty(true);}} /><span className="revision-status">{dirty ? 'Unsaved draft' : `Revision ${view.revision.id.slice(0, 8)}`}</span><div className="header-actions"><button className="button inverse" onClick={exportDraft}>Export JSON</button><button className="button inverse" onClick={() => {void navigator.clipboard.writeText(`${window.location.origin}/p/${projectId}#key=${token}`).then(() => setNotice('Private editing link copied. Anyone with this link can edit.')).catch(() => setError('Clipboard access was denied. Copy the full address from your browser.'));}}>Copy private link</button><button className="button primary" onClick={() => void save()} disabled={!!busy || !dirty}>{busy === 'save' ? 'Saving…' : 'Save revision'}</button></div></header>
    <div className="workspace-toolbar"><div className="toolbar-group"><button className={`button icon-button ${showSource ? 'selected' : ''}`} onClick={() => setShowSource(value => !value)} aria-pressed={showSource}>‹/› Source</button><span className="toolbar-rule" /><label>Scene<select value={sceneId} onChange={e => {setSceneId(e.target.value); setFieldData(emptyFields);}}><option value="">Default viewport</option>{draft.scenes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Theme<select value={themeId} onChange={e => {setThemeId(e.target.value); setFieldData(emptyFields);}}><option value="">Scene default</option>{draft.themes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><div className="toolbar-group"><button className={`button ${gallery ? 'selected' : ''}`} aria-pressed={gallery} onClick={() => setGallery(value => !value)}>Theme gallery</button><button className="button" onClick={applyPreview}>↻ Apply preview</button></div></div>
    {(error || notice || conflict) && <div className={`workspace-notice ${error ? 'has-error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span>{conflict && <><button className="button" onClick={exportDraft}>Download draft</button><button className="button" disabled={!!busy} onClick={() => void latestBase()}>Keep draft, load latest base</button></>}<button className="dismiss" aria-label="Dismiss message" onClick={() => {setError(''); setNotice('');}}>×</button></div>}
    <main className={`editor-workspace ${showSource ? '' : 'source-hidden'}`}>
      {showSource && <section className="source-panel" aria-label="Widget source"><div className="panel-heading"><h2>Source</h2><span>Full snapshot</span></div><div className="source-tabs" role="tablist" aria-label="Source files">{sourceTabs.map(tab => <button key={tab} role="tab" aria-selected={sourceTab === tab} onClick={() => setSourceTab(tab)}>{tab}</button>)}</div><div className="source-file-label"><span>{sourceTab}</span><span>{texts[sourceTab].split('\n').length} lines</span></div><textarea aria-label={`${sourceTab} source`} className="code-input source-input" spellCheck={false} value={texts[sourceTab]} onChange={e => setText(e.target.value)} onKeyDown={e => {if (e.key === 'Tab') {e.preventDefault(); const start = e.currentTarget.selectionStart; const end = e.currentTarget.selectionEnd; setText(texts[sourceTab].slice(0, start) + '  ' + texts[sourceTab].slice(end)); requestAnimationFrame(() => e.currentTarget?.setSelectionRange(start + 2, start + 2));}}} /><div className="source-footer">Original source is versioned. Preview changes stay local until saved.</div></section>}
      <section className="center-panel" aria-label="Widget preview"><div className="panel-heading"><h2>{gallery ? 'Theme gallery' : 'Preview'}</h2><span>Sandboxed · Synthetic data</span></div>{gallery ? <div className="gallery-scroll"><div className="theme-grid">{preview.themes.slice(galleryPage * 6, galleryPage * 6 + 6).map(item => <div className="theme-preview" key={item.id}><h3>{item.name}</h3><WidgetPreview projectId={projectId} token={token} snapshot={preview} sceneId={sceneId} themeId={item.id} fieldData={emptyFields} reload={reload} compact /></div>)}</div>{!preview.themes.length && <p className="empty-state">Add themes in the source panel to build a gallery.</p>}{preview.themes.length > 6 && <div className="gallery-pagination"><button className="button" disabled={!galleryPage} onClick={() => setGalleryPage(value => value - 1)}>Previous</button><span>{galleryPage + 1} / {Math.ceil(preview.themes.length / 6)}</span><button className="button" disabled={(galleryPage + 1) * 6 >= preview.themes.length} onClick={() => setGalleryPage(value => value + 1)}>Next</button></div>}</div> : <WidgetPreview projectId={projectId} token={token} snapshot={preview} sceneId={sceneId} themeId={themeId} fieldData={fieldData} reload={reload} />}</section>
      <aside className="inspector-panel"><div className="inspector-tabs" role="tablist" aria-label="Inspector">{(['Fields', 'Scene', 'Export', 'History'] as const).map(tab => <button key={tab} role="tab" aria-selected={inspector === tab} onClick={() => setInspector(tab)}>{tab}</button>)}</div><div className="inspector-content">
        {inspector === 'Fields' && <><div className="inspector-title"><h2>Widget fields</h2><span>{fields.length}</span></div><p className="muted section-copy">Generated from your FIELDS schema. Saved values belong to the selected scene.</p>{fields.map((field, index) => <div key={field.id}>{field.group && field.group !== fields[index - 1]?.group && <h3 className="field-group">{field.group}</h3>}<FieldControl field={field} value={values[field.id] ?? field.value} onChange={value => {setFieldData(previous => ({...previous, [field.id]: value})); setDirty(true);}} /></div>)}{!fields.length && <p className="empty-state">No valid fields found. Edit the FIELDS source to add controls.</p>}<button className="button full-width" onClick={() => {setFieldData(emptyFields); setNotice('Unsaved field overrides cleared.');}}>Reset temporary overrides</button></>}
        {inspector === 'Scene' && <><div className="inspector-title"><h2>Scene settings</h2><button className="button subtle" onClick={addScene}>+ New</button></div>{scene ? <><label className="field-control">Scene name<input value={scene.name} onChange={e => updateScene({name: e.target.value})} /></label><label className="field-control">Fixture<select value={scene.fixture ?? ''} onChange={e => updateScene({fixture: e.target.value || undefined})}><option value="">No fixture</option>{draft.fixtures.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><h3 className="field-group">Viewport</h3><div className="paired-fields"><NumberField label="Width" value={scene.viewport?.width ?? draft.widget.viewport.width} min={1} max={4096} onChange={value => updateScene({viewport: {...(scene.viewport ?? draft.widget.viewport), width: value}})} /><NumberField label="Height" value={scene.viewport?.height ?? draft.widget.viewport.height} min={1} max={4096} onChange={value => updateScene({viewport: {...(scene.viewport ?? draft.widget.viewport), height: value}})} /></div><h3 className="field-group">Output & framing</h3><div className="paired-fields"><NumberField label="Output width" value={scene.output?.width ?? draft.widget.viewport.width} min={1} max={4096} onChange={value => updateScene({output: {...(scene.output ?? draft.widget.viewport), width: value}})} /><NumberField label="Output height" value={scene.output?.height ?? draft.widget.viewport.height} min={1} max={4096} onChange={value => updateScene({output: {...(scene.output ?? draft.widget.viewport), height: value}})} /></div><NumberField label="Visual zoom" value={scene.camera?.scale ?? 1} min={.05} max={20} step={.05} onChange={value => updateScene({camera: {id: 'camera', x: 0, y: 0, ...scene.camera, scale: value}})} /><div className="paired-fields"><NumberField label="Offset X" value={scene.camera?.x ?? 0} min={-4096} max={4096} onChange={value => updateScene({camera: {id: 'camera', scale: 1, y: 0, ...scene.camera, x: value}})} /><NumberField label="Offset Y" value={scene.camera?.y ?? 0} min={-4096} max={4096} onChange={value => updateScene({camera: {id: 'camera', scale: 1, x: 0, ...scene.camera, y: value}})} /></div><label className="field-control">Background color<input type="text" value={scene.background?.color ?? ''} placeholder="transparent or #e9e7ee" onChange={e => updateScene({background: {id: 'background', ...scene.background, color: e.target.value}})} /></label><label className="checkbox-label"><input type="checkbox" checked={scene.background?.checkerboard ?? false} onChange={e => updateScene({background: {id: 'background', ...scene.background, checkerboard: e.target.checked}})} />Transparency grid</label><NumberField label="Capture time (ms)" value={scene.captureAtMs ?? 1000} min={0} max={600000} onChange={value => updateScene({captureAtMs: value})} /><details className="crop-settings"><summary>Crop</summary><label className="checkbox-label"><input type="checkbox" checked={!!scene.crop} onChange={e => updateScene({crop: e.target.checked ? {x: 0, y: 0, width: scene.output?.width ?? draft.widget.viewport.width, height: scene.output?.height ?? draft.widget.viewport.height} : undefined})} />Enable crop</label>{scene.crop && <div className="paired-fields">{(['x', 'y', 'width', 'height'] as const).map(key => <NumberField key={key} label={key === 'x' ? 'Crop X' : key === 'y' ? 'Crop Y' : `Crop ${key}`} value={scene.crop![key]} min={key === 'x' || key === 'y' ? 0 : 1} max={4096} onChange={value => updateScene({crop: {...scene.crop!, [key]: value}})} />)}</div>}</details><button className="button full-width" onClick={applyPreview}>Apply scene to preview</button></> : <p className="empty-state">Create a scene to save framing, backgrounds, fixtures, and output settings.</p>}</>}
        {inspector === 'Export' && <><h2>Tests & exports</h2><p className="muted section-copy">Jobs run against saved revisions, not unsaved preview changes.</p><label className="field-control">Render recipe<select value={recipeId} onChange={e => setRecipeId(e.target.value)}>{draft.recipes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="button primary full-width" disabled={!!busy || activeJob || !recipeId || dirty || view.revision.status !== 'ready'} onClick={() => void run('render')}>Generate assets</button><label className="field-control spaced">Smoke scenario<select value={scenarioId} onChange={e => setScenarioId(e.target.value)}><option value="all">All scenarios</option>{draft.scenarios.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="button full-width" disabled={!!busy || activeJob || dirty || view.revision.status !== 'ready'} onClick={() => void run('test')}>Run tests</button>{dirty && <p className="muted section-copy">Save your revision to enable jobs.</p>}<h3 className="field-group">Job history</h3>{jobs.length ? jobs.map(job => <div className="job-item" key={job.id}><div className="job-heading"><strong>{job.kind === 'render' ? 'Export' : 'Test'} · {job.selection}</strong><span className={`job-status ${job.status}`}>{job.status}</span></div><p>{job.progress}</p><small>Revision {job.revisionId.slice(0, 8)} · {new Date(job.createdAt).toLocaleString()}</small>{job.error && <p className="notice error">{job.error}</p>}{job.artifacts.map(artifact => <button className="artifact-link" key={artifact.id} onClick={() => void download(artifact)} title={`${artifact.bytes.toLocaleString()} bytes`}>↓ {artifact.name}</button>)}</div>) : <p className="empty-state">No jobs yet. Choose a recipe or run a smoke test.</p>}</>}
        {inspector === 'History' && <><h2>Revision history</h2><p className="muted section-copy">Every save is immutable. Restoring creates a new revision and keeps this history.</p>{view.revisions.map(revision => <div key={revision.id} className="revision-item"><div><strong>{revision.id.slice(0, 12)}</strong><span>{revision.id === view.revision.id ? 'Current' : revision.status}</span></div><p>{new Date(revision.createdAt).toLocaleString()}</p><button className="button subtle" disabled={!!busy || revision.id === view.revision.id} onClick={() => void restore(revision.id)}>Restore snapshot</button></div>)}<h3 className="field-group">Preparation</h3><p className="muted">Status: {view.revision.status}</p>{view.revision.diagnostics.map((message, index) => <p key={index} className="notice">{message}</p>)}</>}
      </div></aside>
    </main><footer className="editor-footer"><span><i className="status-dot" />Personal workspace</span><span>Local simulation · Verify separately in StreamElements / OBS</span><span>{view.revision.status} · v0.2</span></footer>
  </div>;
}

function downloadBlob(blob: Blob, name: string) {const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);}
function NumberField({label, value, min, max, step = 1, onChange}: {label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void}) {return <label className="field-control">{label}<input type="number" value={value} min={min} max={max} step={step} onChange={e => {if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber)) onChange(Math.max(min, Math.min(max, e.target.valueAsNumber)));}} /></label>;}
function FieldControl({field, value, onChange}: {field: NormalizedField; value: JsonValue; onChange: (value: JsonValue) => void}) {
  if (!field.editable) return <div className="field-control muted">{field.label}<small>{field.type} · This field type has no generated control.</small></div>;
  if (field.type === 'checkbox') return <label className="checkbox-label field-checkbox"><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />{field.label}</label>;
  if (field.type === 'dropdown') return <label className="field-control">{field.label}<select value={JSON.stringify(value)} onChange={e => onChange(JSON.parse(e.target.value) as JsonValue)}>{field.options.map((option, index) => <option key={index} value={JSON.stringify(option.value)}>{option.label}</option>)}</select></label>;
  if (field.type === 'number' || field.type === 'slider') return <label className="field-control">{field.label}<div className="slider-control">{field.type === 'slider' && <input type="range" min={field.min ?? 0} max={field.max ?? 100} step={field.step ?? 1} value={Number(value) || 0} onChange={e => onChange(e.target.valueAsNumber)} />}<input aria-label={`${field.label} value`} type="number" min={field.min} max={field.max} step={field.step ?? 1} value={Number(value) || 0} onChange={e => {if (Number.isFinite(e.target.valueAsNumber)) onChange(e.target.valueAsNumber);}} /></div></label>;
  return <label className="field-control">{field.label}<div className="color-control">{(field.type === 'color' || field.type === 'colorpicker') && <input aria-label={`${field.label} picker`} type="color" value={/^#[a-f\d]{6}$/i.test(String(value)) ? String(value) : '#000000'} onChange={e => onChange(e.target.value)} />}<input value={typeof value === 'string' ? value : JSON.stringify(value)} onChange={e => onChange(e.target.value)} /></div>{field.type.endsWith('-input') && <small>Use an imported asset path. Add remote assets in Assets.</small>}</label>;
}
