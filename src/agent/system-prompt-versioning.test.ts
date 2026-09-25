import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents";
import { buildSystemPrompt } from "@/agent/prompt-assets";
import {
  CLOUD_MANAGED_PROMPT_PRESET,
  decideManagedSystemPromptUpdate,
  hashSystemPrompt,
  resolveMemoryPromptMode,
} from "@/agent/system-prompt-versioning";

function agent(
  system: string | null,
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

  test("does not classify a backend-owned inherited prompt as custom", () => {
    const storedPrompt = buildSystemPrompt("default", "memfs");
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(null),
      memoryMode: "memfs",
      storedPreset: "default",
      storedHash: hashSystemPrompt(storedPrompt),
      storedVersion: "old-version",
    });

    expect(decision).toEqual({
      kind: "noop",
      reason: "system prompt inherits backend default",
    });
  });

  test("lets Cloud inherit a bundled default despite stale custom metadata", () => {
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(buildSystemPrompt("default", "memfs")),
      memoryMode: "memfs",
      isLettaCloud: true,
      storedPreset: "custom",
    });

    expect(decision).toMatchObject({
      kind: "inherit",
      nextSystemPrompt: null,
    });
  });

  test("lets Cloud inherit a still-managed old default", () => {
    const oldDefault = buildSystemPrompt("default", "standard");
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(oldDefault),
      memoryMode: "root-memfs",
      isLettaCloud: true,
      storedPreset: "default",
      storedHash: hashSystemPrompt(oldDefault),
      storedVersion: "older-version",
    });

    expect(decision).toMatchObject({
      kind: "inherit",
      nextSystemPrompt: null,
    });
  });

  test("does not rewrite a Cloud-managed prompt on later resumes", () => {
    const inherited = decideManagedSystemPromptUpdate({
      agent: agent(null),
      memoryMode: "memfs",
      isLettaCloud: true,
      storedPreset: CLOUD_MANAGED_PROMPT_PRESET,
    });
    expect(inherited.kind).toBe("noop");

    const customized = decideManagedSystemPromptUpdate({
      agent: agent("SDK replaced the Cloud default"),
      memoryMode: "memfs",
      isLettaCloud: true,
      storedPreset: CLOUD_MANAGED_PROMPT_PRESET,
    });
    expect(customized.kind).toBe("custom");
  });

  test("does not replace an SDK-created custom system prompt", () => {
    for (const customPrompt of [
      "A bespoke SDK system prompt",
      `${buildSystemPrompt("default", "root-memfs")}\nSDK customization`,
    ]) {
      for (const tags of [[], ["origin:letta-code"]]) {
        const decision = decideManagedSystemPromptUpdate({
          agent: agent(customPrompt, tags),
          memoryMode: "root-memfs",
          isLettaCloud: true,
        });

        expect(decision.kind).toBe(tags.length ? "custom" : "noop");
      }
    }
  });

  test("does not migrate a bundled default when opted out or off Cloud", () => {
    const oldDefault = buildSystemPrompt("default", "memfs");
    for (const settings of [
      { isLettaCloud: false },
      { isLettaCloud: true, preserveCloudSystemPrompt: true },
    ]) {
      const decision = decideManagedSystemPromptUpdate({
        agent: agent(oldDefault),
        memoryMode: "memfs",
        storedPreset: "custom",
        ...settings,
      });
      expect(decision.kind).toBe("noop");
    }

    expect(
      decideManagedSystemPromptUpdate({
        agent: agent(oldDefault),
        memoryMode: "root-memfs",
        isLettaCloud: true,
        preserveCloudSystemPrompt: true,
        storedPreset: "default",
        storedHash: hashSystemPrompt(oldDefault),
        storedVersion: "older-version",
      }).kind,
    ).toBe("noop");
  });

  test("does not migrate a non-default named preset", () => {
    const sourcePreset = buildSystemPrompt("source-claude", "standard");
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(sourcePreset),
      memoryMode: "root-memfs",
      isLettaCloud: true,
      storedPreset: "source-claude",
      storedHash: hashSystemPrompt(sourcePreset),
    });

    expect(decision.kind).not.toBe("inherit");
  });

  test("keeps an explicitly selected letta preset even when its text matches default", () => {
    const prompt = buildSystemPrompt("letta", "memfs");
    const decision = decideManagedSystemPromptUpdate({
      agent: agent(prompt),
      memoryMode: "memfs",
      isLettaCloud: true,
      storedPreset: "letta",
      storedHash: hashSystemPrompt(prompt),
    });

    expect(decision.kind).not.toBe("inherit");
  });

  test("does not migrate subagents or local-only bundled prompts", () => {
    const bundled = buildSystemPrompt("default", "memfs");
    expect(
      decideManagedSystemPromptUpdate({
        agent: agent(bundled, ["origin:letta-code", "role:subagent"]),
        memoryMode: "memfs",
        isLettaCloud: true,
      }).kind,
    ).toBe("noop");

    const managedSubagent = decideManagedSystemPromptUpdate({
      agent: agent(bundled, ["origin:letta-code", "role:subagent"]),
      memoryMode: "root-memfs",
      isLettaCloud: true,
      storedPreset: "default",
      storedHash: hashSystemPrompt(bundled),
    });
    expect(managedSubagent.kind).toBe("update");

    expect(
      decideManagedSystemPromptUpdate({
        agent: agent(buildSystemPrompt("default", "local-memfs")),
        memoryMode: "local-memfs",
        isLettaCloud: true,
      }).kind,
    ).not.toBe("inherit");
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
