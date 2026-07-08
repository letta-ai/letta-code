import type { Usage } from "@earendil-works/pi-ai";
import { GIT_MEMORY_ENABLED_TAG } from "@/agent/agent-tags";
import {
  type InitializeLocalMemoryRepoFile,
  initializeLocalMemoryRepo,
} from "@/agent/memory-git";
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
} from "@/backend/backend";
import { HeadlessBackend } from "@/backend/dev/headless-backend";
import {
  DeterministicPongExecutor,
  type HeadlessTurnExecutor,
} from "@/backend/dev/headless-turn-executor";
import {
  PiStreamAdapter,
  type PiStreamFunction,
} from "@/backend/dev/pi-stream-adapter";
import type {
  LlmEndInfo,
  LlmStartInfo,
  ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";
import {
  contextTokensFromUsage,
  estimateProviderContextTokens,
  ProviderTurnExecutor,
} from "@/backend/dev/provider-turn-executor";
import { isRecord } from "@/utils/type-guards";
import {
  estimateLocalMessageTokens,
  isLocalSlidingWindowCompactionPlanningError,
  LOCAL_DEFAULT_COMPACTION_MODE,
  LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE,
  type LocalCompactionMode,
  type LocalCompactionStats,
  type LocalCompleteFunction,
  packageLocalSummaryMessage,
  planLocalAllCompaction,
  planLocalSlidingWindowCompaction,
  summarizeLocalMessagesAll,
  summarizeLocalMessagesSlidingWindow,
} from "./compaction";
import type { LocalMessage } from "./local-message";
import {
  listLocalModels,
  localModelSettingsForHandle,
  resolveLocalModelConfig,
} from "./local-model-config";
import type {
  LocalAgentRecord,
  LocalStoreOptions,
  StoredMessage,
} from "./local-store";
import {
  getLocalBackendMemoryFilesystemRoot,
  isLocalBackendMemfsDisabledForProcess,
} from "./paths";
import {
  appendAvailableSkillsBlock,
  compileLocalSystemPrompt,
  getCommittedMemfsRevision,
  hashRawSystemPrompt,
  type LocalCompiledSystemPrompt,
} from "./system-prompt-compilation";

export type LocalBackendExecutionMode = "pi" | "deterministic";

export interface LocalBackendOptions {
  storageDir: string;
  defaultAgentId?: string;
  executionMode?: LocalBackendExecutionMode;
  executor?: HeadlessTurnExecutor;
  stream?: PiStreamFunction;
  complete?: LocalCompleteFunction;
  memoryDir?: string;
  memfsEnabled?: boolean;
}

/**
 * Hooks the harness installs (via {@link LocalBackend.setModEventHooks}) so
 * mods can observe backend-internal lifecycle that only the local backend owns
 * (compaction and provider calls). The backend stays mod-agnostic: it invokes
 * these plain callbacks and never touches mod state.
 */
export interface LocalBackendModEventHooks {
  onCompactStart?: (info: {
    agentId: string;
    conversationId: string;
    trigger: string;
  }) => void | Promise<void>;
  onCompactEnd?: (info: {
    agentId: string;
    conversationId: string;
    trigger: string;
    messagesBefore: number;
    messagesAfter: number;
    contextTokensBefore: number;
    contextTokensAfter: number;
  }) => void | Promise<void>;
  onLlmStart?: (info: LlmStartInfo) => void | Promise<void>;
  onLlmEnd?: (info: LlmEndInfo) => void | Promise<void>;
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

export function renderInitialMemoryFile(input: {
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

function supportsMidConversationSystemMessages(
  agent: LocalAgentRecord,
): boolean {
  return agent.model === "anthropic/claude-opus-4-8";
}

function formatMidConversationMemoryUpdate(
  compiled: LocalCompiledSystemPrompt,
): string {
  return [
    "<memory_update>",
    `The local memory filesystem has been edited and committed at revision ${compiled.memfsRevision ?? "unknown"}.`,
    "This updates part of your persona/system memory. Treat the following freshly rendered memory context as authoritative from now on; where it conflicts with earlier memory context, this newer memory context wins.",
    "",
    compiled.coreMemory.trimEnd(),
    "</memory_update>",
  ].join("\n");
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
    usage: Usage,
  ) => Promise<{
    uiMessages: LocalMessage[];
    summary: string;
    stats?: LocalCompactionStats;
  } | null>,
  onLlmStart?: (info: LlmStartInfo) => void | Promise<void>,
  onLlmEnd?: (info: LlmEndInfo) => void | Promise<void>,
): HeadlessTurnExecutor {
  if (options.executor) return options.executor;
  if (options.executionMode === "deterministic") {
    return new DeterministicPongExecutor();
  }
  return new ProviderTurnExecutor(
    new PiStreamAdapter({
      stream: options.stream,
      localProviderAuthStorageDir: options.storageDir,
      onContextWindowOverflow,
      onContextUsage,
      onLlmStart,
      onLlmEnd,
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
  private readonly complete?: LocalCompleteFunction;
  private readonly memfsEnabledOverride?: boolean;
  private modEventHooks?: LocalBackendModEventHooks;

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
      modelSettingsForModel: localModelSettingsForHandle,
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
        (info) =>
          localBackendRef.current?.emitLlmStart(info) ?? Promise.resolve(),
        (info) =>
          localBackendRef.current?.emitLlmEnd(info) ?? Promise.resolve(),
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
    this.complete = options.complete;
    this.memfsEnabledOverride = options.memfsEnabled;
  }

  /**
   * Late-bound because the backend is a process-global singleton constructed
   * before the harness mod adapter exists. The harness calls this once the
   * registry is ready to forward backend-internal events to local mods.
   */
  setModEventHooks(hooks: LocalBackendModEventHooks | undefined): void {
    this.modEventHooks = hooks;
  }

  private async emitCompactStart(
    conversationId: string,
    agentId: string,
    trigger: string,
  ): Promise<void> {
    const hook = this.modEventHooks?.onCompactStart;
    if (!hook) return;
    try {
      await hook({ agentId, conversationId, trigger });
    } catch {
      // Mod event hooks must never break compaction.
    }
  }

  private async emitCompactEnd(
    conversationId: string,
    agentId: string,
    trigger: string,
    stats: LocalCompactionStats,
  ): Promise<void> {
    const hook = this.modEventHooks?.onCompactEnd;
    if (!hook) return;
    try {
      await hook({
        agentId,
        conversationId,
        trigger,
        messagesBefore: stats.messages_count_before ?? 0,
        messagesAfter: stats.messages_count_after ?? 0,
        contextTokensBefore: stats.context_tokens_before ?? 0,
        contextTokensAfter: stats.context_tokens_after ?? 0,
      });
    } catch {
      // Mod event hooks must never break compaction.
    }
  }

  private async emitLlmStart(info: LlmStartInfo): Promise<void> {
    const hook = this.modEventHooks?.onLlmStart;
    if (!hook) return;
    try {
      await hook(info);
    } catch {
      // Mod event hooks must never break a provider request.
    }
  }

  private async emitLlmEnd(info: LlmEndInfo): Promise<void> {
    const hook = this.modEventHooks?.onLlmEnd;
    if (!hook) return;
    try {
      await hook(info);
    } catch {
      // Mod event hooks must never break a provider request.
    }
  }

  getLocalStorageDir(): string {
    return this.storageDir;
  }

  override async listModels() {
    return listLocalModels(this.storageDir) as never;
  }

  override async createAgent(
    ...args: Parameters<HeadlessBackend["createAgent"]>
  ) {
    let [body, ...restArgs] = args;
    // When local memfs is enabled, stamp the git-memory-enabled tag on the
    // agent body so all downstream tag-checking paths (isMemfsEnabledOnServer,
    // memfs-sync, etc.) see this agent as memfs-enabled from creation.
    if (this.isLocalMemfsEnabled()) {
      const bodyRecord = body as Record<string, unknown>;
      const existingTags = Array.isArray(bodyRecord.tags)
        ? (bodyRecord.tags as string[])
        : [];
      if (!existingTags.includes(GIT_MEMORY_ENABLED_TAG)) {
        body = {
          ...bodyRecord,
          tags: [...existingTags, GIT_MEMORY_ENABLED_TAG],
        } as typeof body;
      }
    }
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
    let agent = await super.createAgent(body, ...restArgs);
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
  }): Promise<{ systemPrompt: string; midConversationSystemPrompt?: string }> {
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
    return {
      systemPrompt: appendAvailableSkillsBlock(persisted.content, clientSkills),
      ...(persisted.midConversationSystemPrompt
        ? { midConversationSystemPrompt: persisted.midConversationSystemPrompt }
        : {}),
    };
  }

  private memoryDirForAgent(agentId: string): string {
    return (
      this.memoryDir ??
      getLocalBackendMemoryFilesystemRoot(agentId, this.storageDir)
    );
  }

  private isLocalMemfsEnabled(): boolean {
    return (
      this.memfsEnabledOverride ?? !isLocalBackendMemfsDisabledForProcess()
    );
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
    usage: Usage,
  ): Promise<{
    uiMessages: LocalMessage[];
    summary: string;
    stats?: LocalCompactionStats;
  } | null> {
    const contextTokens =
      contextTokensFromUsage(usage) ?? estimateProviderContextTokens(input);
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

  /**
   * Resolve the model that compaction should use for a conversation.
   *
   * A normal turn runs on the conversation's model override (set via `/model`),
   * but compaction previously read only the agent's base model — so switching
   * a conversation's model never changed which model compaction (and its
   * summarizer) used. This overlays the conversation's `model` / `model_settings`
   * onto the agent record so compaction mirrors the turn path.
   */
  private effectiveAgentForConversation(
    conversationId: string,
    agentId: string,
  ): LocalAgentRecord {
    const agent = this.store.retrieveAgentRecord(agentId);
    const conversation = this.store.retrieveConversation(
      conversationId,
      agentId,
    ) as { model?: unknown; model_settings?: unknown };
    const model =
      typeof conversation.model === "string" ? conversation.model : undefined;
    const conversationModelSettings = isRecord(conversation.model_settings)
      ? conversation.model_settings
      : undefined;
    if (model === undefined && conversationModelSettings === undefined) {
      return agent;
    }
    return {
      ...agent,
      ...(model !== undefined ? { model } : {}),
      ...(conversationModelSettings !== undefined
        ? {
            model_settings: {
              ...agent.model_settings,
              ...conversationModelSettings,
            },
          }
        : {}),
    };
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
    await this.emitCompactStart(conversationId, agentId, trigger);
    const result = await this.compactLocalConversationInner(
      conversationId,
      agentId,
      trigger,
      body,
    );
    await this.emitCompactEnd(conversationId, agentId, trigger, result.stats);
    return result;
  }

  private async compactLocalConversationInner(
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
    const agent = this.effectiveAgentForConversation(conversationId, agentId);
    const settings = this.resolveCompactionSettings(agent, body);
    let result: {
      numMessagesBefore: number;
      numMessagesAfter: number;
      summary: string;
      stats: LocalCompactionStats;
    };
    if (settings.mode === "sliding_window") {
      try {
        result = await this.compactLocalConversationSlidingWindow(
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
          await this.compileAndMaybePersistSystemPrompt(
            conversationId,
            agentId,
            {
              dryRun: false,
            },
          );
          return result;
        }
      } catch (error) {
        if (!isLocalSlidingWindowCompactionPlanningError(error)) throw error;
      }
    }
    result = await this.compactLocalConversationAll(
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
    await this.compileAndMaybePersistSystemPrompt(conversationId, agentId, {
      dryRun: false,
    });
    return result;
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
      complete: this.complete,
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
      packedSummary: packageLocalSummaryMessage(summary, stats, settings.mode),
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
      complete: this.complete,
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
      packedSummary: packageLocalSummaryMessage(summary, stats, settings.mode),
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
    const rawSystemHash = hashRawSystemPrompt(agent.system);
    const memfsRevision = this.isLocalMemfsEnabled()
      ? getCommittedMemfsRevision(this.memoryDirForAgent(agentId))
      : undefined;
    if (
      existing?.rawSystemHash === rawSystemHash &&
      existing.memfsRevision === memfsRevision
    ) {
      return existing;
    }

    if (
      existing?.rawSystemHash === rawSystemHash &&
      existing.memfsRevision !== memfsRevision &&
      supportsMidConversationSystemMessages(agent)
    ) {
      const compiled = await this.compileAndMaybePersistSystemPrompt(
        conversationId,
        agentId,
        {
          dryRun: true,
          previousMessageCount,
        },
      );
      if (compiled.memfsRevision !== existing.memfsRevision) {
        const midConversationSystemPrompt =
          formatMidConversationMemoryUpdate(compiled);
        this.store.setCompiledSystemPrompt(conversationId, agentId, {
          ...existing,
          compiledAt: compiled.compiledAt,
          coreMemory: compiled.coreMemory,
          memfsRevision: compiled.memfsRevision,
        });
        return { ...existing, midConversationSystemPrompt };
      }
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
