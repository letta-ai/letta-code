import { expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { readMessageStatus } from "./message-status";

test("status works without a local task and does not equate idle with successful delivery", async () => {
  const backend = {
    capabilities: { environmentRouting: true },
    retrieveConversation: async () => ({ agent_id: "agent-target" }),
  } as unknown as Backend;
  const result = await readMessageStatus("conv-target", undefined, backend, {
    getAgentRuntimeStatus: async () => ({
      agent_id: "agent-target",
      snapshot_at: 0,
      statuses: [
        {
          conversation_id: "conv-target",
          state: "IDLE",
          active_run_ids: [],
          loop_state: null,
          last_activity_at: 0,
        },
      ],
    }),
    getLatestConversationSuperRun: async () => ({
      id: "sr-newer",
      status: "COM",
      completed_at: "now",
      errored_at: null,
      cancelled_at: null,
    }),
  });
  expect(result).toMatchObject({
    agent_id: "agent-target",
    latest_super_run: { id: "sr-newer" },
  });
  expect(JSON.stringify(result)).toContain(
    "not confirmation that a particular message completed",
  );
});
