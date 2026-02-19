import { describe, expect, mock, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { createAgentWithBaseToolsRecovery } from "../../agent/create";

function missingBaseToolsError(): Error & { status: number } {
  return Object.assign(
    new Error(
      `400 {"detail":"Tools not found by name: {'fetch_webpage', 'memory'}"}`,
    ),
    { status: 400 },
  );
}

describe("createAgentWithBaseToolsRecovery", () => {
  const mkAgent = (id: string): AgentState => ({ id }) as unknown as AgentState;

  test("bootstraps base tools then retries with original tools", async () => {
    const createWithTools = mock((_tools: string[]) => {
      if (createWithTools.mock.calls.length === 1) {
        return Promise.reject(missingBaseToolsError());
      }
      return Promise.resolve(mkAgent("agent-retry-success"));
    });
    const addBaseTools = mock(() => Promise.resolve(true));

    const agent = await createAgentWithBaseToolsRecovery(
      createWithTools,
      ["memory", "web_search", "fetch_webpage"],
      addBaseTools,
    );

    expect(agent.id).toBe("agent-retry-success");
    expect(addBaseTools).toHaveBeenCalledTimes(1);
    expect(createWithTools).toHaveBeenCalledTimes(2);
    expect(createWithTools.mock.calls[0]?.[0]).toEqual([
      "memory",
      "web_search",
      "fetch_webpage",
    ]);
    expect(createWithTools.mock.calls[1]?.[0]).toEqual([
      "memory",
      "web_search",
      "fetch_webpage",
    ]);
  });

  test("falls back to create with no server-side tools after second failure", async () => {
    const createWithTools = mock((_tools: string[]) => {
      if (createWithTools.mock.calls.length <= 2) {
        return Promise.reject(
          createWithTools.mock.calls.length === 1
            ? missingBaseToolsError()
            : new Error("still failing after bootstrap"),
        );
      }
      return Promise.resolve(mkAgent("agent-no-tools"));
    });
    const addBaseTools = mock(() => Promise.resolve(true));

    const agent = await createAgentWithBaseToolsRecovery(
      createWithTools,
      ["memory", "web_search", "fetch_webpage"],
      addBaseTools,
    );

    expect(agent.id).toBe("agent-no-tools");
    expect(addBaseTools).toHaveBeenCalledTimes(1);
    expect(createWithTools).toHaveBeenCalledTimes(3);
    expect(createWithTools.mock.calls[2]?.[0]).toEqual([]);
  });

  test("does not bootstrap for unrelated missing-tool errors", async () => {
    const createWithTools = mock(() =>
      Promise.reject(
        Object.assign(
          new Error(
            `400 {"detail":"Tools not found by name: {'custom_tool'}"}`,
          ),
          { status: 400 },
        ),
      ),
    );
    const addBaseTools = mock(() => Promise.resolve(true));

    await expect(
      createAgentWithBaseToolsRecovery(
        createWithTools,
        ["custom_tool"],
        addBaseTools,
      ),
    ).rejects.toThrow("custom_tool");

    expect(addBaseTools).not.toHaveBeenCalled();
    expect(createWithTools).toHaveBeenCalledTimes(1);
  });
});
