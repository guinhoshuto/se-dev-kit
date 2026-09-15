'use client';

import {useEffect, useRef, useState} from 'react';
import type {WidgetSnapshot} from '../lib/model';
import type {JsonObject, RuntimeState} from '../src/types';
import {BRIDGE_PROTOCOL, BRIDGE_VERSION} from '../src/version';

interface PreviewResponse {html: string; state: RuntimeState; sessionId: string; nonce: string}
export function WidgetPreview({projectId, token, snapshot, sceneId, themeId, fieldData, reload = 0, compact = false}: {projectId: string; token: string; snapshot: WidgetSnapshot; sceneId: string; themeId: string; fieldData: JsonObject; reload?: number; compact?: boolean}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [prepared, setPrepared] = useState<PreviewResponse | null>(null);
  const [status, setStatus] = useState('Preparing preview…');
  const [error, setError] = useState('');
  const [scale, setScale] = useState(1);
  const [log, setLog] = useState<string[]>([]);
  const [eventText, setEventText] = useState('Hello from the studio!');
  const [listener, setListener] = useState('message');
  const [eventJson, setEventJson] = useState('{"data":{"displayName":"Preview viewer","text":"Hello!"}}');
  const [customEvent, setCustomEvent] = useState(false);
  const scene = snapshot.scenes.find(item => item.id === sceneId);
  const viewport = scene?.viewport ?? snapshot.widget.viewport;
  const output = scene?.output ?? viewport;
  const crop = scene?.crop;
  const width = crop?.width ?? output.width;
  const height = crop?.height ?? output.height;
  const camera = scene?.camera;
  const fixture = snapshot.fixtures.find(item => item.id === scene?.fixture);
  const background = scene?.background;

  useEffect(() => {
    const abort = new AbortController();
    setPrepared(null); setError(''); setLog([]); setStatus('Preparing preview…');
    void (async () => {
      try {
        const response = await fetch(`/api/studio/projects/${projectId}/preview`, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({snapshot, sceneId: sceneId || undefined, themeId: themeId || undefined, fieldData}), signal: abort.signal});
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || 'Preview preparation failed.');
        if (!abort.signal.aborted) {setStatus('Starting isolated runtime…'); setPrepared(data as PreviewResponse);}
      } catch (cause) {if (!abort.signal.aborted) {setError(cause instanceof Error ? cause.message : 'Preview failed.'); setStatus('Preview blocked');}}
    })();
    return () => abort.abort();
  }, [projectId, token, snapshot, sceneId, themeId, fieldData, reload]);

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {if (entry) setScale(Math.max(.05, Math.min(1, (entry.contentRect.width - 40) / width, (entry.contentRect.height - 40) / height)));});
    observer.observe(container.current); return () => observer.disconnect();
  }, [width, height]);

  useEffect(() => {
    if (!prepared) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let started = false; let dispatched = false;
    const deadline = setTimeout(() => {setStatus('Preview timeout'); setError('The widget did not become ready within its configured timeout.');}, (snapshot.widget.ready?.timeoutMs ?? 10000) + 5000);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const message = event.data;
      if (!message || message.protocol !== BRIDGE_PROTOCOL || message.version !== BRIDGE_VERSION || message.sessionId !== prepared.sessionId || message.nonce !== prepared.nonce || typeof message.type !== 'string') return;
      if ((message.type === 'frame:booted' || message.type === 'frame:loaded') && !started) {
        started = true;
        frame.current?.contentWindow?.postMessage({protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION, sessionId: prepared.sessionId, nonce: prepared.nonce, type: 'host:init', payload: {state: prepared.state}}, '*');
      }
      if (message.type === 'frame:widget-ready') {
        clearTimeout(deadline); setStatus('Ready · isolated runtime');
        if (!dispatched) {dispatched = true; for (const item of fixture?.events ?? []) timers.push(setTimeout(() => {
          frame.current?.contentWindow?.postMessage({protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION, sessionId: prepared.sessionId, nonce: prepared.nonce, type: 'host:emit', payload: {listener: item.listener, event: item.event}}, '*');
        }, item.atMs));}
      }
      if (message.type === 'frame:error' || message.type === 'frame:unhandled-rejection') {clearTimeout(deadline); setStatus('Runtime error'); setError(String(message.payload?.message ?? 'Widget runtime error').slice(0, 2000));}
      if (message.type === 'frame:console') setLog(previous => [...previous.slice(-19), `${message.payload?.level ?? 'log'}: ${String(message.payload?.message ?? '').slice(0, 1000)}`]);
    };
    window.addEventListener('message', receive);
    return () => {window.removeEventListener('message', receive); clearTimeout(deadline); timers.forEach(clearTimeout);};
  }, [prepared, fixture, snapshot.widget.ready?.timeoutMs]);

  function sendEvent() {
    if (!prepared || !frame.current?.contentWindow) return;
    try {
      const event: unknown = customEvent ? JSON.parse(eventJson) : {data: {displayName: 'Preview viewer', text: eventText}};
      frame.current.contentWindow.postMessage({protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION, sessionId: prepared.sessionId, nonce: prepared.nonce, type: 'host:emit', payload: {listener: customEvent ? listener : 'message', event}}, '*');
    } catch {setError('Custom event must be valid JSON.');}
  }

  return <div className={`preview-surface ${compact ? 'compact' : ''}`}>
    <div className="preview-meta"><span><i className={`status-dot ${error ? 'invalid' : ''}`} />{status}</span><span>{width} × {height} · {Math.round(scale * 100)}%</span></div>
    <div className="preview-canvas" ref={container}>
      {!prepared && <div className="preview-placeholder">{error ? 'Preview unavailable' : 'Preparing your widget…'}</div>}
      {prepared && <div className="stage-fit" style={{width: width * scale, height: height * scale}}><div className="stage-crop" style={{width, height, transform: `scale(${scale})`}}><div className={`widget-stage ${background?.checkerboard ? 'checkerboard' : ''}`} style={{width: output.width, height: output.height, left: -(crop?.x ?? 0), top: -(crop?.y ?? 0), backgroundColor: background?.color ?? 'transparent'}}><iframe key={prepared.nonce} ref={frame} title={compact ? `Theme preview: ${themeId}` : 'Isolated widget preview'} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={prepared.html} style={{width: viewport.width, height: viewport.height, transform: `translate(${camera?.x ?? 0}px, ${camera?.y ?? 0}px) scale(${camera?.scale ?? 1})`, transformOrigin: camera?.origin ?? 'top left'}} /></div></div></div>}
    </div>
    {error && <p role="alert" className="notice error preview-notice">{error}</p>}
    {!compact && <div className="event-console"><div className="event-toolbar"><label className="checkbox-label"><input type="checkbox" checked={customEvent} onChange={e => setCustomEvent(e.target.checked)} />Custom event</label><span className="muted">Synthetic data only</span></div>{customEvent ? <><label className="sr-only" htmlFor="listener">Listener</label><input id="listener" value={listener} onChange={e => setListener(e.target.value)} placeholder="Listener" /><label className="sr-only" htmlFor="event-payload">Event JSON</label><textarea id="event-payload" className="code-input" rows={3} value={eventJson} onChange={e => setEventJson(e.target.value)} /></> : <label className="sr-only" htmlFor="test-message">Test message</label>}<div className="event-send">{!customEvent && <input id="test-message" value={eventText} onChange={e => setEventText(e.target.value)} onKeyDown={e => {if (e.key === 'Enter') sendEvent();}} placeholder="Synthetic chat message" />}<button className="button" disabled={!prepared} onClick={sendEvent}>Send event</button></div>{log.length > 0 && <details className="runtime-log"><summary>Runtime console ({log.length})</summary><pre>{log.join('\n')}</pre></details>}</div>}
  </div>;
}
