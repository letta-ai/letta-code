const http = require("node:http");

/** Forward to real Ollama; faults affect only inference, never discovery/load. */
async function createFaultProxy(upstream, outboundProxy) {
  const target = new URL(upstream);
  const relay = outboundProxy ? new URL(outboundProxy) : null;
  const requests = [];
  const sockets = new Set();
  let fault = "none";
  let delayMs = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const inference = req.url === "/v1/chat/completions";
    const mode = inference ? fault : "none";
    const record = { path: req.url, mode, started: Date.now() };
    if (inference) {
      const payload = JSON.parse(body.toString());
      record.model = payload.model;
      record.toolCount = payload.tools?.length ?? 0;
      record.systemChars =
        payload.messages
          ?.filter((m) => m.role === "system")
          .reduce((n, m) => n + JSON.stringify(m.content).length, 0) ?? 0;
    }
    requests.push(record);
    res.on("close", () => {
      record.closed = Date.now();
    });
    if (mode === "timeout") return; // Client must enforce its own deadline.
    let outgoing;
    let timer;
    res.on("close", () => {
      clearTimeout(timer);
      outgoing?.destroy();
    });
    const forward = () => {
      if (res.destroyed) return;
      const url = new URL(req.url, target);
      outgoing = http.request(
        relay ?? url,
        {
          method: req.method,
          path: relay ? url.href : url.pathname + url.search,
          headers: { ...req.headers, host: url.host, connection: "close" },
        },
        (response) => {
          record.status = response.statusCode;
          record.headersAt = Date.now();
          res.writeHead(response.statusCode, response.headers);
          let buffer = "";
          let dropped = false;
          response.on("data", (chunk) => {
            if (dropped) return;
            if (inference)
              record.response = (
                (record.response ?? "") + chunk.toString()
              ).slice(0, 65536);
            res.write(chunk);
            if (mode !== "drop") return;
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data: {") || dropped) continue;
              try {
                const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
                if (
                  delta?.content ||
                  delta?.reasoning ||
                  delta?.reasoning_content ||
                  delta?.tool_calls?.length
                ) {
                  dropped = true;
                  record.droppedAfterOutput = true;
                  // Flush real model output before breaking the stream.
                  timer = setTimeout(() => {
                    res.destroy();
                    outgoing.destroy();
                  }, 50);
                }
              } catch {
                /* Wait for the next complete SSE event. */
              }
            }
          });
          response.on("end", () => {
            if (!dropped) res.end();
          });
          response.on("error", () => res.destroy());
        },
      );
      outgoing.on("error", (error) => {
        record.error = error.message;
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      outgoing.end(body);
    };
    if (mode === "delay") timer = setTimeout(forward, delayMs);
    else forward();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    setFault(mode, delay = 0) {
      fault = mode;
      delayMs = delay;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createFaultProxy };
