// A synthetic canvas widget whose motion is a function of its clock alone. It stands in for
// se-curvetext, whose front and back copies are two OBS browser sources (consumer widget files never
// enter this repository); only its two clocks are copied here. The clock comes from `?clock=` in
// frame.html, or from the `clock` field in a Studio capture.
// - `load` keeps time from its own load, as se-curvetext did before 2026-10-14 (2613894): two copies
//   loaded at different moments draw different frames at the same instant.
// - `timeorigin` keeps time as `performance.timeOrigin + performance.now()`, which the README advised
//   until 2026-10-27. Chrome shares it between copies, but Playwright 1.54.2's fake clock does not:
//   there `timeOrigin` is the scene's fixed time, while `performance.now()` in a frame created after
//   the capture pauses the clock still counts the real time the capture host took to load, so two
//   Studio captures of one scene draw different frames.
// - `system` (the default) keeps time from the system clock as se-curvetext's fix (aec43c4) does,
//   `Date.now() - performance.now()` read once at load: every copy shares it, in Chrome and in a
//   Studio capture alike.
(function () {
  var canvas = document.getElementById('canvas');
  var clock = new URLSearchParams(location.search).get('clock') || canvas.dataset.clock || 'system';
  var startedAt = performance.now();
  var clockOffset = clock === 'timeorigin' ? performance.timeOrigin : Date.now() - performance.now();
  var context = canvas.getContext('2d');

  function seconds(now) {
    if (clock === 'load') return (now - startedAt) / 1000;
    return (clockOffset + now) / 1000;
  }

  function draw(now) {
    // One turn every 8 s: a 700 ms gap between two loads turns the bar by 31.5 degrees.
    var turn = (seconds(now) / 8) % 1;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(turn * 2 * Math.PI);
    context.fillStyle = 'rgb(228, 87, 46)';
    context.fillRect(-200, -40, 400, 80);
    context.restore();
    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
})();
