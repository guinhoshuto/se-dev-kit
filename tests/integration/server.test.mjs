import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {request as httpRequest} from "node:http";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {loadProject} from "../../dist/config/load.js";
import {assetUrlPath} from "../../dist/server/assets.js";
import {startStudioServer} from "../../dist/server/server.js";

const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

function requestBuffer(url, {method = "GET", headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)})
        );
      }
    );
    request.on("error", reject);
    request.end();
  });
}

test("the studio servers bind to loopback and enforce request methods, Host, and security headers", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  const server = await startStudioServer(project, {port: 0, watch: false});
  try {
    assert.equal(server.host, "127.0.0.1");
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(server.frameOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(server.port, server.framePort);

    const get = await requestBuffer(`${server.origin}/__sws/health`);
    assert.equal(get.status, 200);
    assert.deepEqual(JSON.parse(get.body.toString("utf8")), {
      status: "ok",
      role: "control",
      frameOrigin: server.frameOrigin
    });
    assert.equal(get.headers["cache-control"], "no-store");
    assert.equal(get.headers["x-content-type-options"], "nosniff");
    assert.equal(get.headers["referrer-policy"], "no-referrer");
    assert.match(String(get.headers["permissions-policy"]), /camera=\(\)/);
    assert.equal(get.headers["access-control-allow-origin"], undefined);

    const head = await requestBuffer(`${server.origin}/__sws/health`, {method: "HEAD"});
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers["content-length"], get.headers["content-length"]);

    const methodRejected = await requestBuffer(`${server.origin}/__sws/health`, {method: "POST"});
    assert.equal(methodRejected.status, 405);
    assert.equal(methodRejected.headers.allow, "GET, HEAD");
    assert.equal(methodRejected.headers["x-content-type-options"], "nosniff");

    const hostRejected = await requestBuffer(`${server.origin}/__sws/health`, {
      headers: {Host: "malicious.example"}
    });
    assert.equal(hostRejected.status, 400);
    assert.equal(hostRejected.headers["cache-control"], "no-store");
  } finally {
    await server.close();
  }
});

test("asset serving rejects traversal and dotfiles and leaves every production file byte-for-byte unchanged", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  const productionEntries = Object.entries(project.files);
  const before = new Map(await Promise.all(productionEntries.map(async ([key, path]) => [key, await readFile(path)])));
  const server = await startStudioServer(project, {port: 0, watch: false});
  try {
    for (const [key] of productionEntries) {
      const relativePath = project.relativeFiles[key];
      const response = await requestBuffer(`${server.frameOrigin}${assetUrlPath(relativePath)}`);
      assert.equal(response.status, 200, `${key} should be served`);
      assert.deepEqual(response.body, before.get(key), `${key} should be served without rewriting bytes`);
      assert.equal(response.headers["x-content-type-options"], "nosniff");
    }

    const hostilePaths = [
      "/__sws/widget/..%2Fpackage.json",
      "/__sws/widget/%2e%2e%2fpackage.json",
      "/__sws/widget/%252e%252e%252fpackage.json",
      "/__sws/widget/.env",
      "/__sws/widget/%2Ehidden",
      "/__sws/widget/%5Cetc%5Cpasswd",
      "/__sws/widget/widget.js%00.png",
      "/__sws/widget/%E0%A4%A"
    ];
    for (const path of hostilePaths) {
      const response = await requestBuffer(`${server.frameOrigin}${path}`);
      assert.equal(response.status, 404, `${path} must not resolve to an asset`);
      assert.equal(response.body.toString("utf8"), "Not Found\n");
      assert.equal(response.body.includes(Buffer.from(project.widgetRoot)), false);
    }
  } finally {
    await server.close();
  }

  for (const [key, path] of productionEntries) {
    assert.deepEqual(await readFile(path), before.get(key), `${key} changed after serving`);
  }
});

