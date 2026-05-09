import type { LanguageModel, LanguageModelUsage } from "ai";
import {
  getMemoryHeadRevision,
  type InitializeLocalMemoryRepoFile,
  initializeLocalMemoryRepo,
} from "../../agent/memoryGit";
import type {
  AgentCreateBody,
  Backend,
  BackendCapabilities,
  ConversationCreateBody,
  ConversationMessageCompactBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  ConversationMessageStreamBody,
  ConversationRecompileBody,
} from "../backend";
import {
  AISDKStreamAdapter,
  type AISDKStreamTextFunction,
} from "../dev/AISDKStreamAdapter";
import { HeadlessBackend } from "../dev/HeadlessBackend";
import {
  DeterministicPongExecutor,
  type HeadlessTurnExecutor,
} from "../dev/HeadlessTurnExecutor";
import type { ProviderTurnInput } from "../dev/ProviderTurnExecutor";
import { ProviderTurnExecutor } from "../dev/ProviderTurnExecutor";
import {
  estimateLocalMessageTokens,
  isLocalSlidingWindowCompactionPlanningError,
  LOCAL_DEFAULT_COMPACTION_MODE,
  LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE,
  type LocalCompactionMode,
  type LocalCompactionStats,
  type LocalGenerateTextFunction,
  packageLocalSummaryMessage,
  planLocalAllCompaction,
  planLocalSlidingWindowCompaction,
  summarizeLocalMessagesAll,
  summarizeLocalMessagesSlidingWindow,
} from "./compaction";
import type { LocalMessage } from "./LocalMessage";
import { listLocalModels, resolveLocalModelConfig } from "./LocalModelConfig";
import type {
  LocalAgentRecord,
  LocalStoreOptions,
  StoredMessage,
} from "./LocalStore";
import {
  getLocalBackendMemoryFilesystemRoot,
  isLocalBackendNoMemfsEnvEnabled,
} from "./paths";
import {
  appendAvailableSkillsBlock,
  compileLocalSystemPrompt,
  hashRawSystemPrompt,
  type LocalCompiledSystemPrompt,
} from "./systemPromptCompilation";

export type LocalBackendExecutionMode = "ai-sdk" | "deterministic";

export interface LocalBackendOptions {
  storageDir: string;
  defaultAgentId?: string;
  executionMode?: LocalBackendExecutionMode;
  executor?: HeadlessTurnExecutor;
  createModel?: () => LanguageModel;
  streamText?: AISDKStreamTextFunction;
  generateText?: LocalGenerateTextFunction;
  memoryDir?: string;
  memfsEnabled?: boolean;
}

function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function memoryBlockPath(label: string): string {
  const normalized = label.trim().replace(/\\/g, "/").replace(/\.md$/, "");
  if (normalized === "system" || normalized.startsWith("system/")) {
    return `${normalized}.md`;
  }
  return `system/${normalized}.md`;
}

function renderInitialMemoryFile(input: {
  label: string;
  value: string;
  description?: string | null;
}): InitializeLocalMemoryRepoFile | null {
  const relativePath = memoryBlockPath(input.label);
  const segments = relativePath.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : `Memory block ${input.label}`;
  return {
    relativePath: segments.join("/"),
    content: [
      "---",
      `description: ${sanitizeFrontmatterValue(description)}`,
      "---",
      input.value,
    ].join("\n"),
  };
}

function initialMemoryFilesFromCreateBody(
  body: AgentCreateBody,
): InitializeLocalMemoryRepoFile[] {
  const bodyRecord = body as Record<string, unknown>;
  const blocks = Array.isArray(bodyRecord.memory_blocks)
    ? bodyRecord.memory_blocks
    : [];
  const files = new Map<string, InitializeLocalMemoryRepoFile>();
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (typeof record.label !== "string") continue;
    const file = renderInitialMemoryFile({
      label: record.label,
      value: typeof record.value === "string" ? record.value : "",
      description:
        typeof record.description === "string" ? record.description : null,
    });
    if (file) files.set(file.relativePath, file);
  }
  return [...files.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
}

type LocalCompactionSettingsRecord = Record<string, unknown>;

