// A sink proxy for browser tests that must make zero external attempts (from the 2026-09-25 patch's
// harness). Every request and CONNECT it receives is recorded in `seen` and refused with a 502.
import {createServer} from "node:http";

/**
 * Starts the sink on 127.0.0.1. A browser often resets the CONNECT tunnel after the 502 (SDK-43:
 * an unhandled ECONNRESET on that socket crashed the test process now and then), so a socket
 * error is recorded in `errors`, never thrown.
 */
export async function startSink() {
  const seen = [];
  const errors = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.writeHead(502);
    response.end();
  });
  server.on("connect", (request, socket) => {
    seen.push(`CONNECT ${request.url}`);
    socket.on("error", (error) => errors.push(error.code ?? error.message));
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {seen, errors, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve))};
}
