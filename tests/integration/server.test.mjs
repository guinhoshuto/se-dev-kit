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
