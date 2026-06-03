import { createHash } from "node:crypto";
import type { AgentState } from "@letta-ai/letta-client/resources/agents";
import { getBackend } from "@/backend";
import { type SystemPromptRecipe, settingsManager } from "@/settings-manager";
import { debugLog, debugWarn } from "@/utils/debug";
import { getVersion } from "@/version";
import {
  buildSystemPrompt,
  isKnownPreset,
  type MemoryPromptMode,
  SYSTEM_PROMPTS,
} from "./prompt-assets";

const SYSTEM_PROMPT_HASH_PREFIX = "sha256:";

type SystemPromptUpdateDecision =
  | { kind: "noop"; reason: string }
  | { kind: "adopt"; recipe: SystemPromptRecipe }
  | { kind: "custom"; reason: string }
  | { kind: "clear"; reason: string }
  | {
      kind: "update";
      preset: string;
      nextSystemPrompt: string;
      nextRecipe: SystemPromptRecipe;
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

export function createSystemPromptRecipe(
  preset: string,
  memoryMode: MemoryPromptMode,
  content: string = buildSystemPrompt(preset, memoryMode),
): SystemPromptRecipe {
  return {
    preset,
    lettaCodeVersion: getVersion(),
    contentHash: hashSystemPrompt(content),
    memoryMode,
    updatedAt: new Date().toISOString(),
  };
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

function isValidRecipe(recipe: SystemPromptRecipe | undefined): boolean {
  return (
    !!recipe &&
    typeof recipe.preset === "string" &&
    typeof recipe.contentHash === "string" &&
    recipe.contentHash.startsWith(SYSTEM_PROMPT_HASH_PREFIX) &&
    isKnownPreset(recipe.preset)
  );
}

export function decideManagedSystemPromptUpdate(input: {
  agent: AgentState;
  memoryMode: MemoryPromptMode;
  storedPreset?: string;
  storedRecipe?: SystemPromptRecipe;
}): SystemPromptUpdateDecision {
  const { agent, memoryMode, storedPreset, storedRecipe } = input;
  const currentSystemPrompt = agent.system ?? "";
  const currentHash = hashSystemPrompt(currentSystemPrompt);

  if (storedPreset === "custom") {
    return { kind: "noop", reason: "system prompt is marked custom" };
  }

  if (storedRecipe) {
    if (!isValidRecipe(storedRecipe)) {
      return { kind: "clear", reason: "stored recipe is invalid or stale" };
    }

    if (currentHash !== storedRecipe.contentHash) {
      return {
        kind: "custom",
        reason: "agent prompt differs from stored managed prompt hash",
      };
    }

    const nextSystemPrompt = buildSystemPrompt(storedRecipe.preset, memoryMode);
    const nextRecipe = createSystemPromptRecipe(
      storedRecipe.preset,
      memoryMode,
      nextSystemPrompt,
    );

    if (
      nextRecipe.contentHash === storedRecipe.contentHash &&
      nextRecipe.memoryMode === storedRecipe.memoryMode &&
      nextRecipe.lettaCodeVersion === storedRecipe.lettaCodeVersion
    ) {
      return { kind: "noop", reason: "managed prompt is current" };
    }

    if (nextRecipe.contentHash === storedRecipe.contentHash) {
      return { kind: "adopt", recipe: nextRecipe };
    }

    return {
      kind: "update",
      preset: storedRecipe.preset,
      nextSystemPrompt,
      nextRecipe,
      reason: "managed prompt content changed for current Letta Code version",
    };
  }

  if (storedPreset) {
    if (!isKnownPreset(storedPreset)) {
      return { kind: "clear", reason: "stored preset is no longer known" };
    }

    const expectedCurrentPrompt = buildSystemPrompt(storedPreset, memoryMode);
    if (currentSystemPrompt === expectedCurrentPrompt) {
      return {
        kind: "adopt",
        recipe: createSystemPromptRecipe(
          storedPreset,
          memoryMode,
          expectedCurrentPrompt,
        ),
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
    kind: "adopt",
    recipe: createSystemPromptRecipe(
      matchingPreset,
      memoryMode,
      currentSystemPrompt,
    ),
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
    storedRecipe: settingsManager.getSystemPromptRecipe(agent.id),
  });

  if (decision.kind === "noop") {
    debugLog("startup", `System prompt version check noop: ${decision.reason}`);
    return;
  }

  if (decision.kind === "adopt") {
    settingsManager.setSystemPromptRecipe(agent.id, decision.recipe);
    debugLog(
      "startup",
      `Recorded system prompt recipe ${decision.recipe.preset}@${decision.recipe.lettaCodeVersion}`,
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
    debugLog("startup", `Cleared system prompt recipe: ${decision.reason}`);
    return;
  }

  void getBackend()
    .updateAgent(agent.id, {
      system: decision.nextSystemPrompt,
    })
    .then(async () => {
      settingsManager.setSystemPromptRecipe(agent.id, decision.nextRecipe);
      debugLog(
        "startup",
        `Updated managed system prompt ${decision.preset}@${decision.nextRecipe.lettaCodeVersion}: ${decision.reason}`,
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
