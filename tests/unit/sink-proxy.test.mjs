// SDK-43: the sink proxy of the zero-external-attempts render test must survive a browser that
// resets the CONNECT tunnel after the 502, and keep answering.
import assert from "node:assert/strict";
import {connect} from "node:net";
import test from "node:test";

import {startSink} from "../integration/sink-proxy.mjs";

/** Sends a CONNECT, waits for the sink's first answer bytes, then resets the connection (TCP RST). */
function connectAndReset(port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write("CONNECT fonts.gstatic.com:443 HTTP/1.1\r\nHost: fonts.gstatic.com:443\r\n\r\n\x16\x03\x01\x02\x00\x01");
    });
    socket.once("data", (chunk) => {
      socket.resetAndDestroy();
      resolve(chunk.toString("latin1"));
    });
    socket.once("error", reject);
  });
}

/** One plain proxied GET through the sink; resolves to the status line. */
function plainGet(port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write("GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n"));
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString("latin1")));
    socket.on("end", () => resolve(text.split("\r\n")[0]));
    socket.on("error", reject);
  });
}

test("the sink records a reset CONNECT tunnel without crashing, and keeps answering", {timeout: 20_000}, async () => {
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  const sink = await startSink();
  const port = Number(new URL(sink.url).port);
  try {
    for (let round = 0; round < 25; round += 1) {
      assert.match(await connectAndReset(port), /^HTTP\/1\.1 502 /);
    }
    // Give the sink's side of each reset time to surface.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await plainGet(port), "HTTP/1.1 502 Bad Gateway");
    assert.equal(sink.seen.filter((line) => line === "CONNECT fonts.gstatic.com:443").length, 25);
    assert.deepEqual(uncaught.map((error) => error.code ?? error.message), [], "no socket error escaped the sink");
    assert.ok(sink.errors.includes("ECONNRESET"), `the resets reached the sink: ${JSON.stringify(sink.errors)}`);
  } finally {
    process.off("uncaughtException", onUncaught);
    await sink.close();
  }
});
