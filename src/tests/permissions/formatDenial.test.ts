import { describe, expect, test } from "bun:test";
import { formatPermissionDenial } from "../../permissions/formatDenial";

describe("formatPermissionDenial", () => {
  test("custom denyReason takes precedence over everything", () => {
    const result = formatPermissionDenial(
      { reason: "detailed explanation", matchedRule: "cross-agent guard" },
      "Custom override from hook",
    );
    expect(result).toBe("Custom override from hook");
  });

  test("empty customDenyReason string is ignored (falls through to reason)", () => {
    const result = formatPermissionDenial(
      { reason: "detailed explanation", matchedRule: "cross-agent guard" },
      "",
    );
    expect(result).toBe("Permission denied: detailed explanation");
  });

  test("undefined customDenyReason falls through to reason", () => {
    const result = formatPermissionDenial(
      { reason: "detailed explanation", matchedRule: "cross-agent guard" },
      undefined,
    );
    expect(result).toBe("Permission denied: detailed explanation");
  });

  test("null customDenyReason falls through to reason", () => {
    const result = formatPermissionDenial(
      { reason: "detailed explanation", matchedRule: "cross-agent guard" },
      null,
    );
    expect(result).toBe("Permission denied: detailed explanation");
  });

  test("already-prefixed reasons are preserved verbatim", () => {
    const result = formatPermissionDenial({
      reason:
        "Permission denied by cross-agent memory guard: targeted agent-abc123. " +
        "Set LETTA_MEMORY_SCOPE or pass --memory-scope to authorize.",
      matchedRule: "cross-agent guard",
    });
    expect(result).toBe(
      "Permission denied by cross-agent memory guard: targeted agent-abc123. " +
        "Set LETTA_MEMORY_SCOPE or pass --memory-scope to authorize.",
    );
  });

  test("matchedRule is used when only it is present", () => {
    const result = formatPermissionDenial({ matchedRule: "cross-agent guard" });
    expect(result).toBe("Permission denied by rule: cross-agent guard");
  });

  test("empty reason string falls through to matchedRule", () => {
    const result = formatPermissionDenial({
      reason: "",
      matchedRule: "memory mode",
    });
    expect(result).toBe("Permission denied by rule: memory mode");
  });

  test("empty matchedRule falls through to final fallback", () => {
    const result = formatPermissionDenial({ matchedRule: "" });
    expect(result).toBe("Permission denied: Unknown reason");
  });

  test("final fallback when nothing is set", () => {
    const result = formatPermissionDenial({});
    expect(result).toBe("Permission denied: Unknown reason");
  });

  test("works with extra unrelated fields on the permission object", () => {
    // Mirrors real-world ToolPermission shape which has a `decision` field too
    const result = formatPermissionDenial({
      reason: "detailed",
      matchedRule: "rule",
      // @ts-expect-error extra property is allowed structurally
      decision: "deny",
    });
    expect(result).toBe("Permission denied: detailed");
  });

  test("generic checker reasons prefer matchedRule over internal labels", () => {
    const result = formatPermissionDenial({
      reason: "Matched deny rule",
      matchedRule: "Bash(git push)",
    });
    expect(result).toBe("Permission denied by rule: Bash(git push)");
  });

  test("disallowed-tools generic reason also prefers matchedRule", () => {
    const result = formatPermissionDenial({
      reason: "Matched --disallowedTools flag",
      matchedRule: "Edit(secret.txt) (CLI)",
    });
    expect(result).toBe("Permission denied by rule: Edit(secret.txt) (CLI)");
  });

  test("plan-mode denial — reason contains plan file path context", () => {
    const result = formatPermissionDenial({
      reason:
        "Plan mode is active. You can only use read-only tools (Read, " +
        "Grep, Glob, etc.) and write to the plan file. " +
        "Write your plan to: /tmp/plan.md. Use ExitPlanMode when ready.",
      matchedRule: "plan mode",
    });
    expect(result).toContain("Plan mode is active");
    expect(result).toContain("/tmp/plan.md");
    // Crucially, it shouldn't be the short "plan mode" label
    expect(result).not.toBe("Permission denied by rule: plan mode");
  });

  test("memory-mode denial shows fuller reason over short label", () => {
    const result = formatPermissionDenial({
      reason: "Permission mode: memory",
      matchedRule: "memory mode",
    });
    expect(result).toBe("Permission denied: Permission mode: memory");
  });
});
