import type {WidgetSnapshot} from './model';

/** Synthetic, self-contained starter; no production credentials or remote resources. */
export const demoSnapshot: WidgetSnapshot = {
  schemaVersion: 1,
  name: 'Studio chat',
  widget: {
    viewport: {width: 430, height: 640},
    ready: {selector: '#chat', timeoutMs: 10000},
    html: '<main id="chat"><header><span class="signal"></span><strong id="heading">Studio chat</strong><span class="live">PREVIEW</span></header><section id="messages" aria-live="polite"></section><footer>SYNTHETIC DATA · WIDGET STUDIO</footer></main>',
    css: '*{box-sizing:border-box}body{margin:0;padding:24px;font-family:Arial,sans-serif;color:var(--text,#f6f4ff);background:transparent}#chat{background:var(--panel,#20202a);border:1px solid #ffffff15;border-radius:22px;overflow:hidden;box-shadow:0 18px 55px #0002}header{height:74px;display:flex;align-items:center;gap:10px;padding:0 22px;border-bottom:1px solid #ffffff12}header strong{font-size:17px;letter-spacing:-.3px}.signal{width:8px;height:8px;border-radius:50%;background:var(--accent,#ac96ff)}.live{margin-left:auto;font-size:9px;letter-spacing:1.5px;opacity:.5}#messages{padding:10px 22px 26px;min-height:370px}.message{padding-top:22px;animation:arrive .25s ease-out}.name{display:block;color:var(--accent,#ac96ff);font-size:12px;font-weight:bold;margin-bottom:8px}.bubble{background:#88888815;border:1px solid #88888815;border-radius:4px 15px 15px 15px;padding:14px 16px;line-height:1.55;font-size:var(--size,14px)}footer{padding:18px 22px;border-top:1px solid #ffffff12;font-size:9px;letter-spacing:1.5px;opacity:.45}@keyframes arrive{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
    js: "(() => { const apply = (f) => { document.documentElement.style.setProperty('--accent', f.accentColor); document.documentElement.style.setProperty('--panel', f.panelColor); document.documentElement.style.setProperty('--text', f.textColor); document.documentElement.style.setProperty('--size', f.fontSize + 'px'); document.querySelector('#heading').textContent = f.title; }; const add = (name, text) => { const row = document.createElement('article'); row.className = 'message'; const label = document.createElement('span'); label.className = 'name'; label.textContent = name; const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text; row.append(label, bubble); const list = document.querySelector('#messages'); list.append(row); while(list.children.length > 4) list.firstElementChild.remove(); }; window.addEventListener('onWidgetLoad', ({detail}) => { apply(detail.fieldData); add('Studio bot', 'Your widget is ready. Try a theme or send a test message.'); }); window.addEventListener('onWidgetUpdate', ({detail}) => apply(detail.fieldData)); window.addEventListener('onEventReceived', ({detail}) => { if(detail.listener === 'message') { const d = detail.event.data || detail.event; add(d.displayName || 'Preview viewer', d.text || 'Hello from the studio!'); } }); })();",
    fields: {
      title: {type: 'text', label: 'Chat title', value: 'Studio chat', group: 'Content'},
      accentColor: {type: 'colorpicker', label: 'Accent color', value: '#ac96ff', group: 'Appearance'},
      panelColor: {type: 'colorpicker', label: 'Panel color', value: '#20202a', group: 'Appearance'},
      textColor: {type: 'colorpicker', label: 'Text color', value: '#f6f4ff', group: 'Appearance'},
      fontSize: {type: 'slider', label: 'Message size', value: 14, min: 11, max: 24, step: 1, group: 'Appearance'}
    }
  },
  channel: {username: 'studio_streamer'},
  themes: [
    {schemaVersion: 1, id: 'violet', name: 'Violet night', fieldData: {accentColor: '#ac96ff', panelColor: '#20202a', textColor: '#f6f4ff'}},
    {schemaVersion: 1, id: 'paper', name: 'Warm paper', fieldData: {accentColor: '#735bba', panelColor: '#f8f5ed', textColor: '#302d39'}},
    {schemaVersion: 1, id: 'forest', name: 'Forest', fieldData: {accentColor: '#b9d7a7', panelColor: '#1e2c27', textColor: '#eff4e9'}}
  ],
  fixtures: [{schemaVersion: 1, id: 'conversation', name: 'Preview conversation', events: [
    {atMs: 150, listener: 'message', event: {data: {displayName: 'Luna', text: 'This is our little corner of the internet.'}}},
    {atMs: 450, listener: 'message', event: {data: {displayName: 'River', text: 'The colors look lovely today ✦'}}},
    {atMs: 850, listener: 'message', event: {data: {displayName: 'Alex', text: 'Ready when you are!'}}}
  ]}],
  scenes: [{schemaVersion: 1, id: 'portrait', name: 'Portrait preview', fixture: 'conversation', theme: 'violet', background: {id: 'mist', color: '#e9e7ee'}, viewport: {width: 430, height: 640}, output: {width: 430, height: 640, format: 'png'}, captureAtMs: 1200}],
  scenarios: [{schemaVersion: 1, id: 'chat-smoke', name: 'Chat smoke test', scene: 'portrait', steps: [{action: 'assert', selector: '#chat', visible: true}, {action: 'dispatch', listener: 'message', event: {data: {displayName: 'Test viewer', text: 'Synthetic smoke test'}}}, {action: 'assert', selector: '#messages', text: 'Synthetic smoke test'}]}],
  recipes: [
    {schemaVersion: 1, id: 'theme-gallery', name: 'Theme gallery', scenes: ['portrait'], matrix: {themes: ['violet', 'paper', 'forest']}, outputs: {screenshots: true, thumbnails: {width: 215, height: 320}, contactSheet: true}, limit: 3},
    {schemaVersion: 1, id: 'preview-video', name: 'Short preview video', scenes: ['portrait'], outputs: {screenshots: true, video: {enabled: true, durationMs: 3000, fps: 30, format: 'mp4', codec: 'h264', audio: 'none'}}, limit: 1}
  ],
  assets: []
};
