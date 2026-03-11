import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RecompileAgentSystemPromptOptions } from "../../agent/modify";
import { handleMemorySubagentCompletion } from "../../cli/helpers/memorySubagentCompletion";

const recompileAgentSystemPromptMock = mock(
  (_conversationId: string, _opts?: RecompileAgentSystemPromptOptions) =>
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
      (_agentId: string, _opts?: RecompileAgentSystemPromptOptions) =>
        Promise.resolve("compiled-system-prompt"),
    );
  });

  test("updates init progress and recompiles after successful shallow init", async () => {
    const progressUpdates: Array<{
      agentId: string;
      update: Record<string, boolean>;
    }> = [];

    const message = await handleMemorySubagentCompletion(
      {
        agentId: "agent-init-1",
        conversationId: "conv-init-1",
        subagentType: "init",
        initDepth: "shallow",
        success: true,
      },
      {
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
        recompileAgentSystemPromptImpl: recompileAgentSystemPromptMock,
        updateInitProgress: (agentId, update) => {
          progressUpdates.push({
            agentId,
            update: update as Record<string, boolean>,
          });
        },
      },
    );

    expect(message).toBe(
      "Built a memory palace of you. Visit it with /palace.",
    );
    expect(progressUpdates).toEqual([
      {
        agentId: "agent-init-1",
        update: { shallowCompleted: true },
      },
    ]);
    expect(recompileAgentSystemPromptMock).toHaveBeenCalledWith(
      "conv-init-1",
      {},
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
      updateInitProgress: () => {},
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
      updateInitProgress: () => {},
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
    expect(recompileAgentSystemPromptMock).toHaveBeenCalledWith("conv-a", {});
    expect(recompileAgentSystemPromptMock).toHaveBeenCalledWith("conv-b", {});
  });
});
