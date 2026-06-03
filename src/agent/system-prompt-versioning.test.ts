import { describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents";
import { buildSystemPrompt } from "@/agent/prompt-assets";
import {
  decideManagedSystemPromptUpdate,
  hashSystemPrompt,
} from "@/agent/system-prompt-versioning";

function agent(
  system: string,
  tags: string[] = ["origin:letta-code"],
): AgentState {
  return {
    id: "agent-test",
    system,
    tags,
  } as AgentState;
}

describe("system prompt versioning", () => {
  test("hashSystemPrompt is stable and content-sensitive", () => {
    expect(hashSystemPrompt("hello")).toBe(hashSystemPrompt("hello"));
    expect(hashSystemPrompt("hello")).not.toBe(hashSystemPrompt("hello!"));
    expect(hashSystemPrompt("hello")).toStartWith("sha256:");
  });

  test("updates a managed prompt when the active memory mode has different bundled content", () => {
    const storedPrompt = buildSystemPrompt("default", "standard");

    const decision = decideManagedSystemPromptUpdate({
      agent: agent(storedPrompt),
      memoryMode: "memfs",
      storedPreset: "default",
      storedHash: hashSystemPrompt(storedPrompt),
      storedVersion: "old-version",
    });

    expect(decision.kind).toBe("update");
    if (decision.kind === "update") {
      expect(decision.nextSystemPrompt).toBe(
        buildSystemPrompt("default", "memfs"),
      );
      expect(decision.prompt.hash).toBe(
        hashSystemPrompt(decision.nextSystemPrompt),
      );
    }
  });

  test("does not update when the agent prompt no longer matches the stored managed hash", () => {
    const storedPrompt = buildSystemPrompt("default", "standard");
    const modifiedPrompt = `${storedPrompt}\n\nUser customization.`;

    const decision = decideManagedSystemPromptUpdate({
      agent: agent(modifiedPrompt),
      memoryMode: "memfs",
      storedPreset: "default",
      storedHash: hashSystemPrompt(storedPrompt),
      storedVersion: "old-version",
    });

    expect(decision.kind).toBe("custom");
  });

  test("tracks legacy Letta Code agents only when their prompt matches a current preset", () => {
    const currentPrompt = buildSystemPrompt("default", "standard");

    const decision = decideManagedSystemPromptUpdate({
      agent: agent(currentPrompt),
      memoryMode: "standard",
    });

    expect(decision.kind).toBe("track");
    if (decision.kind === "track") {
      expect(decision.prompt.preset).toBe("default");
      expect(decision.prompt.hash).toBe(hashSystemPrompt(currentPrompt));
    }
  });

  test("marks legacy Letta Code agents custom when their prompt is modified", () => {
    const currentPrompt = buildSystemPrompt("default", "standard");

    const decision = decideManagedSystemPromptUpdate({
      agent: agent(`${currentPrompt}\n\nExtra local instruction.`),
      memoryMode: "standard",
    });

    expect(decision.kind).toBe("custom");
  });

  test("ignores non-Letta-Code agents without prompt provenance", () => {
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(buildSystemPrompt("default", "standard"), []),
      memoryMode: "standard",
    });

    expect(decision.kind).toBe("noop");
  });
});
