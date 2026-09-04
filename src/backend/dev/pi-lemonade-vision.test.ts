import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";
import { LocalPiModelsRuntime } from "./pi-models-runtime";

const MODEL_ID = "Qwen3.5-9B-GGUF-Q4_K_S";
const TEXT_MODEL_ID = "Qwen3-0.6B-GGUF";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function sseChatResponse(): Response {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const body = [
    chunk({
      id: "chatcmpl-lemonade",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "ok" },
          finish_reason: null,
        },
      ],
    }),
    chunk({
      id: "chatcmpl-lemonade",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

interface ConnectorScenario {
  name: string;
  providerType: string;
  providerName: string;
  runtimeProvider: string;
}

const CONNECTORS: ConnectorScenario[] = [
  {
    name: "llama.cpp",
    providerType: "llama_cpp",
    providerName: "llama-cpp",
    runtimeProvider: "llama-cpp",
  },
  {
    name: "OpenAI-compatible",
    providerType: "openai-compatible",
    providerName: "openai-compatible",
    runtimeProvider: "openai-compatible",
  },
];

describe("Lemonade vision discovery", () => {
  for (const connector of CONNECTORS) {
    test(`${connector.name} sends images for models labeled vision`, async () => {
      const chatBodies: Array<Record<string, unknown>> = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (request.method === "GET" && url.pathname === "/api/v1/models") {
            return Response.json({
              object: "list",
              data: [
                {
                  id: MODEL_ID,
                  object: "model",
                  owned_by: "lemonade",
                  recipe: "llamacpp",
                  downloaded: true,
                  labels: ["vision"],
                  context_length: 8192,
                },
                {
                  id: TEXT_MODEL_ID,
                  object: "model",
                  owned_by: "lemonade",
                  recipe: "llamacpp",
                  downloaded: true,
                  labels: ["reasoning"],
                },
              ],
            });
          }
          if (
            request.method === "POST" &&
            url.pathname === "/api/v1/chat/completions"
          ) {
            chatBodies.push((await request.json()) as Record<string, unknown>);
            return sseChatResponse();
          }
          return new Response("not found", { status: 404 });
        },
      });
      const storageDir = await mkdtemp(join(tmpdir(), "lemonade-vision-"));

      try {
        await createOrUpdateLocalProvider({
          providerType: connector.providerType,
          providerName: connector.providerName,
          apiKey: "not-needed",
          baseURL: `http://127.0.0.1:${server.port}/api/v1`,
          storageDir,
        });
        const runtime = new LocalPiModelsRuntime({ storageDir });
        await runtime.refresh(connector.runtimeProvider);
        const model = runtime.getModel(connector.runtimeProvider, MODEL_ID);
        if (!model) throw new Error("Expected Lemonade model to be discovered");

        expect(model.input).toEqual(["text", "image"]);
        expect(
          runtime.getModel(connector.runtimeProvider, TEXT_MODEL_ID)?.input,
        ).toEqual(["text"]);
        const result = await runtime
          .streamSimple(
            model,
            {
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "What is in this image?" },
                    { type: "image", mimeType: "image/png", data: PNG_BASE64 },
                  ],
                  timestamp: Date.now(),
                },
              ],
            },
            { apiKey: "not-needed", maxRetries: 0 },
          )
          .result();

        expect(result.stopReason).toBe("stop");
        const messages = chatBodies[0]?.messages as Array<{
          role: string;
          content: unknown;
        }>;
        const userContent = messages.find(
          (message) => message.role === "user",
        )?.content;
        expect(userContent).toEqual([
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
          },
        ]);
        expect(JSON.stringify(chatBodies[0])).not.toContain(
          "image omitted: model does not support images",
        );
      } finally {
        server.stop(true);
        await rm(storageDir, { recursive: true, force: true });
      }
    });
  }
});
