import { describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { notifyConversationCompacted } from "@/backend/compaction-events";
import { parseSkillDeltaReminder } from "@/test-utils/skill-delta-reminder";
import { planClientSkillsRequest } from "./client-skills-baseline";

const alpha = { name: "alpha", description: "A", location: "/alpha" };
const bravo = { name: "bravo", description: "B", location: "/bravo" };

describe("client_skills baseline", () => {
  test("an unaccepted plan neither freezes nor consumes the delta", () => {
    const backend = {} as Backend;
    const scope = { conversationId: "conv-1" };
    planClientSkillsRequest(backend, scope, [alpha]).accept();
    const rejected = planClientSkillsRequest(backend, scope, [alpha, bravo]);
    expect(rejected.clientSkills).toEqual([alpha]);
    const retry = planClientSkillsRequest(backend, scope, [alpha, bravo]);
    expect(retry.reminder).toBe(rejected.reminder);
    expect(parseSkillDeltaReminder(retry.reminder)?.added).toEqual(["bravo"]);
  });

  test("a default-conversation compaction re-baselines only that agent", () => {
    const backend = {} as Backend;
    const agentA = { conversationId: "default", agentId: "agent-a" };
    const agentB = { conversationId: "default", agentId: "agent-b" };
    planClientSkillsRequest(backend, agentA, [alpha]).accept();
    planClientSkillsRequest(backend, agentB, [alpha]).accept();
    notifyConversationCompacted({ backend, ...agentA });
    // Another backend instance's compaction is unrelated.
    notifyConversationCompacted({ backend: {}, ...agentB });
    const a = planClientSkillsRequest(backend, agentA, [alpha, bravo]);
    expect(a.clientSkills).toEqual([alpha, bravo]);
    expect(a.reminder).toBeNull();
    const b = planClientSkillsRequest(backend, agentB, [alpha, bravo]);
    expect(b.clientSkills).toEqual([alpha]);
    expect(parseSkillDeltaReminder(b.reminder)?.added).toEqual(["bravo"]);
  });

  test("a compaction before the first accepted request is a no-op", () => {
    const backend = {} as Backend;
    notifyConversationCompacted({ backend, conversationId: "conv-new" });
    const first = planClientSkillsRequest(
      backend,
      { conversationId: "conv-new" },
      [alpha],
    );
    expect(first.clientSkills).toEqual([alpha]);
    expect(first.reminder).toBeNull();
  });
});
