import { describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import {
  ACTING_USER_ASSERTION_ENV,
  ACTING_USER_ASSERTION_HEADER,
  ACTING_USER_ID_ENV,
  ACTING_USER_ID_HEADER,
} from "./acting-user";
import { sendMessageStreamWithBackend } from "./message";
import { composeSubagentChildEnv } from "./subagents/subagent-launcher";

function makeRecordingBackend(recordedHeaders: Array<Record<string, string>>) {
  const stream = {
    async *[Symbol.asyncIterator]() {},
  } as unknown as Stream<LettaStreamingResponse>;
  return {
    createConversationMessageStream: async (
      _conversationId: string,
      _body: unknown,
      options?: { headers?: Record<string, string> },
    ) => {
      recordedHeaders.push(options?.headers ?? {});
      return stream;
    },
  } as unknown as Backend;
}

async function sendWithPreparedContext(
  backend: Backend,
  actingUserId?: string,
  actingUserAssertion?: string,
): Promise<void> {
  const preparedToolContext = await prepareToolExecutionContextForSpecificTools(
    [],
    {
      runtimeContext: actingUserId
        ? { actingUserId, actingUserAssertion }
        : undefined,
    },
  );
  await sendMessageStreamWithBackend(
    backend,
    "conv-acting-user",
    [{ role: "user", content: "Investigate." }],
    {
      streamTokens: true,
      background: true,
      skillSources: [],
      preparedToolContext,
    },
  );
}

describe("sendMessageStream acting-user propagation", () => {
  test("uses the acting user captured in the turn tool context", async () => {
    const recordedHeaders: Array<Record<string, string>> = [];

    await sendWithPreparedContext(
      makeRecordingBackend(recordedHeaders),
      "cloud-user-a",
      "assertion-a",
    );

    expect(recordedHeaders).toEqual([
      expect.objectContaining({
        [ACTING_USER_ID_HEADER]: "cloud-user-a",
        [ACTING_USER_ASSERTION_HEADER]: "assertion-a",
      }),
    ]);
  });

  test("nested subagent child environments keep attribution on every request", async () => {
    const firstChildEnv = composeSubagentChildEnv({
      parentProcessEnv: {},
      backendMode: "api",
      parentAgentId: "agent-parent",
      launchProfile: undefined,
      inheritedPrimaryRoot: null,
      actingUserId: "cloud-user-a",
      actingUserAssertion: "assertion-a",
    });
    const nestedChildEnv = composeSubagentChildEnv({
      parentProcessEnv: firstChildEnv,
      backendMode: "api",
      parentAgentId: "agent-child",
      launchProfile: undefined,
      inheritedPrimaryRoot: null,
      actingUserId: firstChildEnv[ACTING_USER_ID_ENV],
      actingUserAssertion: firstChildEnv[ACTING_USER_ASSERTION_ENV],
    });
    const previousActingUserId = process.env[ACTING_USER_ID_ENV];
    const previousActingUserAssertion = process.env[ACTING_USER_ASSERTION_ENV];
    process.env[ACTING_USER_ID_ENV] = nestedChildEnv[ACTING_USER_ID_ENV];
    process.env[ACTING_USER_ASSERTION_ENV] =
      nestedChildEnv[ACTING_USER_ASSERTION_ENV];
    const recordedHeaders: Array<Record<string, string>> = [];

    try {
      const backend = makeRecordingBackend(recordedHeaders);
      await sendWithPreparedContext(backend);
      await sendWithPreparedContext(backend);
    } finally {
      if (previousActingUserId === undefined) {
        delete process.env[ACTING_USER_ID_ENV];
      } else {
        process.env[ACTING_USER_ID_ENV] = previousActingUserId;
      }
      if (previousActingUserAssertion === undefined) {
        delete process.env[ACTING_USER_ASSERTION_ENV];
      } else {
        process.env[ACTING_USER_ASSERTION_ENV] = previousActingUserAssertion;
      }
    }

    expect(nestedChildEnv[ACTING_USER_ID_ENV]).toBe("cloud-user-a");
    expect(nestedChildEnv[ACTING_USER_ASSERTION_ENV]).toBe("assertion-a");
    expect(recordedHeaders).toHaveLength(2);
    for (const headers of recordedHeaders) {
      expect(headers[ACTING_USER_ID_HEADER]).toBe("cloud-user-a");
      expect(headers[ACTING_USER_ASSERTION_HEADER]).toBe("assertion-a");
    }
  });
});
