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

  test("keeps resumed subagents stateless without a CLI flag", () => {
    expect(
      resolveHeadlessMemfsPolicy({
        statelessRequested: false,
        isSubagentRole: true,
        newAgentRequested: false,
      }),
    ).toEqual({
      isFreshStatelessSubagent: false,
      isStatelessSession: true,
    });
  });
  test("keeps a tagged resumed subagent stateless without the role environment", () => {
    expect(
      resolveHeadlessMemfsPolicy({
        statelessRequested: false,
        isSubagentRole: false,
        newAgentRequested: false,
        hasSubagentTag: true,
      }),
    ).toEqual({ isFreshStatelessSubagent: false, isStatelessSession: true });
  });
});
