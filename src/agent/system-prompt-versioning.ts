import { createHash } from "node:crypto";
import type { AgentState } from "@letta-ai/letta-client/resources/agents";
import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { debugLog, debugWarn } from "@/utils/debug";
import { getVersion } from "@/version";
import { LETTA_CODE_ORIGIN_TAG, LETTA_CODE_SUBAGENT_TAG } from "./agent-tags";
import { LEGACY_CLOUD_DEFAULT_PROMPT_HASHES } from "./legacy-default-system-prompt-hashes";
import { resolveScopedMemoryDir } from "./memory-filesystem";
import { detectMemoryFormat } from "./memory-format";
import {
  buildSystemPrompt,
  getSystemPromptVariantContents,
  isKnownPreset,
  type MemoryPromptMode,
  SYSTEM_PROMPTS,
} from "./prompt-assets";

const SYSTEM_PROMPT_HASH_PREFIX = "sha256:";
export const CLOUD_MANAGED_PROMPT_PRESET = "cloud-managed";

export function isCloudPromptBackend(): boolean {
  const capabilities = getBackend().capabilities;
  return (
    capabilities.remoteMemfs &&
    !capabilities.localMemfs &&
    capabilities.environmentRouting
  );
}

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
  | { kind: "inherit"; nextSystemPrompt: null; reason: string }
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

export function resolveMemoryPromptMode(input: {
  localMemfs: boolean;
  memoryDir: string | null;
  memfsEnabled: boolean;
}): MemoryPromptMode {
  if (input.localMemfs) {
    return "local-memfs";
  }
  if (
    input.memoryDir &&
    detectMemoryFormat(input.memoryDir, false) === "memfs-v2"
  ) {
    return "root-memfs";
  }
  return input.memfsEnabled ? "memfs" : "standard";
}

export function getMemoryPromptModeForAgent(agentId: string): MemoryPromptMode {
  const backend = getBackend();
  return resolveMemoryPromptMode({
    localMemfs: backend.capabilities.localMemfs,
    memoryDir: resolveScopedMemoryDir({ agentId }),
    memfsEnabled:
      settingsManager.isReady && settingsManager.isMemfsEnabled(agentId),
  });
}

function isLettaCodePrimaryAgent(agent: AgentState): boolean {
  const tags = agent.tags ?? [];
  return (
    tags.includes(LETTA_CODE_ORIGIN_TAG) &&
    !tags.includes(LETTA_CODE_SUBAGENT_TAG)
  );
}

function findMatchingCurrentPreset(systemPrompt: string): string | undefined {
  for (const preset of SYSTEM_PROMPTS) {
    if (
      getSystemPromptVariantContents(preset).some(
        (content) => content.trim() === systemPrompt.trim(),
      )
    ) {
      return preset.id;
    }
  }
  return undefined;
}

function isBundledDefaultPrompt(systemPrompt: string): boolean {
  const normalized = systemPrompt.trim();
  const defaultPreset = SYSTEM_PROMPTS.find(
    (preset) => preset.id === "default",
  );
  return (
    (defaultPreset !== undefined &&
      [
        defaultPreset.content,
        defaultPreset.memfsContent,
        defaultPreset.rootMemfsContent,
      ].some((content) => content?.trim() === normalized)) ||
    LEGACY_CLOUD_DEFAULT_PROMPT_HASHES.has(hashSystemPrompt(normalized))
  );
}

function isValidHash(hash: string | undefined): hash is string {
  return !!hash && hash.startsWith(SYSTEM_PROMPT_HASH_PREFIX);
}

