import { describe, expect, test } from "bun:test";
import { getEventListeners, once } from "node:events";
import { createServer } from "node:http";
import { createRelayedAbortController } from "../../utils/createRelayedAbortController";

describe("createRelayedAbortController", () => {
  test("does not accumulate parent abort listeners across repeated fetches", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected tcp server address");
    }

    const parent = new AbortController();

    for (let i = 0; i < 12; i += 1) {
      const requestAbort = createRelayedAbortController(parent.signal);
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        signal: requestAbort.signal,
      });
      await response.text();
      requestAbort.cleanup();

      expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
});
