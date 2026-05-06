import type { LanguageModel } from "ai";
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
  type LocalCompactionStats,
  type LocalGenerateTextFunction,
  packageLocalSummaryMessage,
  summarizeLocalMessagesAll,
} from "./compaction";
import type { LocalMessage } from "./LocalMessage";
import { listLocalModels, resolveLocalModelConfig } from "./LocalModelConfig";
import type {
  LocalAgentRecord,
  LocalStoreOptions,
  StoredMessage,
} from "./LocalStore";
import { getLocalBackendMemoryFilesystemRoot } from "./paths";
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
): HeadlessTurnExecutor {
  if (options.executor) return options.executor;
  if (options.executionMode === "deterministic") {
    return new DeterministicPongExecutor();
  }
  return new ProviderTurnExecutor(
    new AISDKStreamAdapter({
      createModel: options.createModel,
      streamText: options.streamText,
      onContextWindowOverflow,
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

  constructor(options: LocalBackendOptions) {
    const localBackendRef: { current?: LocalBackend } = {};
    const modelConfig = resolveLocalModelConfig();
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
  }

  override async listModels() {
    return listLocalModels() as never;
  }

  override async createAgent(
    ...args: Parameters<HeadlessBackend["createAgent"]>
  ) {
    const [body] = args;
    const agent = await super.createAgent(...args);
    await this.ensureLocalMemoryRepo(
      agent.id,
      initialMemoryFilesFromCreateBody(body),
      agent.name ?? undefined,
    );
    await this.compileAndMaybePersistSystemPrompt("default", agent.id, {
      dryRun: false,
    });
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
    const result = await this.compactLocalConversationAll(
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
    const result = await this.compactLocalConversationAll(
      input.conversationId,
      input.agentId,
      "context_window_overflow",
      {
        compaction_settings: { mode: "all" },
      } as ConversationMessageCompactBody,
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

  private async compactLocalConversationAll(
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
    const settings = ((body ?? {}) as Record<string, unknown>)
      .compaction_settings as Record<string, unknown> | null | undefined;
    const mode = typeof settings?.mode === "string" ? settings.mode : "all";
    if (mode !== "all") {
      throw new Error(
        `Local backend compaction currently supports only mode "all" (received "${mode}").`,
      );
    }

    const agent = this.store.retrieveAgentRecord(agentId);
    const messages = this.store.listLocalMessages(conversationId, agentId);
    const contextTokensBefore = estimateLocalMessageTokens(messages);
    const prompt =
      typeof settings?.prompt === "string" ? settings.prompt : null;
    const clipChars =
      typeof settings?.clip_chars === "number" || settings?.clip_chars === null
        ? settings.clip_chars
        : undefined;
    const summary = await summarizeLocalMessagesAll({
      agent,
      messages,
      createModel: this.createModel,
      generateText: this.generateText,
      prompt,
      clipChars,
    });
    const stats: LocalCompactionStats = {
      trigger,
      context_tokens_before: contextTokensBefore,
      context_tokens_after: Math.ceil(summary.length / 4),
      context_window:
        typeof agent.model_settings.context_window_limit === "number"
          ? agent.model_settings.context_window_limit
          : undefined,
      messages_count_before: messages.length,
      messages_count_after: 1,
    };
    const storeResult = this.store.compactConversationAll({
      conversationId,
      agentId,
      summary,
      packedSummary: packageLocalSummaryMessage(summary, stats),
      stats,
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
    const memfsRevision = await getMemoryHeadRevision(
      this.memoryDirForAgent(agentId),
    );
    if (
      existing?.rawSystemHash === hashRawSystemPrompt(agent.system) &&
      memfsRevision !== null &&
      existing.memfsRevision === memfsRevision
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
    await this.ensureLocalMemoryRepo(agentId, [], agent.name);
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
      memoryDir: this.memoryDirForAgent(agentId),
    });
    if (!options.dryRun) {
      this.store.setCompiledSystemPrompt(conversationId, agentId, compiled);
    }
    return compiled;
  }
}
