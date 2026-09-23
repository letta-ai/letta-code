import { afterEach, expect, test } from "bun:test";
import { clearAllSubagents, getSubagents } from "@/agent/subagent-state";
import type { AgentRetrieveOptions, Backend } from "@/backend";
import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";
import { resolveChildSubagent, trackChildSend } from "./child-send-tracking";

const receipt: EnqueueReceipt = {
  status: "queued",
  agent_id: "agent-hayt",
  conversation_id: "conv-hayt",
  client_message_id: "cm-1",
  workflow_id: "wf-1",
  super_run_id: "sr-1",
};
const parentScope = { agentId: "agent-bob", conversationId: "conv-bob" };
const child = { name: "Hayt", type: "code-reviewer" };

afterEach(() => {
  clearAllSubagents();
});

function backendWithTags(tags: string[]) {
  return {
    retrieveAgent: async (_id: string, options?: AgentRetrieveOptions) => {
      // Cloud only returns tags when explicitly included.
      const includesTags = options?.include?.includes("agent.tags") ?? false;
      return { id: "agent-hayt", name: "Hayt", tags: includesTags ? tags : [] };
    },
  } as unknown as Pick<Backend, "retrieveAgent">;
}

test("resolveChildSubagent accepts only agents tagged with this parent", async () => {
  expect(
    await resolveChildSubagent(
      backendWithTags(["type:code-reviewer", "parent:agent-bob"]),
      "agent-hayt",
      "agent-bob",
    ),
  ).toEqual({ name: "Hayt", type: "code-reviewer" });
  expect(
    await resolveChildSubagent(
      backendWithTags(["parent:agent-other"]),
      "agent-hayt",
      "agent-bob",
    ),
  ).toBeNull();
  expect(
    await resolveChildSubagent(backendWithTags([]), "agent-hayt", "agent-bob"),
  ).toBeNull();
});

test("resolveChildSubagent defaults the type when the spawn tag is missing", async () => {
  expect(
    await resolveChildSubagent(
      backendWithTags(["parent:agent-bob"]),
      "agent-hayt",
      "agent-bob",
    ),
  ).toEqual({ name: "Hayt", type: "general-purpose" });
});

test("a tracked child send is running, scoped to the parent, and completes with its run", async () => {
  let settle!: () => void;
  const run = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const id = trackChildSend({
    receipt,
    child,
    prompt: "Please finish the review.",
    parentScope,
    waitForRun: () => run,
  });

  const running = getSubagents().find((agent) => agent.id === id);
  expect(running).toMatchObject({
    status: "running",
    type: "Code-reviewer",
    description: "Hayt",
    prompt: "Please finish the review.",
    agentId: "agent-hayt",
    conversationId: "conv-hayt",
    isBackground: true,
    claimsParentRuntime: false,
    silent: false,
    parentAgentId: "agent-bob",
    parentConversationId: "conv-bob",
  });
  expect(running?.agentURL).toContain("agent-hayt");
  expect(running?.agentURL).toContain("conv-hayt");

  settle();
  await run;
  await Promise.resolve();
  expect(getSubagents().find((agent) => agent.id === id)?.status).toBe(
    "completed",
  );
});

test("a failed or cancelled run marks the tracked child as errored", async () => {
  const id = trackChildSend({
    receipt,
    child,
    prompt: "x",
    parentScope,
    waitForRun: () =>
      Promise.reject(new Error("Remote Super Run sr-1 was cancelled.")),
  });
  await Promise.resolve();
  await Promise.resolve();
  const agent = getSubagents().find((entry) => entry.id === id);
  expect(agent?.status).toBe("error");
  expect(agent?.error).toBe("Remote Super Run sr-1 was cancelled.");
});
