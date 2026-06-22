import { beforeEach, describe, expect, mock, test } from "bun:test";
import { handleMemorySubagentCompletion } from "@/cli/helpers/memory-subagent-completion";
import {
  estimateSystemTokens,
  getSystemPromptDoctorState,
} from "@/cli/helpers/system-prompt-warning";

const recompileAgentSystemPromptMock = mock(
  (_conversationId: string, _agentId: string, _dryRun?: boolean) =>
    Promise.resolve("compiled-system-prompt"),
);

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("memory subagent recompile handling", () => {
  beforeEach(() => {
    recompileAgentSystemPromptMock.mockReset();
    recompileAgentSystemPromptMock.mockImplementation(
      (_conversationId: string, _agentId: string, _dryRun?: boolean) =>
        Promise.resolve("compiled-system-prompt"),
    );
  });

  test("recompiles system prompt after successful init", async () => {
    const message = await handleMemorySubagentCompletion(
      {
        agentId: "agent-init-1",
        conversationId: "conv-init-1",
        subagentType: "init",
        success: true,
      },
      {
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
        recompileAgentSystemPromptImpl: recompileAgentSystemPromptMock,
      },
    );

    expect(message).toBe(
      "Built a memory palace of you. Visit it with /palace.",
    );
    expect(recompileAgentSystemPromptMock).toHaveBeenCalledWith(
      "conv-init-1",
      "agent-init-1",
    );

    expect(getSystemPromptDoctorState("agent-init-1")).toEqual({
      estimated_tokens: estimateSystemTokens("compiled-system-prompt"),
      should_doctor: false,
      updated_at_ms: expect.any(Number),
    });
  });

  test("passes agent id when recompiling the default conversation", async () => {
    await handleMemorySubagentCompletion(
      {
        agentId: "agent-default",
        conversationId: "default",
        subagentType: "reflection",
        success: true,
      },
      {
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
        recompileAgentSystemPromptImpl: recompileAgentSystemPromptMock,
      },
    );

    expect(recompileAgentSystemPromptMock).toHaveBeenCalledWith(
      "default",
      "agent-default",
    );
  });

  test("queues a trailing recompile when later completions land mid-flight", async () => {
    const firstDeferred = createDeferred<string>();
    const secondDeferred = createDeferred<string>();
    recompileAgentSystemPromptMock
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockImplementationOnce(() => secondDeferred.promise);

    const recompileByConversation = new Map<string, Promise<void>>();
    const recompileQueuedByConversation = new Set<string>();
    const deps = {
      recompileByConversation,
      recompileQueuedByConversation,
      recompileAgentSystemPromptImpl: recompileAgentSystemPromptMock,
    };

    const first = handleMemorySubagentCompletion(
      {
        agentId: "agent-shared",
        conversationId: "conv-shared",
        subagentType: "reflection",
        success: true,
      },
      deps,
    );
    const second = handleMemorySubagentCompletion(
      {
        agentId: "agent-shared",
        conversationId: "conv-shared",
        subagentType: "reflection",
        success: true,
      },
      deps,
    );
    const third = handleMemorySubagentCompletion(
      {
        agentId: "agent-shared",
        conversationId: "conv-shared",
        subagentType: "reflection",
        success: true,
      },
      deps,
    );

    expect(recompileAgentSystemPromptMock).toHaveBeenCalledTimes(1);
    expect(recompileByConversation.has("conv-shared")).toBe(true);
    expect(recompileQueuedByConversation.has("conv-shared")).toBe(true);

    firstDeferred.resolve("compiled-system-prompt");
    await Promise.resolve();

    expect(recompileAgentSystemPromptMock).toHaveBeenCalledTimes(2);
    expect(recompileByConversation.has("conv-shared")).toBe(true);

    secondDeferred.resolve("compiled-system-prompt");

    const [firstMessage, secondMessage, thirdMessage] = await Promise.all([
      first,
      second,
      third,
    ]);
    expect(firstMessage).toBe(
      "Reflected on /palace, the halls remember more now.",
    );
    expect(secondMessage).toBe(
      "Reflected on /palace, the halls remember more now.",
    );
    expect(thirdMessage).toBe(
      "Reflected on /palace, the halls remember more now.",
    );
    expect(recompileByConversation.size).toBe(0);
    expect(recompileQueuedByConversation.size).toBe(0);
  });

  test("does not coalesce recompiles across different conversations for same agent", async () => {
    const deps = {
      recompileByConversation: new Map<string, Promise<void>>(),
      recompileQueuedByConversation: new Set<string>(),
      recompileAgentSystemPromptImpl: recompileAgentSystemPromptMock,
    };

    const [firstMessage, secondMessage] = await Promise.all([
      handleMemorySubagentCompletion(
        {
          agentId: "agent-shared",
          conversationId: "conv-a",
          subagentType: "reflection",
          success: true,
        },
        deps,
      ),
      handleMemorySubagentCompletion(
        {
          agentId: "agent-shared",
          conversationId: "conv-b",
          subagentType: "reflection",
          success: true,
        },
        deps,
      ),
    ]);

    expect(firstMessage).toBe(
      "Reflected on /palace, the halls remember more now.",
    );
    expect(secondMessage).toBe(
      "Reflected on /palace, the halls remember more now.",
    );
    expect(recompileAgentSystemPromptMock).toHaveBeenCalledTimes(2);
    expect(recompileAgentSystemPromptMock).toHaveBeenCalledWith(
      "conv-a",
      "agent-shared",
    );
    expect(recompileAgentSystemPromptMock).toHaveBeenCalledWith(
      "conv-b",
      "agent-shared",
    );
  });

  test("includes reflection failure detail", async () => {
    const message = await handleMemorySubagentCompletion(
      {
        agentId: "agent-reflection-fail",
        conversationId: "conv-reflection-fail",
        subagentType: "reflection",
        success: false,
        error: "provider returned 500",
      },
      {
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
        recompileAgentSystemPromptImpl: recompileAgentSystemPromptMock,
      },
    );

    expect(message).toBe(
      "Tried to reflect, but got lost in the palace: provider returned 500",
    );
    expect(recompileAgentSystemPromptMock).not.toHaveBeenCalled();
  });

  test("truncates long multiline reflection failure detail", async () => {
    const message = await handleMemorySubagentCompletion(
      {
        agentId: "agent-reflection-long-fail",
        conversationId: "conv-reflection-long-fail",
        subagentType: "reflection",
        success: false,
        error: `first line\n${"x".repeat(400)}\nfinal line`,
      },
      {
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
        recompileAgentSystemPromptImpl: recompileAgentSystemPromptMock,
      },
    );

    const prefix = "Tried to reflect, but got lost in the palace: ";
    expect(message.startsWith(prefix)).toBe(true);
    expect(message).not.toContain("\n");
    expect(message).not.toContain("final line");
    expect(message.endsWith("...")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(prefix.length + 200);
  });

  test("init failure still includes error detail", async () => {
    const message = await handleMemorySubagentCompletion(
      {
        agentId: "agent-init-fail",
        conversationId: "conv-init-fail",
        subagentType: "init",
        success: false,
        error: "memory root unavailable",
      },
      {
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
        recompileAgentSystemPromptImpl: recompileAgentSystemPromptMock,
      },
    );

    expect(message).toBe(
      "Memory initialization failed: memory root unavailable",
    );
    expect(recompileAgentSystemPromptMock).not.toHaveBeenCalled();
  });
});
