import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

interface CapturedUpdate {
  agentId: string;
  handle: string;
  updateArgs?: Record<string, unknown>;
  options?: unknown;
}

const updates: CapturedUpdate[] = [];

mock.module("@/agent/modify", () => ({
  updateAgentLLMConfig: async (
    agentId: string,
    handle: string,
    updateArgs?: Record<string, unknown>,
    options?: unknown,
  ) => {
    updates.push({ agentId, handle, updateArgs, options });
    return { id: agentId };
  },
}));

const { applyResumeModelOverrides, ResumeModelOverrideError } = await import(
  "./resume-model-refresh"
);

/** Minimal agent snapshot: only the fields the resume path reads. */
function agentWith(model: string | null, reasoning?: string) {
  return {
    id: "agent-resuming",
    model,
    llm_config: model
      ? {
          model: model.split("/").slice(1).join("/"),
          reasoning_effort: reasoning ?? null,
        }
      : null,
  } as never;
}

beforeEach(() => {
  updates.length = 0;
});

afterAll(() => {
  mock.restore();
});

describe("applyResumeModelOverrides", () => {
  test("applies an effort without a model against the agent's current model", async () => {
    const result = await applyResumeModelOverrides({
      agent: agentWith("deepseek/deepseek-v4.1-flash", "low"),
      reasoningEffort: "high",
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.agentId).toBe("agent-resuming");
    expect(updates[0]?.handle).toBe("deepseek/deepseek-v4.1-flash");
    expect(updates[0]?.updateArgs).toMatchObject({
      reasoning_effort: "high",
    });
    expect(result).toMatchObject({ id: "agent-resuming" });
  });

  test("still writes when nothing else needs refreshing but an effort was asked for", async () => {
    // The agent already reports the effort it is about to be given; the write
    // must happen anyway rather than being skipped as a no-op.
    await applyResumeModelOverrides({
      agent: agentWith("deepseek/deepseek-v4.1-flash", "high"),
      reasoningEffort: "high",
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.updateArgs).toMatchObject({
      reasoning_effort: "high",
    });
  });

  test("does not call the API when neither model nor effort is requested and nothing is stale", async () => {
    const agent = agentWith("deepseek/deepseek-v4.1-flash", "high");
    const result = await applyResumeModelOverrides({ agent });

    expect(updates).toHaveLength(0);
    expect(result).toBe(agent);
  });

  test("rejects an unknown model", async () => {
    expect(
      applyResumeModelOverrides({
        agent: agentWith("deepseek/deepseek-v4.1-flash"),
        model: "not-a-real-model-xyz",
      }),
    ).rejects.toBeInstanceOf(ResumeModelOverrideError);
  });

  test("refuses an effort it cannot attach to any model", async () => {
    expect(
      applyResumeModelOverrides({
        agent: agentWith(null),
        reasoningEffort: "high",
      }),
    ).rejects.toBeInstanceOf(ResumeModelOverrideError);
  });
});
