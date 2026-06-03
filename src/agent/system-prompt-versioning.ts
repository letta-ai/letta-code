import { createHash } from "node:crypto";
import type { AgentState } from "@letta-ai/letta-client/resources/agents";
import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { debugLog, debugWarn } from "@/utils/debug";
import { getVersion } from "@/version";
import {
  buildSystemPrompt,
  isKnownPreset,
  type MemoryPromptMode,
  SYSTEM_PROMPTS,
} from "./prompt-assets";

const SYSTEM_PROMPT_HASH_PREFIX = "sha256:";

type ManagedPrompt = {
  preset: string;
  hash: string;
  version: string;
};

type SystemPromptUpdateDecision =
  | { kind: "noop"; reason: string }
  | { kind: "track"; prompt: ManagedPrompt }
  | { kind: "custom"; reason: string }
  | { kind: "clear"; reason: string }
  | {
      kind: "update";
      nextSystemPrompt: string;
      prompt: ManagedPrompt;
      reason: string;
    };

export interface ManagedSystemPromptUpdateOptions {
  agent: AgentState;
  memoryMode: MemoryPromptMode;
  onUpdated?: (agent: AgentState) => void;
}

export function hashSystemPrompt(content: string): string {
  const digest = createHash("sha256").update(content).digest("base64url");
  return `${SYSTEM_PROMPT_HASH_PREFIX}${digest}`;
}

function managedPrompt(
  preset: string,
  memoryMode: MemoryPromptMode,
  content: string = buildSystemPrompt(preset, memoryMode),
): ManagedPrompt {
  return {
    preset,
    hash: hashSystemPrompt(content),
    version: getVersion(),
  };
}

export function recordManagedSystemPrompt(
  agentId: string,
  preset: string,
  memoryMode: MemoryPromptMode,
  content?: string,
): void {
  if (!settingsManager.isReady) {
    return;
  }
  settingsManager.setManagedSystemPrompt(
    agentId,
    managedPrompt(preset, memoryMode, content),
  );
}

export function getMemoryPromptModeForAgent(agentId: string): MemoryPromptMode {
  const backend = getBackend();
  if (backend.capabilities.localMemfs) {
    return "local-memfs";
  }
  return settingsManager.isReady && settingsManager.isMemfsEnabled(agentId)
    ? "memfs"
    : "standard";
}

function isLettaCodePrimaryAgent(agent: AgentState): boolean {
  const tags = agent.tags ?? [];
  return tags.includes("origin:letta-code") && !tags.includes("role:subagent");
}

function findMatchingCurrentPreset(
  systemPrompt: string,
  memoryMode: MemoryPromptMode,
): string | undefined {
  for (const preset of SYSTEM_PROMPTS) {
    if (buildSystemPrompt(preset.id, memoryMode) === systemPrompt) {
      return preset.id;
    }
  }
  return undefined;
}

function isValidHash(hash: string | undefined): hash is string {
  return !!hash && hash.startsWith(SYSTEM_PROMPT_HASH_PREFIX);
}

