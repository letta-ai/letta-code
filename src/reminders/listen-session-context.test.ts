import { describe, expect, test } from "bun:test";
import {
  buildSharedReminderParts,
  sharedReminderProviders,
} from "@/reminders/engine";
import { buildListenReminderContext } from "@/reminders/listen-context";
import {
  createSharedReminderState,
  syncReminderStateFromContextMessages,
} from "@/reminders/state";

function withStubbedProviders(fn: () => Promise<void>): () => Promise<void> {
  const origSession = sharedReminderProviders["session-context"];
  const origAgent = sharedReminderProviders["agent-info"];

  return async () => {
    sharedReminderProviders["session-context"] = async (ctx) => {
      if (!ctx.systemInfoReminderEnabled || ctx.state.hasSentSessionContext) {
        return null;
      }
      ctx.state.hasSentSessionContext = true;
      ctx.state.pendingSessionContextReason = undefined;
      return "<session-context-stub>";
    };
    sharedReminderProviders["agent-info"] = async (ctx) => {
      if (ctx.state.hasSentAgentInfo) {
        return null;
      }
      ctx.state.hasSentAgentInfo = true;
      return "<agent-info-stub>";
    };
    try {
      await fn();
    } finally {
      sharedReminderProviders["session-context"] = origSession;
      sharedReminderProviders["agent-info"] = origAgent;
    }
  };
}

describe("listen-mode session context", () => {
  test(
    "out-of-band compaction re-sends context reminders on the next turn",
    withStubbedProviders(async () => {
      const state = createSharedReminderState();
      const ctx = buildListenReminderContext({ agentId: "agent-test", state });
      syncReminderStateFromContextMessages(state, ["system", "first-user"]);
      await buildSharedReminderParts(ctx);

      syncReminderStateFromContextMessages(state, [
        "system",
        "first-user",
        "reply",
      ]);
      const unchanged = await buildSharedReminderParts(ctx);
      expect(unchanged.appliedReminderIds).not.toContain("agent-info");
      expect(unchanged.appliedReminderIds).not.toContain("session-context");

      syncReminderStateFromContextMessages(state, [
        "system",
        "summary",
        "reply",
      ]);
      expect(state.pendingSessionContextReason).toBe("post_compaction");
      const compacted = await buildSharedReminderParts(ctx);
      expect(compacted.appliedReminderIds).toContain("agent-info");
      expect(compacted.appliedReminderIds).toContain("session-context");

      syncReminderStateFromContextMessages(state, [
        "system",
        "summary",
        "reply",
        "next-user",
      ]);
      const next = await buildSharedReminderParts(ctx);
      expect(next.appliedReminderIds).not.toContain("agent-info");
      expect(next.appliedReminderIds).not.toContain("session-context");
    }),
  );
});
