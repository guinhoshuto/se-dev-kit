/* Hand-written test bundle for se-editor-default.mjs. It only looks minified; it is not code of any real editor. */
var Ab=Object.defineProperty,Cd=(t,e)=>`${t}:${e}`,Yt={a:1,b:{c:"}"}};function Ef(t){return{name:t,render:()=>`<b>${t.name||"{}"}</b>`}}
const Lk={html:"<div class=\"alert\"><span id=\"msg\"></span></div>",css:'.alert{opacity:0;transition:opacity .3s}',js:`window.addEventListener("onEventReceived",e=>{document.getElementById("msg").textContent=e.detail.listener})`,fields:`{"duration":{"type":"number","label":"Seconds","value":5}}`},Qp={css:`.ticker { font-family: sans-serif; color: {{textColor}}; }
#feed li { list-style: none; padding: 2px 6px; }
`,js:`let limit = 4;
const queue = [];
function row(kind, who) {
  // a } in a comment, and "}" in a string
  return \`<li class="\${kind}">\${who}</li>\`;
}
window.addEventListener('onWidgetLoad', (obj) => {
  limit = obj.detail.fieldData.maxItems;
  document.getElementById('title').textContent = obj.detail.fieldData.title;
});
window.addEventListener('onEventReceived', (obj) => {
  const e = obj.detail.event || {};
  queue.unshift(row(obj.detail.listener, e.name || '}'));
  document.getElementById('feed').innerHTML = queue.slice(0, limit).join('');
});
`,"html":`<div class="ticker"><h1 id="title"></h1><ul id="feed"></ul></div>
`,fields:`{
    "title": {
        "type": "text",
        "label": "Title",
        "value": "Latest"
    },
    "textColor": {
        "type": "colorpicker",
        "label": "Text color",
        "value": "#ffffff"
    },
    "maxItems": {
        "type": "number",
        "label": "Rows shown",
        "value": 4
    },
    "speed": {
        "type": "slider",
        "label": "Speed",
        "value": 1,
        "min": 0,
        "max": 3
    }
}
`},x={css:Qp.css,html:Qp.html,js:Qp.js,fields:Qp.fields},Zr={"html":e=>e,css:""};
function Gh(e){return{html:e}}function Ij(e,t){return e.map(n=>({id:n.id,label:`${n.label} (${t})`}))}
const Mn={css:`.x{left:${Ab}px}`,js:"window.addEventListener('onWidgetLoad',()=>{})",html:"",fields:"{}"},Op=[{css:"a",js:"b"},{html:"<i>}</i>"}];
export{Ef as a,Gh as b,Ij as c,Lk as d,x as e,Zr as f,Mn as g,Op as h};
