/**
 * A scripted OpenAI-compatible Chat Completions server for exercising native
 * worker CLIs (such as pi) end to end without a real provider or API key.
 *
 * Replies, by the latest message:
 * - a user message containing "RUN_TOOL" gets one `bash` tool call that runs
 *   `echo tool-ran`;
 * - a tool result gets "Tool said: <output>";
 * - a user message containing "STEER" gets "Steered: <text>";
 * - a user message containing "SLOW" streams its reply after `slowMs`;
 * - anything else gets "Turns so far: <number of user messages>".
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOpenAiChatServer {
  baseUrl: string;
  requests: number;
  close(): Promise<void>;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

export async function startFakeOpenAiChatServer(
  options: { slowMs?: number } = {},
): Promise<FakeOpenAiChatServer> {
  const state = { requests: 0 };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", async () => {
      state.requests += 1;
      const messages: ChatMessage[] =
        (JSON.parse(body || "{}") as { messages?: ChatMessage[] }).messages ??
        [];
      const last = messages.at(-1);
      const lastText = text(last?.content);
      const users = messages.filter((message) => message.role === "user");
      if (lastText.includes("SLOW"))
        await new Promise((resolve) =>
          setTimeout(resolve, options.slowMs ?? 1_500),
        );
      response.writeHead(200, { "content-type": "text/event-stream" });
      const base = {
        id: `chatcmpl-${state.requests}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "fake-1",
      };
      const send = (delta: Record<string, unknown>, finish?: string) =>
        response.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta, finish_reason: finish ?? null }],
            ...(finish
              ? {
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                  },
                }
              : {}),
          })}\n\n`,
        );
      if (last?.role === "user" && lastText.includes("RUN_TOOL")) {
        send({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${state.requests}`,
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "echo tool-ran" }),
              },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        const reply =
          last?.role === "tool"
            ? `Tool said: ${lastText.trim()}`
            : lastText.includes("STEER")
              ? `Steered: ${lastText}`
              : `Turns so far: ${users.length}`;
        send({ role: "assistant", content: reply });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A pi `models.json` that routes the `fake/fake-1` model to the server. */
export function fakePiModelsJson(baseUrl: string): string {
  return JSON.stringify({
    providers: {
      fake: {
        baseUrl,
        api: "openai-completions",
        apiKey: "fake-key",
        models: [{ id: "fake-1", name: "Fake One" }],
      },
    },
  });
}