interface ResolvedLocalCompactionSettings {
  mode: LocalCompactionMode;
  prompt?: string | null;
  clipChars?: number | null;
  slidingWindowPercentage: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactionSettingsRecord(
  value: unknown,
): LocalCompactionSettingsRecord | null | undefined {
  if (value === null) return null;
  return isRecord(value) ? { ...value } : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function localCompactionMode(value: unknown): LocalCompactionMode | undefined {
  if (value === "all" || value === "sliding_window") return value;
  return undefined;
}

function validateLocalCompactionSettingsRecord(
  settings: LocalCompactionSettingsRecord,
): void {
  if (settings.mode === undefined || settings.mode === null) return;
  if (!localCompactionMode(settings.mode)) {
    throw new Error(
      `Local backend compaction currently supports only modes "all" and "sliding_window" (received "${String(
        settings.mode,
      )}").`,
    );
  }
}

function localCompactionSettingsForStorage(
  settings: LocalCompactionSettingsRecord | null | undefined,
): LocalCompactionSettingsRecord | null | undefined {
  if (settings === undefined || settings === null) return settings;

  const hasLocalSetting =
    hasOwn(settings, "mode") ||
    hasOwn(settings, "prompt") ||
    hasOwn(settings, "clip_chars") ||
    hasOwn(settings, "sliding_window_percentage");
  if (!hasLocalSetting) return undefined;

  return { ...settings };
}

function contextTokensFromUsage(usage: LanguageModelUsage): number | undefined {
  if (
    typeof usage.inputTokens === "number" ||
    typeof usage.outputTokens === "number"
  ) {
    return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  return typeof usage.totalTokens === "number" ? usage.totalTokens : undefined;
}

function createLocalExecutor(
  options: LocalBackendOptions,
  onContextWindowOverflow?: (
    input: ProviderTurnInput,
    error: unknown,
  ) => Promise<{
    uiMessages: LocalMessage[];
    summary: string;
    stats?: LocalCompactionStats;
  } | null>,
  onContextUsage?: (
    input: ProviderTurnInput,
    usage: LanguageModelUsage,
  ) => Promise<{
    uiMessages: LocalMessage[];
    summary: string;
    stats?: LocalCompactionStats;
  } | null>,
): HeadlessTurnExecutor {
  if (options.executor) return options.executor;
  if (options.executionMode === "deterministic") {
    return new DeterministicPongExecutor();
  }
  return new ProviderTurnExecutor(
    new AISDKStreamAdapter({
      createModel: options.createModel,
      streamText: options.streamText,
      localProviderAuthStorageDir: options.storageDir,
      onContextWindowOverflow,
      onContextUsage,
    }),
  );
}

export class LocalBackend extends HeadlessBackend {
  override readonly capabilities: BackendCapabilities = {
    remoteMemfs: false,
    serverSideToolManagement: false,
    serverSecrets: false,
    agentFileImportExport: false,
    promptRecompile: true,
    byokProviderRefresh: false,
    localModelCatalog: true,
    localMemfs: true,
  };

  private readonly memoryDir?: string;
  private readonly storageDir: string;
  private readonly createModel?: () => LanguageModel;
  private readonly generateText?: LocalGenerateTextFunction;
  private readonly memfsEnabledOverride?: boolean;

  constructor(options: LocalBackendOptions) {
    const localBackendRef: { current?: LocalBackend } = {};
    const modelConfig = resolveLocalModelConfig(options.storageDir);
    const storeOptions: LocalStoreOptions = {
      storageDir: options.storageDir,
      seedDefaultAgent: false,
      strictAgentAccess: true,
      strictConversationAccess: true,
      defaultAgentName: "Letta Code",
      defaultAgentModel: modelConfig.handle,
      defaultAgentModelSettings: modelConfig.modelSettings,
      conversationIdPrefix: "local-conv-",
      storedMessageIdPrefix: "letta-msg-",
      localMessageIdPrefix: "ui-msg-",
    };
    super(
      options.defaultAgentId ?? "agent-local-default",
      createLocalExecutor(
        options,
        (input, error) =>
          localBackendRef.current?.compactAfterContextOverflow(input, error) ??
          Promise.resolve(null),
        (input, usage) =>
          localBackendRef.current?.compactAfterContextUsage(input, usage) ??
          Promise.resolve(null),
      ),
      storeOptions,
      {
        modelHandle: modelConfig.handle,
        runIdPrefix: "local-run-",
        runMetadataBackend: "local",
      },
    );
    localBackendRef.current = this;
    this.storageDir = options.storageDir;
    this.memoryDir = options.memoryDir;
    this.createModel = options.createModel;
    this.generateText = options.generateText;
    this.memfsEnabledOverride = options.memfsEnabled;
  }

  override async listModels() {
    return listLocalModels(this.storageDir) as never;
  }

  override async createAgent(
    ...args: Parameters<HeadlessBackend["createAgent"]>
  ) {
    const [body] = args;
    const requestedCompactionSettings = compactionSettingsRecord(
      (body as Record<string, unknown>).compaction_settings,
    );
    if (
      requestedCompactionSettings !== undefined &&
      requestedCompactionSettings !== null
    ) {
      validateLocalCompactionSettingsRecord(requestedCompactionSettings);
    }
    const compactionSettingsForStorage = localCompactionSettingsForStorage(
      requestedCompactionSettings,
    );
    let agent = await super.createAgent(...args);
    if (compactionSettingsForStorage !== undefined) {
      agent = this.store.setAgentCompactionSettings(
        agent.id,
        compactionSettingsForStorage,
      );
    }
    if (this.isLocalMemfsEnabled()) {
      await this.ensureLocalMemoryRepo(
        agent.id,
        initialMemoryFilesFromCreateBody(body),
        agent.name ?? undefined,
      );
    }
    await this.compileAndMaybePersistSystemPrompt("default", agent.id, {
      dryRun: false,
    });
    return agent;
  }

  override async updateAgent(
    ...args: Parameters<HeadlessBackend["updateAgent"]>
  ) {
    const [agentId, body] = args;
    const bodyRecord = body as Record<string, unknown>;
    const settings = hasOwn(bodyRecord, "compaction_settings")
      ? compactionSettingsRecord(bodyRecord.compaction_settings)
      : undefined;
    if (settings !== undefined && settings !== null) {
      validateLocalCompactionSettingsRecord(settings);
    }
    const compactionSettingsForStorage =
      localCompactionSettingsForStorage(settings);
    let agent = await super.updateAgent(...args);
    if (hasOwn(bodyRecord, "compaction_settings")) {
      if (compactionSettingsForStorage !== undefined) {
        agent = this.store.setAgentCompactionSettings(
          agentId,
          compactionSettingsForStorage,
        );
      }
    }
    return agent;
  }

  override async createConversation(
    body: ConversationCreateBody,
  ): ReturnType<HeadlessBackend["createConversation"]> {
    const conversation = await super.createConversation(body);
    await this.compileAndMaybePersistSystemPrompt(
      conversation.id,
      conversation.agent_id,
      { dryRun: false },
    );
    return conversation;
  }

  override async recompileConversation(
    conversationId: string,
    body?: ConversationRecompileBody,
  ) {
    const bodyRecord = (body ?? {}) as Record<string, unknown>;
    const agentId =
      typeof bodyRecord.agent_id === "string" && bodyRecord.agent_id.length > 0
        ? bodyRecord.agent_id
        : this.store.resolveAgentIdForConversation(conversationId);
    const compiled = await this.compileAndMaybePersistSystemPrompt(
      conversationId,
      agentId,
      { dryRun: bodyRecord.dry_run === true },
    );
    return compiled.content;
  }

  override async compactConversationMessages(
    conversationId: string,
    body?: ConversationMessageCompactBody,
  ): ReturnType<Backend["compactConversationMessages"]> {
    const bodyRecord = (body ?? {}) as Record<string, unknown>;
    const agentId =
      typeof bodyRecord.agent_id === "string" && bodyRecord.agent_id.length > 0
        ? bodyRecord.agent_id
        : this.store.resolveAgentIdForConversation(conversationId);
    const result = await this.compactLocalConversation(
      conversationId,
      agentId,
      "manual",
      body,
    );
    return {
      num_messages_before: result.numMessagesBefore,
      num_messages_after: result.numMessagesAfter,
      summary: result.summary,
    } as Awaited<ReturnType<Backend["compactConversationMessages"]>>;
  }

  protected override async resolveSystemPromptForTurn(input: {
    conversationId: string;
    agentId: string;
    agent: LocalAgentRecord;
    body: ConversationMessageCreateBody | ConversationMessageStreamBody;
    history: StoredMessage[];
    uiMessages: LocalMessage[];
  }): Promise<string> {
    const persisted = await this.getOrCompileSystemPrompt(
      input.conversationId,
      input.agentId,
      input.agent,
      input.history.length,
    );
    const clientSkills = Array.isArray(
      (input.body as Record<string, unknown>).client_skills,
    )
      ? ((input.body as Record<string, unknown>).client_skills as unknown[])
      : [];
    return appendAvailableSkillsBlock(persisted.content, clientSkills);
  }

  private memoryDirForAgent(agentId: string): string {
    return (
      this.memoryDir ??
      getLocalBackendMemoryFilesystemRoot(agentId, this.storageDir)
    );
  }

  private isLocalMemfsEnabled(): boolean {
    return this.memfsEnabledOverride ?? !isLocalBackendNoMemfsEnvEnabled();
  }

  private async ensureLocalMemoryRepo(
    agentId: string,
    files: InitializeLocalMemoryRepoFile[] = [],
    authorName?: string,
  ): Promise<void> {
    await initializeLocalMemoryRepo({
      memoryDir: this.memoryDirForAgent(agentId),
      agentId,
      authorName,
      files,
    });
  }

  private async compactAfterContextOverflow(
    input: ProviderTurnInput,
    _error: unknown,
  ): Promise<{
    uiMessages: LocalMessage[];
    summary: string;
    stats?: LocalCompactionStats;
  } | null> {
    const result = await this.compactLocalConversation(
      input.conversationId,
      input.agentId,
      "context_window_overflow",
    );
    return {
      uiMessages: this.store.listLocalMessages(
        input.conversationId,
        input.agentId,
      ),
      summary: result.summary,
      stats: result.stats,
    };
  }

  private async compactAfterContextUsage(
    input: ProviderTurnInput,
    usage: LanguageModelUsage,
  ): Promise<{
    uiMessages: LocalMessage[];
    summary: string;
    stats?: LocalCompactionStats;
  } | null> {
    const contextTokens = contextTokensFromUsage(usage);
    const contextWindow = this.effectiveContextWindow(
      input.conversationId,
      input.agentId,
    );
    if (
      contextTokens === undefined ||
      contextWindow === undefined ||
      contextTokens <= contextWindow
    ) {
      return null;
    }

    const result = await this.compactLocalConversation(
      input.conversationId,
      input.agentId,
      "context_window_limit",
    );
    return {
      uiMessages: this.store.listLocalMessages(
        input.conversationId,
        input.agentId,
      ),
      summary: result.summary,
      stats: result.stats,
    };
  }

  private effectiveContextWindow(
    conversationId: string,
    agentId: string,
  ): number | undefined {
    const conversation = this.store.retrieveConversation(
      conversationId,
      agentId,
    ) as { context_window_limit?: unknown; model_settings?: unknown };
    if (typeof conversation.context_window_limit === "number") {
      return conversation.context_window_limit;
    }
    const conversationModelSettings = conversation.model_settings;
    if (
      conversationModelSettings &&
      typeof conversationModelSettings === "object" &&
      !Array.isArray(conversationModelSettings) &&
      typeof (conversationModelSettings as { context_window_limit?: unknown })
        .context_window_limit === "number"
    ) {
      return (conversationModelSettings as { context_window_limit: number })
        .context_window_limit;
    }
    const agent = this.store.retrieveAgentRecord(agentId);
    return typeof agent.model_settings.context_window_limit === "number"
      ? agent.model_settings.context_window_limit
      : undefined;
  }

  private resolveCompactionSettings(
    agent: LocalAgentRecord,
    body?: ConversationMessageCompactBody,
  ): ResolvedLocalCompactionSettings {
    const bodyRecord = (body ?? {}) as Record<string, unknown>;
    const requestSettings = compactionSettingsRecord(
      bodyRecord.compaction_settings,
    );
    if (requestSettings !== undefined && requestSettings !== null) {
      validateLocalCompactionSettingsRecord(requestSettings);
    }
    const agentSettings = compactionSettingsRecord(agent.compaction_settings);
    const baseSettings =
      agentSettings && agentSettings !== null ? agentSettings : {};
    const mergedSettings =
      requestSettings && requestSettings !== null
        ? { ...baseSettings, ...requestSettings }
        : baseSettings;
    const requestChangedMode =
      requestSettings !== undefined &&
      requestSettings !== null &&
      hasOwn(requestSettings, "mode");
    const requestChangedPrompt =
      requestSettings !== undefined &&
      requestSettings !== null &&
      hasOwn(requestSettings, "prompt");
    if (
      requestChangedMode &&
      !requestChangedPrompt &&
      agentSettings &&
      agentSettings !== null &&
      agentSettings.mode !== requestSettings.mode
    ) {
      delete mergedSettings.prompt;
    }

    const mode =
      localCompactionMode(mergedSettings.mode) ?? LOCAL_DEFAULT_COMPACTION_MODE;
    return {
      mode,
      prompt:
        typeof mergedSettings.prompt === "string" ||
        mergedSettings.prompt === null
          ? mergedSettings.prompt
          : undefined,
      clipChars:
        typeof mergedSettings.clip_chars === "number" ||
        mergedSettings.clip_chars === null
          ? mergedSettings.clip_chars
          : undefined,
      slidingWindowPercentage:
        typeof mergedSettings.sliding_window_percentage === "number"
          ? mergedSettings.sliding_window_percentage
          : LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE,
    };
  }

  private async compactLocalConversation(
    conversationId: string,
    agentId: string,
    trigger: string,
    body?: ConversationMessageCompactBody,
  ): Promise<{
    numMessagesBefore: number;
    numMessagesAfter: number;
    summary: string;
    stats: LocalCompactionStats;
  }> {
    const agent = this.store.retrieveAgentRecord(agentId);
    const settings = this.resolveCompactionSettings(agent, body);
    if (settings.mode === "sliding_window") {
      try {
        const result = await this.compactLocalConversationSlidingWindow(
          conversationId,
          agentId,
          agent,
          trigger,
          settings,
        );
        if (
          result.stats.context_window === undefined ||
          result.stats.context_tokens_after === undefined ||
          result.stats.context_tokens_after < result.stats.context_window
        ) {
          return result;
        }
      } catch (error) {
        if (!isLocalSlidingWindowCompactionPlanningError(error)) throw error;
      }
    }
    return this.compactLocalConversationAll(
      conversationId,
      agentId,
      agent,
      trigger,
      {
        ...settings,
        mode: "all",
        prompt: settings.mode === "all" ? settings.prompt : undefined,
      },
    );
  }

  private async compactLocalConversationAll(
    conversationId: string,
    agentId: string,
    agent: LocalAgentRecord,
    trigger: string,
    settings: ResolvedLocalCompactionSettings,
  ): Promise<{
    numMessagesBefore: number;
    numMessagesAfter: number;
    summary: string;
    stats: LocalCompactionStats;
  }> {
    const messages = this.store.listLocalMessages(conversationId, agentId);
    const contextTokensBefore = estimateLocalMessageTokens(messages);
    const plan = planLocalAllCompaction(messages);
    const summary = await summarizeLocalMessagesAll({
      agent,
      messages: plan.messagesToSummarize,
      createModel: this.createModel,
      generateText: this.generateText,
      prompt: settings.prompt,
      clipChars: settings.clipChars,
      localProviderAuthStorageDir: this.storageDir,
    });
    const stats: LocalCompactionStats = {
      trigger,
      context_tokens_before: contextTokensBefore,
      context_tokens_after:
        Math.ceil(summary.length / 4) +
        estimateLocalMessageTokens(plan.messagesToKeep),
      context_window: this.effectiveContextWindow(conversationId, agentId),
      messages_count_before: messages.length,
      messages_count_after: 1 + plan.messagesToKeep.length,
    };
    const storeResult = this.store.compactConversationAll({
      conversationId,
      agentId,
      summary,
      packedSummary: packageLocalSummaryMessage(summary, stats),
      stats,
      remainingMessages: plan.messagesToKeep,
    });
    return {
      numMessagesBefore: storeResult.numMessagesBefore,
      numMessagesAfter: storeResult.numMessagesAfter,
      summary,
      stats,
    };
  }

  private async compactLocalConversationSlidingWindow(
    conversationId: string,
    agentId: string,
    agent: LocalAgentRecord,
    trigger: string,
    settings: ResolvedLocalCompactionSettings,
  ): Promise<{
    numMessagesBefore: number;
    numMessagesAfter: number;
    summary: string;
    stats: LocalCompactionStats;
  }> {
    const messages = this.store.listLocalMessages(conversationId, agentId);
    const contextWindow = this.effectiveContextWindow(conversationId, agentId);
    const plan = planLocalSlidingWindowCompaction(messages, {
      slidingWindowPercentage: settings.slidingWindowPercentage,
      contextWindow,
    });
    const summary = await summarizeLocalMessagesSlidingWindow({
      agent,
      messages: plan.messagesToSummarize,
      createModel: this.createModel,
      generateText: this.generateText,
      prompt: settings.prompt,
      clipChars: settings.clipChars,
      localProviderAuthStorageDir: this.storageDir,
    });
    const contextTokensAfter =
      Math.ceil(summary.length / 4) +
      estimateLocalMessageTokens(plan.messagesToKeep);
    const stats: LocalCompactionStats = {
      trigger,
      context_tokens_before: estimateLocalMessageTokens(messages),
      context_tokens_after: contextTokensAfter,
      context_window: contextWindow,
      messages_count_before: messages.length,
      messages_count_after: 1 + plan.messagesToKeep.length,
    };
    const storeResult = this.store.compactConversationAll({
      conversationId,
      agentId,
      summary,
      packedSummary: packageLocalSummaryMessage(summary, stats),
      stats,
      remainingMessages: plan.messagesToKeep,
    });
    return {
      numMessagesBefore: storeResult.numMessagesBefore,
      numMessagesAfter: storeResult.numMessagesAfter,
      summary,
      stats,
    };
  }

  private async getOrCompileSystemPrompt(
    conversationId: string,
    agentId: string,
    agent = this.store.retrieveAgentRecord(agentId),
    previousMessageCount = 0,
  ): Promise<LocalCompiledSystemPrompt> {
    const existing = this.store.getCompiledSystemPrompt(
      conversationId,
      agentId,
    );
    const memfsEnabled = this.isLocalMemfsEnabled();
    const memfsRevision = memfsEnabled
      ? await getMemoryHeadRevision(this.memoryDirForAgent(agentId))
      : undefined;
    if (
      existing?.rawSystemHash === hashRawSystemPrompt(agent.system) &&
      (memfsEnabled
        ? memfsRevision !== null && existing.memfsRevision === memfsRevision
        : existing.memfsRevision === undefined)
    ) {
      return existing;
    }
    return this.compileAndMaybePersistSystemPrompt(conversationId, agentId, {
      dryRun: false,
      previousMessageCount,
    });
  }

  private async compileAndMaybePersistSystemPrompt(
    conversationId: string,
    agentId: string,
    options: { dryRun: boolean; previousMessageCount?: number },
  ): Promise<LocalCompiledSystemPrompt> {
    const agent = this.store.retrieveAgentRecord(agentId);
    const memfsEnabled = this.isLocalMemfsEnabled();
    if (memfsEnabled) {
      await this.ensureLocalMemoryRepo(agentId, [], agent.name);
    }
    const previousMessageCount =
      options.previousMessageCount ??
      this.store.listConversationMessages(conversationId, {
        agent_id: agentId,
        order: "asc",
      } as ConversationMessageListBody).length;
    const compiled = compileLocalSystemPrompt({
      agent,
      conversationId,
      previousMessageCount,
      memoryDir: memfsEnabled ? this.memoryDirForAgent(agentId) : undefined,
      includeMemfs: memfsEnabled,
    });
    if (!options.dryRun) {
      this.store.setCompiledSystemPrompt(conversationId, agentId, compiled);
    }
    return compiled;
  }
}
