import test from "node:test";

// A handle that keeps the event loop alive forever, like a browser whose close never returns.
setInterval(() => {}, 1000);

test("never settles", () => new Promise(() => {}));