export function decideManagedSystemPromptUpdate(input: {
  agent: AgentState;
  memoryMode: MemoryPromptMode;
  isLettaCloud?: boolean;
  preserveCloudSystemPrompt?: boolean;
  storedPreset?: string;
  storedHash?: string;
  storedVersion?: string;
}): SystemPromptUpdateDecision {
  const {
    agent,
    memoryMode,
    isLettaCloud,
    preserveCloudSystemPrompt,
    storedPreset,
    storedHash,
    storedVersion,
  } = input;
  if (agent.system == null) {
    return { kind: "noop", reason: "system prompt inherits backend default" };
  }

  if (storedPreset === CLOUD_MANAGED_PROMPT_PRESET) {
    return {
      kind: "custom",
      reason: "an explicit prompt replaced the Cloud-managed default",
    };
  }
  const currentSystemPrompt = agent.system ?? "";
  const currentHash = hashSystemPrompt(currentSystemPrompt);
  const currentVersion = getVersion();

  if (isLettaCloud && preserveCloudSystemPrompt) {
    return {
      kind: "noop",
      reason: "Cloud system prompt preservation requested",
    };
  }

  // The Cloud default is maintained by the server. Match actual prompt content
  // before trusting a stale local "custom" label, but never replace an edited
  // prompt or an explicitly selected non-default preset (including SDK prompts).
  if (
    isLettaCloud &&
    !(agent.tags ?? []).includes(LETTA_CODE_SUBAGENT_TAG) &&
    (storedPreset === undefined ||
      storedPreset === "default" ||
      storedPreset === "custom") &&
    (isBundledDefaultPrompt(currentSystemPrompt) ||
      (storedPreset === "default" &&
        isValidHash(storedHash) &&
        currentHash === storedHash))
  ) {
    return {
      kind: "inherit",
      nextSystemPrompt: null,
      reason: "stored prompt is a bundled Cloud default",
    };
  }

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
        const expectedCurrentPrompt = buildSystemPrompt(
          storedPreset,
          memoryMode,
        );
        if (currentSystemPrompt === expectedCurrentPrompt) {
          return {
            kind: "track",
            prompt: managedPrompt(
              storedPreset,
              memoryMode,
              currentSystemPrompt,
            ),
          };
        }
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

  if ((agent.tags ?? []).includes(LETTA_CODE_SUBAGENT_TAG)) {
    return { kind: "noop", reason: "agent is a Letta Code subagent" };
  }

  const matchingPreset = findMatchingCurrentPreset(currentSystemPrompt);
  if (!matchingPreset) {
    if (isLettaCodePrimaryAgent(agent)) {
      return {
        kind: "custom",
        reason:
          "legacy Letta Code agent prompt does not match a current preset",
      };
    }

    return { kind: "noop", reason: "agent prompt is not managed" };
  }

  const nextSystemPrompt = buildSystemPrompt(matchingPreset, memoryMode);
  if (currentSystemPrompt !== nextSystemPrompt) {
    return {
      kind: "update",
      nextSystemPrompt,
      prompt: managedPrompt(matchingPreset, memoryMode, nextSystemPrompt),
      reason: "untracked legacy Letta Code prompt detected",
    };
  }

  return {
    kind: "track",
    prompt: managedPrompt(matchingPreset, memoryMode, currentSystemPrompt),
  };
}

export async function ensureLettaCodeOriginTag(
  agent: AgentState,
): Promise<AgentState> {
  const backend = getBackend();
  const agentWithTags = agent.tags
    ? agent
    : await backend.retrieveAgent(agent.id, { include: ["agent.tags"] });
  const tags = agentWithTags.tags ?? [];

  if (tags.includes(LETTA_CODE_ORIGIN_TAG)) {
    return agentWithTags;
  }

  const nextTags = [...tags, LETTA_CODE_ORIGIN_TAG];
  const updatedAgent = await backend.updateAgent(agent.id, { tags: nextTags });

  return {
    ...agentWithTags,
    ...updatedAgent,
    tags: updatedAgent.tags ?? nextTags,
  } as AgentState;
}

export function scheduleManagedSystemPromptUpdate({
  agent,
  memoryMode,
  onUpdated,
}: ManagedSystemPromptUpdateOptions): void {
  if (!settingsManager.isReady) {
    return;
  }
  const backend = getBackend();

  const decision = decideManagedSystemPromptUpdate({
    agent,
    memoryMode,
    isLettaCloud: isCloudPromptBackend(),
    preserveCloudSystemPrompt:
      process.env.LETTA_CODE_PRESERVE_CLOUD_SYSTEM_PROMPT === "1",
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

  void backend
    .updateAgent(agent.id, {
      system: decision.nextSystemPrompt,
    })
    .then(async (updatedAgent) => {
      if (decision.kind === "inherit") {
        if (updatedAgent.system !== null) {
          const persistedAgent = await backend.retrieveAgent(agent.id);
          if (persistedAgent.system !== null) {
            throw new Error("Cloud did not clear the stored system prompt");
          }
        }
        settingsManager.setSystemPromptPreset(
          agent.id,
          CLOUD_MANAGED_PROMPT_PRESET,
        );
        debugLog(
          "startup",
          `Cloud now owns default system prompt: ${decision.reason}`,
        );
      } else {
        settingsManager.setManagedSystemPrompt(agent.id, decision.prompt);
        debugLog(
          "startup",
          `Updated managed system prompt ${decision.prompt.preset}@${decision.prompt.version}: ${decision.reason}`,
        );
      }
      if (onUpdated) {
        const updatedAgent = await getBackend().retrieveAgent(agent.id, {
          include: ["agent.tools", "agent.tags"],
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
