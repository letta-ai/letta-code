import { afterEach, describe, expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import { __testSetBackend, type Backend } from "@/backend";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { sendMessageStreamWithRetry } from "./send";
import type { ListenerTransport } from "./transport";

const BUSY_DETAIL =
  "Cannot send a new message: Another request is currently being processed for this conversation.";

function createTransport(): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
}

/** Backend whose send 409s once and records each stream-resume body. */
function installBusyBackend(detail: string): Record<string, unknown>[] {
  const resumeBodies: Record<string, unknown>[] = [];
  __testSetBackend({
    capabilities: {},
    async createConversationMessageStream() {
      throw new APIError(409, { error: { detail } }, undefined, new Headers());
    },
    async streamConversationMessages(
      _conversationId: string,
      body: Record<string, unknown>,
    ) {
      resumeBodies.push(body);
      return { controller: new AbortController() };
    },
  } as unknown as Backend);
  return resumeBodies;
}

async function sendRejectedInput(): Promise<void> {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-1",
    "conv-1",
  );
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  await sendMessageStreamWithRetry(
    "conv-1",
    [{ role: "user", content: "hello", otid: "otid-rejected" } as never],
    {
      preparedToolContext: {
        contextId: "context-1",
        loadedToolNames: [],
        clientTools: [],
        clientSkills: [],
      } as never,
      skillSources: [],
    },
    createTransport(),
    runtime,
    lease,
  );
}

afterEach(() => {
  __testSetBackend(null);
});

describe("busy 409 stream resume", () => {
  test("resumes the blocking run by run_id instead of the rejected input's otid", async () => {
    const resumeBodies = installBusyBackend(
      `${BUSY_DETAIL} run_id=run-blocker`,
    );

    await sendRejectedInput();

    expect(resumeBodies).toHaveLength(1);
    expect(resumeBodies[0]?.run_id).toBe("run-blocker");
    expect(resumeBodies[0]).not.toHaveProperty("otid");
  });

  test("falls back to the input otid when the 409 names no run", async () => {
    const resumeBodies = installBusyBackend(BUSY_DETAIL);

    await sendRejectedInput();

    expect(resumeBodies).toHaveLength(1);
    expect(resumeBodies[0]?.otid).toBe("otid-rejected");
    expect(resumeBodies[0]).not.toHaveProperty("run_id");
  });
});
