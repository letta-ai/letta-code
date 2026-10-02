import { afterEach, describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import {
  __testSeedSecretsCache,
  clearSecretsCache,
} from "@/utils/secrets-store";
import { sendMessageStreamWithBackend } from "./message";

const AGENT_ID = "agent-send-message-scrub-test";
const SECRET_KEY = "PASTED_VAULT_TOKEN";
const SECRET_VALUE = "pasted-vault-value-abcdef-0123456789";

function makeRecordingBackend(recordedBodies: unknown[]): Backend {
  const stream = {
    async *[Symbol.asyncIterator]() {},
  } as unknown as Stream<LettaStreamingResponse>;
  return {
    createConversationMessageStream: async (
      _conversationId: string,
      body: unknown,
    ) => {
      recordedBodies.push(body);
      return stream;
    },
  } as unknown as Backend;
}

async function sendUserMessage(
  backend: Backend,
  content: string | Array<unknown>,
): Promise<void> {
  const preparedToolContext = await prepareToolExecutionContextForSpecificTools(
    [],
    {},
  );
  await sendMessageStreamWithBackend(
    backend,
    "conv-secret-scrub",
    [{ role: "user", content } as never],
    {
      streamTokens: true,
      background: true,
      skillSources: [],
      preparedToolContext,
      agentId: AGENT_ID,
    },
  );
}

afterEach(() => {
  clearSecretsCache(AGENT_ID);
});

describe("sendMessageStream user-message secret scrubbing", () => {
  test("string content containing a vault secret is scrubbed before send", async () => {
    __testSeedSecretsCache(AGENT_ID, { [SECRET_KEY]: SECRET_VALUE });
    const bodies: unknown[] = [];

    await sendUserMessage(
      makeRecordingBackend(bodies),
      `my token is ${SECRET_VALUE} please use it`,
    );

    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).toContain(`${SECRET_KEY}=<REDACTED>`);
  });

  test("text content parts containing a vault secret are scrubbed before send", async () => {
    __testSeedSecretsCache(AGENT_ID, { [SECRET_KEY]: SECRET_VALUE });
    const bodies: unknown[] = [];

    await sendUserMessage(makeRecordingBackend(bodies), [
      { type: "text", text: `pasted: ${SECRET_VALUE}` },
    ]);

    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).toContain(`${SECRET_KEY}=<REDACTED>`);
  });

  test("messages without secrets pass through unchanged", async () => {
    __testSeedSecretsCache(AGENT_ID, { [SECRET_KEY]: SECRET_VALUE });
    const bodies: unknown[] = [];

    await sendUserMessage(makeRecordingBackend(bodies), "no secrets here");

    const messages = (bodies[0] as { messages: Array<{ content: unknown }> })
      .messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("no secrets here");
  });
});
