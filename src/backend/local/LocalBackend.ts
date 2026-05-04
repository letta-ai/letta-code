import type { LanguageModel } from "ai";
import type {
  BackendCapabilities,
  ConversationCreateBody,
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
import { ProviderTurnExecutor } from "../dev/ProviderTurnExecutor";
import type { LocalMessage } from "./LocalMessage";
import { listLocalModels, resolveLocalModelConfig } from "./LocalModelConfig";
import type {
  LocalAgentRecord,
  LocalStoreOptions,
  StoredMessage,
} from "./LocalStore";
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
  memoryDir?: string;
}

function createLocalExecutor(
  options: LocalBackendOptions,
): HeadlessTurnExecutor {
  if (options.executor) return options.executor;
  if (options.executionMode === "deterministic") {
    return new DeterministicPongExecutor();
  }
  return new ProviderTurnExecutor(
    new AISDKStreamAdapter({
      createModel: options.createModel,
      streamText: options.streamText,
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

  constructor(options: LocalBackendOptions) {
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
      createLocalExecutor(options),
      storeOptions,
      {
        modelHandle: modelConfig.handle,
        runIdPrefix: "local-run-",
        runMetadataBackend: "local",
      },
    );
    this.memoryDir = options.memoryDir;
  }

  override async listModels() {
    return listLocalModels() as never;
  }

  override async createAgent(
    ...args: Parameters<HeadlessBackend["createAgent"]>
  ) {
    const agent = await super.createAgent(...args);
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

  private memoryDirForAgent(_agentId: string): string | undefined {
    return this.memoryDir ?? undefined;
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
    if (existing?.rawSystemHash === hashRawSystemPrompt(agent.system)) {
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
