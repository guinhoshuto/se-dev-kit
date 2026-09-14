export function renderCapturePage(frameOrigin: string): string {
  const safeFrameOrigin = frameOrigin.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>SE Widget Studio Capture Host</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
    #capture-stage { position: relative; overflow: hidden; isolation: isolate; }
    #widget-wrap { position: absolute; left: 50%; top: 50%; }
    #widget-frame { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
  </style>
</head>
<body data-frame-origin="${safeFrameOrigin}">
  <main id="capture-stage">
    <div id="widget-wrap">
      <iframe id="widget-frame" title="Widget capture" sandbox="allow-scripts allow-same-origin"></iframe>
    </div>
  </main>
  <script type="module" src="/__sws/ui/capture-host.js"></script>
</body>
</html>`;
}
