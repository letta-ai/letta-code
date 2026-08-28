import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents";
import { buildSystemPrompt } from "@/agent/prompt-assets";
import {
  decideManagedSystemPromptUpdate,
  hashSystemPrompt,
  resolveMemoryPromptMode,
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
  test("selects the root prompt only for API memory with exact root MEMORY.md", () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "letta-root-prompt-"));
    try {
      mkdirSync(join(memoryDir, "nested"));
      writeFileSync(join(memoryDir, "nested", "MEMORY.md"), "# Nested\n");
      expect(
        resolveMemoryPromptMode({
          localMemfs: false,
          memoryDir,
          memfsEnabled: true,
        }),
      ).toBe("memfs");

      writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
      expect(
        resolveMemoryPromptMode({
          localMemfs: false,
          memoryDir,
          memfsEnabled: true,
        }),
      ).toBe("root-memfs");
      expect(
        resolveMemoryPromptMode({
          localMemfs: true,
          memoryDir,
          memfsEnabled: true,
        }),
      ).toBe("local-memfs");
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

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

  test("does not replace a customized managed prompt when root layout is selected", () => {
    const storedPrompt = buildSystemPrompt("default", "memfs");
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(`${storedPrompt}\n\nUser customization.`),
      memoryMode: "root-memfs",
      storedPreset: "default",
      storedHash: hashSystemPrompt(storedPrompt),
      storedVersion: "old-version",
    });

    expect(decision.kind).toBe("custom");
  });

  test("tracks a bundled root prompt applied by migration", () => {
    const oldPrompt = buildSystemPrompt("default", "memfs");
    const rootPrompt = buildSystemPrompt("default", "root-memfs");
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(rootPrompt),
      memoryMode: "root-memfs",
      storedPreset: "default",
      storedHash: hashSystemPrompt(oldPrompt),
      storedVersion: "old-version",
    });

    expect(decision.kind).toBe("track");
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

  test("tracks untagged agents when their prompt matches a current preset", () => {
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(buildSystemPrompt("default", "standard"), []),
      memoryMode: "standard",
    });

    expect(decision.kind).toBe("track");
  });

  test("updates an exact existing-layout preset when root layout is selected", () => {
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(buildSystemPrompt("default", "memfs")),
      memoryMode: "root-memfs",
    });

    expect(decision.kind).toBe("update");
    if (decision.kind === "update") {
      expect(decision.nextSystemPrompt).toBe(
        buildSystemPrompt("default", "root-memfs"),
      );
      expect(decision.prompt.preset).toBe("default");
    }
  });

  test("does not replace a prompt merely because it starts like Letta Code", () => {
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(
        "You are Letta Code, a state-of-the-art coding agent running within the Letta Code CLI on a user's computer.\n\nCustom instructions.",
      ),
      memoryMode: "root-memfs",
    });

    expect(decision.kind).toBe("custom");
  });

  test("ignores untagged non-Letta-Code agents without prompt provenance", () => {
    const decision = decideManagedSystemPromptUpdate({
      agent: agent("You are a custom assistant.", []),
      memoryMode: "standard",
    });

    expect(decision.kind).toBe("noop");
  });
});
