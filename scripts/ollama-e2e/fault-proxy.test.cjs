const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createFaultProxy } = require("./fault-proxy.cjs");

test("faults preserve discovery and recover without replacing the proxy", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") return res.end('{"models":[]}');
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 300);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await createFaultProxy(
    `http://127.0.0.1:${upstream.address().port}`,
  );
  const infer = (signal) =>
    fetch(proxy.url + "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "fixture" }),
      signal,
    }).then((response) => response.text());
  try {
    proxy.setFault("timeout");
    assert.deepEqual(
      await fetch(proxy.url + "/api/tags").then((r) => r.json()),
      { models: [] },
    );
    await assert.rejects(infer(AbortSignal.timeout(100)));
    proxy.setFault("drop");
    // Node 22.19's fetch accepts premature EOF as a completed body. Check
    // HTTP framing directly so this test proves the proxy broke the stream,
    // independently of the fetch implementation bundled with Node.
    await new Promise((resolve, reject) => {
      const request = http.request(
        `${proxy.url}/v1/chat/completions`,
        {
          method: "POST",
          signal: AbortSignal.timeout(2000),
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            reject(new Error("Dropped stream completed normally")),
          );
          response.on("error", (error) => {
            try {
              assert.equal(error.code, "ECONNRESET");
              assert.equal(response.complete, false);
              assert.match(text, /hello/);
              assert.doesNotMatch(text, /DONE/);
              resolve();
            } catch (failure) {
              reject(failure);
            }
          });
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ model: "fixture" }));
    });
    assert.equal(proxy.requests.at(-1).droppedAfterOutput, true);
    proxy.setFault("delay", 100);
    const started = Date.now();
    assert.match(await infer(AbortSignal.timeout(2000)), /DONE/);
    assert.ok(proxy.requests.at(-1).headersAt - started >= 90);
    proxy.setFault("none");
    assert.match(await infer(AbortSignal.timeout(2000)), /DONE/);
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