export function decideManagedSystemPromptUpdate(input: {
  agent: AgentState;
  memoryMode: MemoryPromptMode;
  storedPreset?: string;
  storedHash?: string;
  storedVersion?: string;
}): SystemPromptUpdateDecision {
  const { agent, memoryMode, storedPreset, storedHash, storedVersion } = input;
  const currentSystemPrompt = agent.system ?? "";
  const currentHash = hashSystemPrompt(currentSystemPrompt);
  const currentVersion = getVersion();

  if (storedPreset === "custom") {
    return { kind: "noop", reason: "system prompt is marked custom" };
  }

  if (storedPreset) {
    if (!isKnownPreset(storedPreset)) {
      return { kind: "clear", reason: "stored preset is no longer known" };
    }

    if (storedHash) {
      if (!isValidHash(storedHash)) {
        return { kind: "clear", reason: "stored prompt hash is invalid" };
      }

      if (currentHash !== storedHash) {
        return {
          kind: "custom",
          reason: "agent prompt differs from stored managed prompt hash",
        };
      }

      const nextSystemPrompt = buildSystemPrompt(storedPreset, memoryMode);
      const nextPrompt = managedPrompt(
        storedPreset,
        memoryMode,
        nextSystemPrompt,
      );

      if (nextPrompt.hash !== storedHash) {
        return {
          kind: "update",
          nextSystemPrompt,
          prompt: nextPrompt,
          reason:
            "managed prompt content changed for current Letta Code version",
        };
      }

      if (storedVersion !== currentVersion) {
        return { kind: "track", prompt: nextPrompt };
      }

      return { kind: "noop", reason: "managed prompt is current" };
    }

    // Legacy preset-only settings cannot prove the prompt is still managed, so
    // only start tracking them when they exactly match the current bundled text.
    const expectedCurrentPrompt = buildSystemPrompt(storedPreset, memoryMode);
    if (currentSystemPrompt === expectedCurrentPrompt) {
      return {
        kind: "track",
        prompt: managedPrompt(storedPreset, memoryMode, currentSystemPrompt),
      };
    }

    return {
      kind: "custom",
      reason: "legacy preset tracking exists but prompt content was modified",
    };
  }

  if (!isLettaCodePrimaryAgent(agent)) {
    return { kind: "noop", reason: "agent is not a primary Letta Code agent" };
  }

  const matchingPreset = findMatchingCurrentPreset(
    currentSystemPrompt,
    memoryMode,
  );
  if (!matchingPreset) {
    return {
      kind: "custom",
      reason: "legacy Letta Code agent prompt does not match a current preset",
    };
  }

  return {
    kind: "track",
    prompt: managedPrompt(matchingPreset, memoryMode, currentSystemPrompt),
  };
}

export function scheduleManagedSystemPromptUpdate({
  agent,
  memoryMode,
  onUpdated,
}: ManagedSystemPromptUpdateOptions): void {
  if (!settingsManager.isReady) {
    return;
  }

  const decision = decideManagedSystemPromptUpdate({
    agent,
    memoryMode,
    storedPreset: settingsManager.getSystemPromptPreset(agent.id),
    storedHash: settingsManager.getSystemPromptHash(agent.id),
    storedVersion: settingsManager.getSystemPromptVersion(agent.id),
  });

  if (decision.kind === "noop") {
    debugLog("startup", `System prompt version check noop: ${decision.reason}`);
    return;
  }

  if (decision.kind === "track") {
    settingsManager.setManagedSystemPrompt(agent.id, decision.prompt);
    debugLog(
      "startup",
      `Tracking managed system prompt ${decision.prompt.preset}@${decision.prompt.version}`,
    );
    return;
  }

  if (decision.kind === "custom") {
    settingsManager.setSystemPromptCustom(agent.id);
    debugLog("startup", `Marked system prompt custom: ${decision.reason}`);
    return;
  }

  if (decision.kind === "clear") {
    settingsManager.clearSystemPromptPreset(agent.id);
    debugLog("startup", `Cleared system prompt metadata: ${decision.reason}`);
    return;
  }

  void getBackend()
    .updateAgent(agent.id, {
      system: decision.nextSystemPrompt,
    })
    .then(async () => {
      settingsManager.setManagedSystemPrompt(agent.id, decision.prompt);
      debugLog(
        "startup",
        `Updated managed system prompt ${decision.prompt.preset}@${decision.prompt.version}: ${decision.reason}`,
      );
      if (onUpdated) {
        const updatedAgent = await getBackend().retrieveAgent(agent.id, {
          include: ["agent.secrets", "agent.tools", "agent.tags"],
        });
        onUpdated(updatedAgent);
      }
    })
    .catch((error) => {
      debugWarn(
        "startup",
        `Failed to update managed system prompt for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}
