import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { type BackendCapabilities, getBackend } from "@/backend";
import { apiRequest, getApiRequestConfig } from "@/backend/api/request";
import { settingsManager } from "@/settings-manager";
import { SUBAGENT_NAME_ENV } from "@/utils/subagent-launch-marker";
import { getModelContextWindow } from "./available-models";
import { buildCreateAgentRequest } from "./create-agent-request";
import { getDefaultMemoryBlocks } from "./memory";
import {
  formatAvailableModels,
  getDefaultModel,
  getModelUpdateArgs,
  resolveModel,
} from "./model";
import { updateAgentLLMConfig } from "./modify";
import { isKnownPreset, type MemoryPromptMode } from "./prompt-assets";
import { resolveCreatedAgentName } from "./subagents/names";
import { resolveAndBuildSystemPrompt } from "./system-prompt-resolution";
import { recordManagedSystemPrompt } from "./system-prompt-versioning";

export interface BlockProvenance {
  label: string;
  source: "global" | "project" | "new" | "shared";
}

export interface AgentProvenance {
  isNew: true;
  blocks: BlockProvenance[];
}

export interface CreateAgentResult {
  agent: AgentState;
  provenance: AgentProvenance;
}

function isToolsNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: unknown } | null)?.status;

  return (
    typeof message === "string" &&
    /tools not found by name/i.test(message) &&
    /memory_apply_patch|memory|web_search|fetch_webpage/i.test(message) &&
    (status === undefined || status === 400)
  );
}

