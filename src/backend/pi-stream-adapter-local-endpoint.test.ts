import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiStreamAdapter } from "@/backend/dev/pi-stream-adapter";
import type {
  ProviderStreamEvent,
  ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";

async function collectEvents(
  events: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const collected: ProviderStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function input(): ProviderTurnInput {
  return {
    conversationId: "local-conv-1",
    agentId: "agent-local-1",
    agent: {
      id: "agent-local-1",
      name: "Local",
      description: null,
      system: "system",
      tags: [],
      model: "bedrock/us.anthropic.claude-sonnet-4-6",
      model_settings: { provider_type: "bedrock" },
    },
    body: { messages: [] } as never,
    history: [],
    uiMessages: [
      { id: "ui-msg-1", role: "user", content: "hello", timestamp: Date.now() },
    ],
    clientTools: [],
    clientSkills: [],
  };
}

describe("PiStreamAdapter local endpoint payloads", () => {
  test("downgrades images through Pi-AI payload conversion for text-only local models", async () => {
    let capturedPayload: unknown;
    let loaded = false;
    const server = createServer(async (req, res) => {
      // Native Ollama discovery endpoints: the runtime-managed provider
      // publishes models from /api/tags + /api/show instead of fabricating
      // them, so the model must exist here to be resolvable for the turn.
      if (req.method === "GET" && req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "deepseek-r1:8b" }] }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/ps") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            models: loaded
              ? [{ name: "deepseek-r1:8b", context_length: 128000 }]
              : [],
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/api/generate") {
        loaded = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ done: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/show") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ capabilities: ["completion"] }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      capturedPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

      const responseChunks = [
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-r1:8b",
          choices: [
            {
              index: 0,
              delta: { content: "ok" },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-r1:8b",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
      ];

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "close",
      });
      res.end(
        `${responseChunks
          .map((chunk) => `data: ${JSON.stringify(chunk)}`)
          .join("\n\n")}\n\ndata: [DONE]\n\n`,
      );
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected tcp server address");
    }

    const previousOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    const storageDir = await mkdtemp(
      join(tmpdir(), "pi-stream-text-image-downgrade-"),
    );

    try {
      const baseInput = input();
      const events = await collectEvents(
        new PiStreamAdapter({ localProviderAuthStorageDir: storageDir }).stream(
          {
            ...baseInput,
            agent: {
              ...baseInput.agent,
              model: "ollama/deepseek-r1:8b",
              model_settings: { provider_type: "ollama" },
            },
            uiMessages: [
              {
                id: "ui-msg-image",
                role: "user",
                content: [
                  { type: "text", text: "describe this" },
                  { type: "image", mimeType: "image/png", data: "abc" },
                ],
                timestamp: Date.now(),
              },
            ],
          },
        ),
      );

      expect(events.some((event) => event.type === "local-message")).toBe(true);
      expect(capturedPayload).toMatchObject({
        model: "deepseek-r1:8b",
        stream: true,
      });
      const payloadJson = JSON.stringify(capturedPayload);
      expect(payloadJson).toContain(
        "(image omitted: model does not support images)",
      );
      expect(payloadJson).not.toContain("image_url");
      expect(payloadJson).not.toContain("data:image/png;base64,abc");
    } finally {
      if (previousOllamaBaseUrl === undefined) {
        delete process.env.OLLAMA_BASE_URL;
      } else {
        process.env.OLLAMA_BASE_URL = previousOllamaBaseUrl;
      }
      await rm(storageDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  // Local engines truncate an oversized prompt silently instead of erroring, so
  // the visible symptom is an agent whose persona and memory have gone missing.
  // Compaction cannot recover it — the system prompt and tool schemas are not
  // history — so the turn must fail with something the user can act on.
  test("loads an unloaded implicit-latest model and uses its exact served window", async () => {
    let chatRequests = 0;
    let psRequests = 0;
    const loadBodies: unknown[] = [];
    const servingLifecycle: string[] = [];
    let selectedLoaded = false;
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            models: [{ name: "deepseek-r1:latest" }, { name: "unselected:7b" }],
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/api/ps") {
        psRequests += 1;
        servingLifecycle.push("ps");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            models: selectedLoaded
              ? [{ name: "deepseek-r1:latest", context_length: 8192 }]
              : [],
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/api/generate") {
        servingLifecycle.push("generate");
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        loadBodies.push(body);
        selectedLoaded = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ done: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/show") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ capabilities: ["completion"] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        chatRequests += 1;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected tcp server address");
    }

    const previousOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    const storageDir = await mkdtemp(
      join(tmpdir(), "pi-stream-context-floor-"),
    );

    try {
      const baseInput = input();
      await expect(
        collectEvents(
          new PiStreamAdapter({
            localProviderAuthStorageDir: storageDir,
            onContextPressure: async () => null,
          }).stream({
            ...baseInput,
            agent: {
              ...baseInput.agent,
              model: "ollama/deepseek-r1",
              // Simulate the architectural value persisted at selection.
              model_settings: {
                provider_type: "ollama",
                context_window_limit: 128000,
              },
            },
            // Roughly 25k tokens of system prompt against the observed 8k window.
            systemPrompt: "x".repeat(100_000),
          }),
        ),
      ).rejects.toThrow(/context window/i);

      // The request must never reach the engine: sending it would mean handing
      // over a prompt we already know will be clipped.
      expect(chatRequests).toBe(0);
      expect(psRequests).toBeGreaterThanOrEqual(1);
      expect(loadBodies.length).toBeGreaterThanOrEqual(1);
      expect(loadBodies).toEqual(
        loadBodies.map(() => ({
          model: "deepseek-r1:latest",
          prompt: "",
          stream: false,
        })),
      );
      expect(servingLifecycle[0]).toBe("generate");
      expect(
        servingLifecycle.filter((event) => event === "generate"),
      ).toHaveLength(loadBodies.length);
      expect(servingLifecycle.at(-1)).toBe("ps");
    } finally {
      if (previousOllamaBaseUrl === undefined) {
        delete process.env.OLLAMA_BASE_URL;
      } else {
        process.env.OLLAMA_BASE_URL = previousOllamaBaseUrl;
      }
      await rm(storageDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  for (const failure of [
    "load",
    "post-load status",
    "post-load missing model",
  ] as const) {
    test(`fails closed when selected-model ${failure} fails`, async () => {
      let chatRequests = 0;
      let psRequests = 0;
      const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/api/tags") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ models: [{ name: "deepseek-r1:8b" }] }));
          return;
        }
        if (req.method === "GET" && req.url === "/api/ps") {
          psRequests += 1;
          if (failure === "post-load status" && psRequests > 1) {
            res.writeHead(503);
            res.end("status unavailable");
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ models: [] }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/generate") {
          if (failure === "load") {
            res.writeHead(503);
            res.end("load failed");
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ done: true }));
          }
          return;
        }
        if (req.method === "POST" && req.url === "/api/show") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              capabilities: ["completion"],
              model_info: {
                "general.architecture": "llama",
                "llama.context_length": 128000,
              },
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/chat/completions") {
          chatRequests += 1;
        }
        res.writeHead(404);
        res.end();
      });

      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected tcp server address");
      }
      const previousOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
      const storageDir = await mkdtemp(
        join(tmpdir(), "pi-stream-ollama-fail-"),
      );

      try {
        const baseInput = input();
        await expect(
          collectEvents(
            new PiStreamAdapter({
              localProviderAuthStorageDir: storageDir,
            }).stream({
              ...baseInput,
              agent: {
                ...baseInput.agent,
                model: "ollama/deepseek-r1:8b",
                model_settings: {
                  provider_type: "ollama",
                  context_window_limit: 128000,
                },
              },
            }),
          ),
        ).rejects.toThrow(/Refusing to send the prompt/i);
        expect(chatRequests).toBe(0);
      } finally {
        if (previousOllamaBaseUrl === undefined) {
          delete process.env.OLLAMA_BASE_URL;
        } else {
          process.env.OLLAMA_BASE_URL = previousOllamaBaseUrl;
        }
        await rm(storageDir, { recursive: true, force: true });
        await closeServer(server);
      }
    });
  }
});
