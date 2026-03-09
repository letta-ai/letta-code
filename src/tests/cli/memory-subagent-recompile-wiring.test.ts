import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RecompileAgentSystemPromptOptions } from "../../agent/modify";
import { handleMemorySubagentCompletion } from "../../cli/helpers/memorySubagentCompletion";

const recompileAgentSystemPromptMock = mock(
  (_agentId: string, _opts?: RecompileAgentSystemPromptOptions) =>
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
        subagentType: "init",
        initDepth: "shallow",
        success: true,
      },
      {
        recompileByAgent: new Map(),
        recompileQueuedByAgent: new Set(),
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
      "agent-init-1",
      {
        updateTimestamp: true,
      },
    );
  });

  test("queues a trailing recompile when later completions land mid-flight", async () => {
    const firstDeferred = createDeferred<string>();
    const secondDeferred = createDeferred<string>();
    recompileAgentSystemPromptMock
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockImplementationOnce(() => secondDeferred.promise);

    const recompileByAgent = new Map<string, Promise<void>>();
    const recompileQueuedByAgent = new Set<string>();
    const deps = {
      recompileByAgent,
      recompileQueuedByAgent,
      recompileAgentSystemPromptImpl: recompileAgentSystemPromptMock,
      updateInitProgress: () => {},
    };

    const first = handleMemorySubagentCompletion(
      {
        agentId: "agent-shared",
        subagentType: "reflection",
        success: true,
      },
      deps,
    );
    const second = handleMemorySubagentCompletion(
      {
        agentId: "agent-shared",
        subagentType: "reflection",
        success: true,
      },
      deps,
    );
    const third = handleMemorySubagentCompletion(
      {
        agentId: "agent-shared",
        subagentType: "reflection",
        success: true,
      },
      deps,
    );

    expect(recompileAgentSystemPromptMock).toHaveBeenCalledTimes(1);
    expect(recompileByAgent.has("agent-shared")).toBe(true);
    expect(recompileQueuedByAgent.has("agent-shared")).toBe(true);

    firstDeferred.resolve("compiled-system-prompt");
    await Promise.resolve();

    expect(recompileAgentSystemPromptMock).toHaveBeenCalledTimes(2);
    expect(recompileByAgent.has("agent-shared")).toBe(true);

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
    expect(recompileByAgent.size).toBe(0);
    expect(recompileQueuedByAgent.size).toBe(0);
  });
});
