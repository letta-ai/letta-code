import { describe, expect, test } from "bun:test";

const BASE_URL = process.env.LETTA_BASE_URL ?? "http://127.0.0.1:8384";
const ORG_ID = "org-00000000-0000-4000-8000-000000000000";

type StreamMetrics = {
  assistantChunkCount: number;
  firstAssistantAtMs: number | null;
  doneAtMs: number | null;
};

async function createAgent(): Promise<string> {
  const response = await fetch(`${BASE_URL}/v1/agents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-organization-id": ORG_ID,
    },
    body: JSON.stringify({
      name: "agent-streaming-timing-test",
      model: "anthropic/claude-sonnet-4-20250514",
      embedding: "openai/text-embedding-3-small",
      memory_blocks: [
        { label: "human", value: "hi" },
        { label: "persona", value: "assistant" },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to create agent: ${response.status} ${await response.text()}`,
    );
  }

  const data = await response.json();
  return data.id as string;
}

async function collectAgentStreamMetrics(
  agentId: string,
): Promise<StreamMetrics> {
  const response = await fetch(`${BASE_URL}/v1/agents/${agentId}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-organization-id": ORG_ID,
    },
    body: JSON.stringify({
      streaming: true,
      background: true,
      messages: [
        {
          role: "user",
          content:
            "Output the numbers 1 through 120 separated by spaces. Do not add any other words.",
        },
      ],
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Streaming request failed: ${response.status} ${await response.text()}`,
    );
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const startedAt = performance.now();

  let buffer = "";
  let assistantChunkCount = 0;
  let firstAssistantAtMs: number | null = null;
  let doneAtMs: number | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      const payload = line.slice(6);
      if (payload === "[DONE]") {
        doneAtMs = performance.now() - startedAt;
        return { assistantChunkCount, firstAssistantAtMs, doneAtMs };
      }

      try {
        const parsed = JSON.parse(payload) as { message_type?: string };
        if (parsed.message_type === "assistant_message") {
          assistantChunkCount += 1;
          if (firstAssistantAtMs === null) {
            firstAssistantAtMs = performance.now() - startedAt;
          }
        }
      } catch {
        // ignore malformed lines in test parsing
      }
    }
  }

  return { assistantChunkCount, firstAssistantAtMs, doneAtMs };
}

describe("agent streaming timing", () => {
  test("/v1/agents/:id/messages streams incrementally instead of dumping at end", async () => {
    const agentId = await createAgent();
    const metrics = await collectAgentStreamMetrics(agentId);

    expect(metrics.assistantChunkCount).toBeGreaterThan(3);
    expect(metrics.firstAssistantAtMs).not.toBeNull();
    expect(metrics.doneAtMs).not.toBeNull();

    const streamTailMs =
      (metrics.doneAtMs ?? 0) - (metrics.firstAssistantAtMs ?? 0);
    expect(streamTailMs).toBeGreaterThan(75);
  }, 120_000);
});
