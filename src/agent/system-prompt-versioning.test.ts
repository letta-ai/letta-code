import { describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents";
import { buildSystemPrompt } from "@/agent/prompt-assets";
import {
  createSystemPromptRecipe,
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
    const storedRecipe = createSystemPromptRecipe(
      "default",
      "standard",
      storedPrompt,
    );

    const decision = decideManagedSystemPromptUpdate({
      agent: agent(storedPrompt),
      memoryMode: "memfs",
      storedPreset: "default",
      storedRecipe,
    });

    expect(decision.kind).toBe("update");
    if (decision.kind === "update") {
      expect(decision.nextSystemPrompt).toBe(
        buildSystemPrompt("default", "memfs"),
      );
      expect(decision.nextRecipe.contentHash).toBe(
        hashSystemPrompt(decision.nextSystemPrompt),
      );
      expect(decision.nextRecipe.memoryMode).toBe("memfs");
    }
  });

  test("does not update when the agent prompt no longer matches the stored managed hash", () => {
    const storedPrompt = buildSystemPrompt("default", "standard");
    const storedRecipe = createSystemPromptRecipe(
      "default",
      "standard",
      storedPrompt,
    );
    const modifiedPrompt = `${storedPrompt}\n\nUser customization.`;

    const decision = decideManagedSystemPromptUpdate({
      agent: agent(modifiedPrompt),
      memoryMode: "memfs",
      storedPreset: "default",
      storedRecipe,
    });

    expect(decision.kind).toBe("custom");
  });

  test("adopts legacy Letta Code agents only when their prompt matches a current preset", () => {
    const currentPrompt = buildSystemPrompt("default", "standard");

    const decision = decideManagedSystemPromptUpdate({
      agent: agent(currentPrompt),
      memoryMode: "standard",
    });

    expect(decision.kind).toBe("adopt");
    if (decision.kind === "adopt") {
      expect(decision.recipe.preset).toBe("default");
      expect(decision.recipe.contentHash).toBe(hashSystemPrompt(currentPrompt));
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
