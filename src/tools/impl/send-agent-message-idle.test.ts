import { expect, test } from "bun:test";
import type { AgentRuntimeStatusEntry } from "@/backend/api/agents";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  caller,
  sendAgentMessageFixture as fixture,
  TARGET_CONV,
} from "@/test-utils/send-agent-message-fixture";
import { send_agent_message } from "./send-agent-message";

const childTags = [`parent:${caller.agentId}`, "role:subagent"];
const idle: AgentRuntimeStatusEntry = {
  conversation_id: "default",
  state: "IDLE",
  loop_state: null,
  active_run_ids: [],
  last_activity_at: 0,
};

test.each([
  { label: "idle child", tags: childTags, status: idle, refused: true },
  {
    label: "waiting child",
    tags: childTags,
    status: {
      ...idle,
      state: "ACTIVE",
      loop_state: { status: "WAITING_ON_INPUT" },
    },
    refused: true,
  },
  {
    label: "running child",
    tags: childTags,
    status: {
      ...idle,
      state: "ACTIVE_UNATTRIBUTED",
      active_run_ids: ["run-1"],
    },
  },
  { label: "peer", tags: [], status: idle },
  {
    label: "other parent's child",
    tags: ["parent:agent-other", "role:subagent"],
    status: idle,
  },
  {
    label: "parent tag without subagent role",
    tags: [`parent:${caller.agentId}`],
    status: idle,
  },
  { label: "missing status", tags: childTags, status: null },
  {
    label: "status read failure",
    tags: childTags,
    status: idle,
    readError: true,
  },
  { label: "lookup failure", tags: childTags, status: idle, lookupError: true },
  {
    label: "forked conversation",
    tags: childTags,
    status: idle,
    conversation: TARGET_CONV,
  },
  {
    label: "pending child",
    tags: childTags,
    status: { ...idle, state: "PENDING_DELIVERY" },
  },
  {
    label: "background work",
    tags: childTags,
    status: { ...idle, active_bash_count: 1 },
  },
] satisfies Array<{
  label: string;
  tags: string[];
  status: AgentRuntimeStatusEntry | null;
  refused?: boolean;
  readError?: boolean;
  lookupError?: boolean;
  conversation?: string;
}>)("$label", async (scenario) => {
  const f = fixture(scenario.tags);
  if ("lookupError" in scenario && scenario.lookupError) {
    f.backend.retrieveAgent = async () => {
      throw new Error("unavailable");
    };
  }
  let reads = 0;
  const result = await runWithRuntimeContext(caller, () =>
    send_agent_message(
      {
        agent_id: "agent-target",
        conversation_id:
          "conversation" in scenario ? scenario.conversation : "default",
        message: "Check the next task.",
      },
      {
        ...f,
        runtimeStatus: async () => {
          reads++;
          if ("readError" in scenario && scenario.readError)
            throw new Error("unavailable");
          return scenario.status;
        },
      },
    ),
  );
  const refused = "refused" in scenario && scenario.refused;
  expect(result.status).toBe(refused ? "error" : "success");
  expect(f.submissions).toHaveLength(refused ? 0 : 1);
  if (refused) {
    expect(JSON.parse(result.content)).toMatchObject({
      status: "submission_failed",
      error: expect.stringContaining("fresh Agent"),
    });
  }
  if (!scenario.tags.includes("role:subagent") || "conversation" in scenario) {
    expect(reads).toBe(0);
  }
});
