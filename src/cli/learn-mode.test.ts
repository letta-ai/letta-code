import { describe, expect, test } from "bun:test";
import {
  buildLearnModeReminderFromEnv,
  normalizeLearnStartupArgs,
} from "@/cli/learn-mode";

describe("learn mode startup", () => {
  test("rewrites letta learn to a fresh MetaAgent session", () => {
    const normalized = normalizeLearnStartupArgs(["learn"]);
    expect(normalized?.args).toEqual([
      "--new-agent",
      "--personality",
      "meta",
      "--new",
    ]);
    expect(normalized?.env.LETTA_CODE_LEARN_MODE).toBe("1");
  });

  test("captures target agent and request without forwarding them as startup flags", () => {
    const normalized = normalizeLearnStartupArgs([
      "learn",
      "agent-123",
      "--request",
      "stop looping",
      "--model",
      "gpt-5.5",
    ]);
    expect(normalized?.args).toEqual([
      "--new-agent",
      "--personality",
      "meta",
      "--new",
      "--model",
      "gpt-5.5",
    ]);
    expect(normalized?.env.LETTA_CODE_LEARN_TARGET_AGENT).toBe("agent-123");
    expect(normalized?.env.LETTA_CODE_LEARN_REQUEST).toBe("stop looping");
  });

  test("treats --agent and --name as target aliases inside learn mode", () => {
    const byAgent = normalizeLearnStartupArgs(["learn", "--agent", "agent-1"]);
    const byName = normalizeLearnStartupArgs(["learn", "--name", "Bob"]);
    expect(byAgent?.env.LETTA_CODE_LEARN_TARGET_AGENT).toBe("agent-1");
    expect(byName?.env.LETTA_CODE_LEARN_TARGET_NAME).toBe("Bob");
  });

  test("builds first-turn reminder from learn mode env", () => {
    const reminder = buildLearnModeReminderFromEnv({
      LETTA_CODE_LEARN_MODE: "1",
      LETTA_CODE_LEARN_TARGET_AGENT: "agent-123",
      LETTA_CODE_LEARN_REQUEST: "improve CI follow-up",
    });
    expect(reminder).toContain("launched via `letta learn`");
    expect(reminder).toContain("Target agent id: agent-123");
    expect(reminder).toContain("improve CI follow-up");
  });
});
