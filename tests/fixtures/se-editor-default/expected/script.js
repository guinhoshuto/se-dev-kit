let limit = 4;
const queue = [];
function row(kind, who) {
  // a } in a comment, and "}" in a string
  return `<li class="${kind}">${who}</li>`;
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
