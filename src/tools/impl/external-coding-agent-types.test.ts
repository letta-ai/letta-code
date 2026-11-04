import { describe, expect, test } from "bun:test";
import {
  computerSupportsHarness,
  isExternalCodingAgentType,
  isLegacyWireHarness,
} from "./external-coding-agent-types";

describe("external coding agent types", () => {
  test("recognizes pi as a harness", () => {
    expect(isExternalCodingAgentType("pi")).toBe(true);
    expect(isExternalCodingAgentType("letta")).toBe(false);
  });

  test("older harnesses need no capability; newer ones must be advertised", () => {
    expect(computerSupportsHarness("codex", undefined)).toBe(true);
    expect(computerSupportsHarness("pi", undefined)).toBe(false);
    expect(computerSupportsHarness("pi", ["codex"])).toBe(false);
    expect(computerSupportsHarness("pi", ["codex", "pi"])).toBe(true);
  });

  test("only the original harnesses use the legacy subagent_type wire field", () => {
    expect(isLegacyWireHarness("claude-code")).toBe(true);
    expect(isLegacyWireHarness("cursor")).toBe(true);
    expect(isLegacyWireHarness("pi")).toBe(false);
  });
});
