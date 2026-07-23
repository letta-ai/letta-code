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
    const server = createServer(async (req, res) => {
      // Native Ollama discovery endpoints: the runtime-managed provider
      // publishes models from /api/tags + /api/show instead of fabricating
      // them, so the model must exist here to be resolvable for the turn.
      if (req.method === "GET" && req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "deepseek-r1:8b" }] }));
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
});