export async function addBaseToolsToServer(): Promise<boolean> {
  const { apiKey } = await getApiRequestConfig();

  if (!apiKey) {
    console.warn(
      "Cannot auto-populate base tools: missing LETTA_API_KEY for manual endpoint call.",
    );
    return false;
  }

  try {
    await apiRequest<void>("POST", "/v1/tools/add-base-tools");
    return true;
  } catch (err) {
    console.warn(
      `Failed to call /v1/tools/add-base-tools: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

type CreateWithToolsFn = (tools: string[]) => Promise<AgentState>;
type AddBaseToolsFn = () => Promise<boolean>;

export async function createAgentWithBaseToolsRecovery(
  createWithTools: CreateWithToolsFn,
  toolNames: string[],
  addBaseTools: AddBaseToolsFn = addBaseToolsToServer,
): Promise<AgentState> {
  try {
    return await createWithTools(toolNames);
  } catch (err) {
    if (!isToolsNotFoundError(err)) {
      throw err;
    }

    console.warn(
      "Agent creation failed due to missing base tools. Attempting to add base tools on server...",
    );
    await addBaseTools();

    try {
      return await createWithTools(toolNames);
    } catch (retryErr) {
      console.warn(
        `Agent creation still failed after base-tool bootstrap: ${
          retryErr instanceof Error ? retryErr.message : String(retryErr)
        }`,
      );
      console.warn(
        "Retrying agent creation with no server-side tools attached.",
      );
      return await createWithTools([]);
    }
  }
}

type MemfsCreateCapabilities = Pick<
  BackendCapabilities,
  "localMemfs" | "remoteMemfs"
>;

export interface CreatedAgentMemfsConfigOptions {
  capabilities: MemfsCreateCapabilities;
  requestedMemoryPromptMode?: MemoryPromptMode;
  isLettaCloud: boolean;
  isSubagent?: boolean;
}

export interface CreatedAgentMemfsConfig {
  enableMemfs: boolean;
  memoryPromptMode: MemoryPromptMode;
}

export interface CreatedAgentSystemPromptOptions {
  isLettaCloud: boolean;
  systemPromptPreset?: string;
  systemPromptCustom?: string;
  memoryPromptMode: MemoryPromptMode;
}

export async function resolveCreatedAgentSystemPrompt(
  options: CreatedAgentSystemPromptOptions,
): Promise<string | null> {
  if (options.systemPromptCustom !== undefined) {
    return options.systemPromptCustom;
  }
  if (
    options.isLettaCloud &&
    (!options.systemPromptPreset || options.systemPromptPreset === "default")
  ) {
    return null;
  }
  return resolveAndBuildSystemPrompt(
    options.systemPromptPreset,
    options.memoryPromptMode,
  );
}

export function resolveCreatedAgentMemfsConfig(
  options: CreatedAgentMemfsConfigOptions,
): CreatedAgentMemfsConfig {
  const supported =
    options.capabilities.localMemfs ||
    (options.capabilities.remoteMemfs && options.isLettaCloud) ||
    options.requestedMemoryPromptMode === "memfs" ||
    options.requestedMemoryPromptMode === "root-memfs" ||
    options.requestedMemoryPromptMode === "local-memfs";
  const enableMemfs = options.isSubagent ? false : supported;
  const requestedMemoryPromptMode =
    options.requestedMemoryPromptMode !== "standard"
      ? options.requestedMemoryPromptMode
      : undefined;
  const memoryPromptMode = !enableMemfs
    ? "standard"
    : options.capabilities.localMemfs
      ? "root-memfs"
      : options.isLettaCloud
        ? requestedMemoryPromptMode === "local-memfs"
          ? "local-memfs"
          : "root-memfs"
        : (requestedMemoryPromptMode ?? "memfs");

  return { enableMemfs, memoryPromptMode };
}

export interface CreateAgentOptions {
  name?: string;
  description?: string;
  model?: string;
  embeddingModel?: string;
  updateArgs?: Record<string, unknown>;
  skillsDirectory?: string;
  parallelToolCalls?: boolean;
  systemPromptPreset?: string;
  systemPromptCustom?: string;
  memoryPromptMode?: MemoryPromptMode;
  baseTools?: string[];
  memoryBlocks?: Array<
    { label: string; value: string; description?: string } | { blockId: string }
  >;
  blockValues?: Record<string, string>;
  tags?: string[];
}

export async function createAgent(
  nameOrOptions?: string | CreateAgentOptions,
  model?: string,
  embeddingModel?: string,
  updateArgs?: Record<string, unknown>,
  skillsDirectory?: string,
  parallelToolCalls = true,
  systemPromptPreset?: string,
  baseTools?: string[],
) {
  let options: CreateAgentOptions;
  if (typeof nameOrOptions === "object") {
    options = nameOrOptions;
  } else {
    options = {
      name: nameOrOptions,
      model,
      embeddingModel,
      updateArgs,
      skillsDirectory,
      parallelToolCalls,
      systemPromptPreset,
      baseTools,
    };
  }

  const embeddingModelVal = options.embeddingModel;
  const parallelToolCallsVal = options.parallelToolCalls ?? true;
  const isSubagent = process.env.LETTA_CODE_AGENT_ROLE === "subagent";
  const name = resolveCreatedAgentName(
    options.name,
    isSubagent,
    process.env[SUBAGENT_NAME_ENV],
  );
  delete process.env[SUBAGENT_NAME_ENV];

  let modelHandle: string;
  if (options.model) {
    const resolved = resolveModel(options.model);
    if (!resolved) {
      const availableModels = formatAvailableModels();
      console.error(`Error: Unknown model "${options.model}"`);
      console.error("Available models:");
      console.error(availableModels);
      throw new Error(`Unknown model "${options.model}".`);
    }
    modelHandle = resolved;
  } else {
    modelHandle = getDefaultModel();
  }

  const backend = getBackend();
  const isLettaCloud =
    backend.capabilities.remoteMemfs && !backend.capabilities.localMemfs
      ? await import("./memory-filesystem").then((module) =>
          module.isLettaCloud(),
        )
      : false;
  const memfsConfig = resolveCreatedAgentMemfsConfig({
    capabilities: backend.capabilities,
    requestedMemoryPromptMode: options.memoryPromptMode,
    isLettaCloud,
    isSubagent,
  });

  const toolNames = options.baseTools;

  const referencedBlockIds: string[] = [];
  let filteredMemoryBlocks: Array<{
    label: string;
    value: string;
    description?: string | null;
    limit?: number;
  }>;

  if (options.memoryBlocks !== undefined) {
    const createBlocks: typeof filteredMemoryBlocks = [];
    for (const item of options.memoryBlocks) {
      if ("blockId" in item) {
        referencedBlockIds.push(item.blockId);
      } else {
        createBlocks.push(item as (typeof filteredMemoryBlocks)[0]);
      }
    }
    filteredMemoryBlocks = createBlocks;
  } else {
    filteredMemoryBlocks = isSubagent ? [] : await getDefaultMemoryBlocks();
  }

  if (options.blockValues) {
    for (const [label, value] of Object.entries(options.blockValues)) {
      const block = filteredMemoryBlocks.find((b) => b.label === label);
      if (block) {
        block.value = value;
      } else {
        console.warn(
          `Ignoring block value override for "${label}" - block not included in memory config`,
        );
      }
    }
  }

  const blockProvenance: BlockProvenance[] = [];

  for (const block of filteredMemoryBlocks) {
    blockProvenance.push({ label: block.label, source: "new" });
  }

  for (const blockId of referencedBlockIds) {
    blockProvenance.push({ label: blockId, source: "shared" });
  }

  const modelIdentifierForDefaults = options.model ?? modelHandle;
  const modelUpdateArgs = options.model
    ? getModelUpdateArgs(modelIdentifierForDefaults)
    : undefined;
  const contextWindow =
    (modelUpdateArgs?.context_window as number | undefined) ??
    (await getModelContextWindow(modelHandle));

  const memMode: MemoryPromptMode = memfsConfig.memoryPromptMode;
  const systemPromptContent = await resolveCreatedAgentSystemPrompt({
    isLettaCloud,
    systemPromptPreset: options.systemPromptPreset,
    systemPromptCustom: options.systemPromptCustom,
    memoryPromptMode: memMode,
  });

  const agentDescription =
    options.description ?? `Letta Code agent created in ${process.cwd()}`;

  const createAgentRequestBase = await buildCreateAgentRequest({
    name,
    description: agentDescription,
    model: modelHandle,
    system: systemPromptContent,
    isLettaCloud,
    memoryPromptMode: memMode,
    memoryBlocks:
      filteredMemoryBlocks.length > 0 ? filteredMemoryBlocks : undefined,
    blockIds: referencedBlockIds,
    extraTags: options.tags,
    enableMemfs: memfsConfig.enableMemfs,
    isSubagent,
    baseTools: toolNames,
    embedding: embeddingModelVal || undefined,
    parallelToolCalls: parallelToolCallsVal,
  });

  const createWithTools = (tools: string[]) =>
    backend.createAgent({
      ...createAgentRequestBase,
      ...(contextWindow && { context_window_limit: contextWindow }),
      tools,
    });

  const agent = await createAgentWithBaseToolsRecovery(
    createWithTools,
    createAgentRequestBase.tools,
    addBaseToolsToServer,
  );

  const mergedUpdateArgs = {
    ...(modelUpdateArgs ?? {}),
    ...(options.updateArgs ?? {}),
  };
  if (Object.keys(mergedUpdateArgs).length > 0) {
    await updateAgentLLMConfig(agent.id, modelHandle, mergedUpdateArgs);
  }

  const fullAgent = await backend.retrieveAgent(agent.id, {
    include: ["agent.tags"],
  });

  if (backend.capabilities.localMemfs) {
    const { getScopedMemoryFilesystemRoot } = await import(
      "@/agent/memory-filesystem"
    );
    const { seedPersonalityDefaultMemoryFilesBestEffort } = await import(
      "@/agent/personality-default-files"
    );
    await seedPersonalityDefaultMemoryFilesBestEffort({
      agentId: fullAgent.id,
      memoryDir: getScopedMemoryFilesystemRoot(fullAgent.id),
      agentTags: fullAgent.tags,
      syncMode: "local",
    });
  }

  if (!isSubagent && settingsManager.isReady) {
    if (options.systemPromptCustom !== undefined) {
      settingsManager.setSystemPromptCustom(fullAgent.id);
    } else if (
      systemPromptContent !== null &&
      isKnownPreset(options.systemPromptPreset ?? "default")
    ) {
      recordManagedSystemPrompt(
        fullAgent.id,
        options.systemPromptPreset ?? "default",
        memMode,
        systemPromptContent,
      );
    }
  }

  const provenance: AgentProvenance = {
    isNew: true,
    blocks: blockProvenance,
  };

  return { agent: fullAgent, provenance };
}
