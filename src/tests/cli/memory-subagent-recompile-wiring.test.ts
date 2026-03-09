import { beforeEach, describe, expect, mock, test } from "bun:test";

const recompileAgentSystemPromptMock = mock(
  (_agentId: string, _opts?: Record<string, unknown>) =>
    Promise.resolve("compiled-system-prompt"),
);

mock.module("../../agent/modify", () => ({
  recompileAgentSystemPrompt: recompileAgentSystemPromptMock,
}));

const { handleMemorySubagentCompletion } = await import(
  "../../cli/helpers/memorySubagentCompletion"
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
    recompileAgentSystemPromptMock.mockClear();
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

  test("deduplicates concurrent recompiles for the same agent", async () => {
    const deferred = createDeferred<string>();
    recompileAgentSystemPromptMock.mockImplementationOnce(
      () => deferred.promise,
    );

    const recompileByAgent = new Map<string, Promise<void>>();
    const deps = {
      recompileByAgent,
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

    expect(recompileAgentSystemPromptMock).toHaveBeenCalledTimes(1);
    expect(recompileByAgent.has("agent-shared")).toBe(true);

    deferred.resolve("compiled-system-prompt");

    const [firstMessage, secondMessage] = await Promise.all([first, second]);
    expect(firstMessage).toBe(
      "Reflected on /palace, the halls remember more now.",
    );
    expect(secondMessage).toBe(
      "Reflected on /palace, the halls remember more now.",
    );
    expect(recompileByAgent.size).toBe(0);
  });
});
