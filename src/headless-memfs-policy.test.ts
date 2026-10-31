import { describe, expect, test } from "bun:test";
import { resolveHeadlessMemfsPolicy } from "@/headless-memfs-policy";

describe("headless MemFS policy", () => {
  test("treats --stateless with an existing agent as a stateless session", () => {
    expect(
      resolveHeadlessMemfsPolicy({
        statelessRequested: true,
        isSubagentRole: true,
        newAgentRequested: false,
      }),
    ).toEqual({
      isFreshStatelessSubagent: false,
      isStatelessSession: true,
    });
  });

  test("keeps fresh subagents stateless without a CLI flag", () => {
    expect(
      resolveHeadlessMemfsPolicy({
        statelessRequested: false,
        isSubagentRole: true,
        newAgentRequested: true,
      }),
    ).toEqual({
      isFreshStatelessSubagent: true,
      isStatelessSession: true,
    });
  });

  test("keeps existing subagent deployments stateful by default", () => {
    expect(
      resolveHeadlessMemfsPolicy({
        statelessRequested: false,
        isSubagentRole: true,
        newAgentRequested: false,
      }),
    ).toEqual({
      isFreshStatelessSubagent: false,
      isStatelessSession: false,
    });
  });

  test("keeps a resumed subagent stateless like a fresh one", () => {
    expect(
      resolveHeadlessMemfsPolicy({
        statelessRequested: false,
        isSubagentRole: true,
        newAgentRequested: false,
        agentTags: ["origin:letta-code", "role:subagent", "type:general"],
      }),
    ).toEqual({
      isFreshStatelessSubagent: false,
      isStatelessSession: true,
    });
  });

  test("leaves a subagent that already has MemFS as it is", () => {
    expect(
      resolveHeadlessMemfsPolicy({
        statelessRequested: false,
        isSubagentRole: true,
        newAgentRequested: false,
        agentTags: ["role:subagent", "git-memory-enabled"],
      }).isStatelessSession,
    ).toBe(false);
  });
});
