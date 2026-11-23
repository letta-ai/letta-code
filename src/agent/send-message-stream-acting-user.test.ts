import { afterEach, describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  clearMcpOriginatorTokens,
  setMcpOriginatorToken,
} from "@/agent/mcp-originator-tokens";
import type { Backend } from "@/backend";
import { runWithRuntimeContext } from "@/runtime-context";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import { ACTING_USER_ID_ENV, ACTING_USER_ID_HEADER } from "./acting-user";
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
  mcpOriginatorSuperRunId?: string,
): Promise<void> {
  const preparedToolContext = await prepareToolExecutionContextForSpecificTools(
    [],
    {
      runtimeContext:
        actingUserId || mcpOriginatorSuperRunId
          ? { actingUserId, mcpOriginatorSuperRunId }
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
  afterEach(() => clearMcpOriginatorTokens());

  test("uses the acting user and originator captured in the turn tool context", async () => {
    const recordedHeaders: Array<Record<string, string>> = [];
    setMcpOriginatorToken("super-run-a", "originator-token-a");

    await sendWithPreparedContext(
      makeRecordingBackend(recordedHeaders),
      "cloud-user-a",
      "super-run-a",
    );

    expect(recordedHeaders).toEqual([
      expect.objectContaining({
        [ACTING_USER_ID_HEADER]: "cloud-user-a",
        "x-letta-mcp-originator-token": "originator-token-a",
        "x-letta-mcp-originator-isolation": "1",
        "x-letta-mcp-originator-super-run-id": "super-run-a",
      }),
    ]);
  });

  test("explicit null suppresses inherited and ambient attribution", async () => {
    const preparedToolContext =
      await prepareToolExecutionContextForSpecificTools([], {
        runtimeContext: {
          actingUserId: "runtime-user",
          mcpOriginatorSuperRunId: null,
        },
      });
    const previousActingUserId = process.env[ACTING_USER_ID_ENV];
    process.env[ACTING_USER_ID_ENV] = "ambient-user";
    setMcpOriginatorToken("ambient-super-run", "ambient-originator-token");
    const recordedHeaders: Array<Record<string, string>> = [];

    try {
      await runWithRuntimeContext(
        { mcpOriginatorSuperRunId: "ambient-super-run" },
        () =>
          sendMessageStreamWithBackend(
            makeRecordingBackend(recordedHeaders),
            "conv-acting-user",
            [{ role: "user", content: "Unattributed system input." }],
            {
              streamTokens: true,
              background: true,
              skillSources: [],
              preparedToolContext,
              actingUserId: null,
            },
          ),
      );
    } finally {
      if (previousActingUserId === undefined) {
        delete process.env[ACTING_USER_ID_ENV];
      } else {
        process.env[ACTING_USER_ID_ENV] = previousActingUserId;
      }
    }

    expect(recordedHeaders).toHaveLength(1);
    expect(recordedHeaders[0]?.[ACTING_USER_ID_HEADER]).toBeUndefined();
    expect(
      recordedHeaders[0]?.["x-letta-mcp-originator-token"],
    ).toBeUndefined();
    expect(
      recordedHeaders[0]?.["x-letta-mcp-originator-super-run-id"],
    ).toBeUndefined();
  });

  test("nested subagent child environments keep attribution on every request", async () => {
    const firstChildEnv = composeSubagentChildEnv({
      parentProcessEnv: {},
      backendMode: "api",
      parentAgentId: "agent-parent",
      launchProfile: undefined,
      inheritedPrimaryRoot: null,
      actingUserId: "cloud-user-a",
    });
    const nestedChildEnv = composeSubagentChildEnv({
      parentProcessEnv: firstChildEnv,
      backendMode: "api",
      parentAgentId: "agent-child",
      launchProfile: undefined,
      inheritedPrimaryRoot: null,
      actingUserId: firstChildEnv[ACTING_USER_ID_ENV],
    });
    const previousActingUserId = process.env[ACTING_USER_ID_ENV];
    process.env[ACTING_USER_ID_ENV] = nestedChildEnv[ACTING_USER_ID_ENV];
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
    }

    expect(nestedChildEnv[ACTING_USER_ID_ENV]).toBe("cloud-user-a");
    expect(recordedHeaders).toHaveLength(2);
    for (const headers of recordedHeaders) {
      expect(headers[ACTING_USER_ID_HEADER]).toBe("cloud-user-a");
    }
  });
});