test("built-in sample media are served only by exact manifest lookup on the frame origin", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  const manifest = JSON.parse(await readFile(new URL("../../sample-media/manifest.json", import.meta.url), "utf8"));
  const server = await startStudioServer(project, {port: 0, watch: false});
  try {
    const expected = await readFile(new URL("../../sample-media/gallery/synthwave-sunset.jpg", import.meta.url));
    const sample = await requestBuffer(`${server.frameOrigin}/__sws/sample/gallery/synthwave-sunset.jpg`);
    assert.equal(sample.status, 200);
    assert.deepEqual(sample.body, expected);
    assert.equal(sample.headers["content-type"], "image/jpeg");
    assert.equal(sample.headers["x-content-type-options"], "nosniff");
    assert.match(String(sample.headers["content-security-policy"]), /frame-ancestors/);
    assert.equal(
      await server.sampleMediaUrl("sws-sample:backdrops/aurora-mesh.jpg"),
      `${server.frameOrigin}/__sws/sample/backdrops/aurora-mesh.jpg`
    );
    await assert.rejects(server.sampleMediaUrl("sws-sample:gallery/unknown.jpg"), {code: "SAMPLE_MEDIA_NOT_FOUND"});
    await assert.rejects(server.sampleMediaUrl("sws-sample:../package.json"), {code: "SAMPLE_MEDIA_NOT_FOUND"});

    const hostilePaths = [
      "/__sws/sample/..%2Fpackage.json",
      "/__sws/sample/%2e%2e%2fpackage.json",
      "/__sws/sample/%252e%252e%252fpackage.json",
      "/__sws/sample/.hidden",
      "/__sws/sample/gallery/.hidden.jpg",
      "/__sws/sample/%5Cetc%5Cpasswd",
      "/__sws/sample/gallery/synthwave-sunset.jpg%00.png",
      "/__sws/sample/gallery/unknown.jpg",
      "/__sws/sample/manifest.json",
      "/__sws/sample/README.md",
      "/__sws/sample/gallery/",
      "/__sws/sample/%E0%A4%A"
    ];
    for (const path of hostilePaths) {
      const response = await requestBuffer(`${server.frameOrigin}${path}`);
      assert.equal(response.status, 404, `${path} must not resolve to sample media`);
      assert.equal(response.body.toString("utf8"), "Not Found\n");
    }
    const control = await requestBuffer(`${server.origin}/__sws/sample/gallery/synthwave-sunset.jpg`);
    assert.equal(control.status, 404, "the control origin must not serve sample media");

    const payload = JSON.parse((await requestBuffer(`${server.origin}/__sws/api/project`)).body.toString("utf8"));
    assert.equal(payload.sampleMedia.length, manifest.items.length);
    assert.equal(payload.sampleMediaError, undefined);
    for (const item of payload.sampleMedia) {
      assert.ok(item.url.startsWith(`${server.frameOrigin}/__sws/sample/`), item.url);
      assert.equal(item.url, `${server.frameOrigin}/__sws/sample/${item.reference.slice("sws-sample:".length)}`);
    }
    const script = await requestBuffer(`${server.origin}/__sws/ui/sample-media.js`);
    assert.equal(script.status, 200);
    assert.match(String(script.headers["content-type"]), /javascript/);
  } finally {
    await server.close();
  }
});

test("the frame server serves the frame runtime modules from a fixed list, including the Google Fonts URL module", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  const server = await startStudioServer(project, {port: 0, watch: false});
  try {
    // frame.js imports ./google-fonts-url.js; without this route the frame runtime never boots.
    for (const file of ["frame-bootstrap.js", "frame.js", "google-fonts-url.js"]) {
      const response = await requestBuffer(`${server.frameOrigin}/__sws/runtime/${file}`);
      assert.equal(response.status, 200, file);
      assert.match(String(response.headers["content-type"]), /^text\/javascript/);
      assert.deepEqual(response.body, await readFile(new URL(`../../dist/runtime/${file}`, import.meta.url)), file);
    }
    const frame = (await requestBuffer(`${server.frameOrigin}/__sws/runtime/frame.js`)).body.toString("utf8");
    assert.match(frame, /from "\.\/google-fonts-url\.js"/);
    for (const path of ["/__sws/runtime/frame.d.ts", "/__sws/runtime/frame.js.map", "/__sws/runtime/", "/__sws/runtime/frame"]) {
      assert.equal((await requestBuffer(`${server.frameOrigin}${path}`)).status, 404, path);
    }
  } finally {
    await server.close();
  }
});
