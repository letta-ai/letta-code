import { homedir } from "node:os";
import type { getClient } from "./api/client";
import type {
  ForkConversationOptions,
  forkConversation as forkConversationRequest,
} from "./api/conversations";
import { LocalBackend } from "./local/local-backend";
import {
  getLocalBackendStorageDir as getLocalBackendStorageDirFromPaths,
  LOCAL_BACKEND_EXPERIMENTAL_ENV,
} from "./local/paths";

export type APIClient = Awaited<ReturnType<typeof getClient>>;
type GetAPIClient = typeof getClient;
type ForkConversation = typeof forkConversationRequest;

export type ConversationMessageCreateParams = Parameters<
  APIClient["conversations"]["messages"]["create"]
>;
export type ConversationMessageCreateBody = ConversationMessageCreateParams[1];
export type ConversationMessageCreateOptions =
  ConversationMessageCreateParams[2];

export type ConversationMessageStreamParams = Parameters<
  APIClient["conversations"]["messages"]["stream"]
>;
export type ConversationMessageStreamBody = ConversationMessageStreamParams[1];
export type ConversationMessageStreamOptions =
  ConversationMessageStreamParams[2];

export type RunMessageStreamParams = Parameters<
  APIClient["runs"]["messages"]["stream"]
>;
export type RunMessageStreamBody = RunMessageStreamParams[1];
export type RunMessageStreamOptions = RunMessageStreamParams[2];

export type AgentRetrieveParams = Parameters<APIClient["agents"]["retrieve"]>;
export type AgentRetrieveOptions = AgentRetrieveParams[1];

export type AgentListParams = Parameters<APIClient["agents"]["list"]>;
export type AgentListBody = AgentListParams[0];

export type AgentDeleteParams = Parameters<APIClient["agents"]["delete"]>;
export type AgentDeleteOptions = AgentDeleteParams[1];

export type AgentUpdateParams = Parameters<APIClient["agents"]["update"]>;
export type AgentUpdateBody = AgentUpdateParams[1];
export type AgentUpdateOptions = AgentUpdateParams[2];

export type AgentCreateParams = Parameters<APIClient["agents"]["create"]>;
export type AgentCreateBody = AgentCreateParams[0];
export type AgentCreateOptions = AgentCreateParams[1];

export type ConversationRetrieveParams = Parameters<
  APIClient["conversations"]["retrieve"]
>;
export type ConversationRetrieveOptions = ConversationRetrieveParams[1];

export type ConversationListParams = Parameters<
  APIClient["conversations"]["list"]
>;
export type ConversationListBody = ConversationListParams[0];

export type ConversationCreateParams = Parameters<
  APIClient["conversations"]["create"]
>;
export type ConversationCreateBody = ConversationCreateParams[0];
export type ConversationCreateOptions = ConversationCreateParams[1];

export type ConversationUpdateParams = Parameters<
  APIClient["conversations"]["update"]
>;
export type ConversationUpdateBody = ConversationUpdateParams[1];
export type ConversationUpdateOptions = ConversationUpdateParams[2];

export type ConversationRecompileParams = Parameters<
  APIClient["conversations"]["recompile"]
>;
export type ConversationRecompileBody = ConversationRecompileParams[1];
export type ConversationRecompileOptions = ConversationRecompileParams[2];

export type ConversationMessageListParams = Parameters<
  APIClient["conversations"]["messages"]["list"]
>;
export type ConversationMessageListBody = ConversationMessageListParams[1];
export type ConversationMessageListOptions = ConversationMessageListParams[2];

export type ConversationMessageCompactParams = Parameters<
  APIClient["conversations"]["messages"]["compact"]
>;
export type ConversationMessageCompactBody =
  ConversationMessageCompactParams[1];
export type ConversationMessageCompactOptions =
  ConversationMessageCompactParams[2];

export type AgentMessageListParams = Parameters<
  APIClient["agents"]["messages"]["list"]
>;
export type AgentMessageListBody = AgentMessageListParams[1];
export type AgentMessageListOptions = AgentMessageListParams[2];

export type MessageRetrieveParams = Parameters<
  APIClient["messages"]["retrieve"]
>;
export type MessageRetrieveOptions = MessageRetrieveParams[1];

export type ModelsListParams = Parameters<APIClient["models"]["list"]>;
export type ModelsListOptions = ModelsListParams[0];

export interface BackendCapabilities {
  remoteMemfs: boolean;
  serverSideToolManagement: boolean;
  serverSecrets: boolean;
  agentFileImportExport: boolean;
  promptRecompile: boolean;
  byokProviderRefresh: boolean;
  localModelCatalog: boolean;
  localMemfs: boolean;
}

export interface Backend {
  readonly capabilities: BackendCapabilities;

  retrieveAgent(
    agentId: string,
    options?: AgentRetrieveOptions,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["retrieve"]>>>;

  listAgents(
    body?: AgentListBody,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["list"]>>>;

  deleteAgent(
    agentId: string,
    options?: AgentDeleteOptions,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["delete"]>>>;

  updateAgent(
    agentId: string,
    body: AgentUpdateBody,
    options?: AgentUpdateOptions,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["update"]>>>;

  createAgent(
    body: AgentCreateBody,
    options?: AgentCreateOptions,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["create"]>>>;

  retrieveConversation(
    conversationId: string,
    options?: ConversationRetrieveOptions,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["retrieve"]>>>;

  listConversations(
    body?: ConversationListBody,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["list"]>>>;

  createConversation(
    body: ConversationCreateBody,
    options?: ConversationCreateOptions,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["create"]>>>;

  updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
    options?: ConversationUpdateOptions,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["update"]>>>;

  recompileConversation(
    conversationId: string,
    body?: ConversationRecompileBody,
    options?: ConversationRecompileOptions,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["recompile"]>>>;

  listConversationMessages(
    conversationId: string,
    body?: ConversationMessageListBody,
    options?: ConversationMessageListOptions,
  ): Promise<
    Awaited<ReturnType<APIClient["conversations"]["messages"]["list"]>>
  >;

  compactConversationMessages(
    conversationId: string,
    body?: ConversationMessageCompactBody,
    options?: ConversationMessageCompactOptions,
  ): Promise<
    Awaited<ReturnType<APIClient["conversations"]["messages"]["compact"]>>
  >;

  listAgentMessages(
    agentId: string,
    body?: AgentMessageListBody,
    options?: AgentMessageListOptions,
  ): Promise<Awaited<ReturnType<APIClient["agents"]["messages"]["list"]>>>;

  retrieveMessage(
    messageId: string,
    options?: MessageRetrieveOptions,
  ): Promise<Awaited<ReturnType<APIClient["messages"]["retrieve"]>>>;

  listModels(
    options?: ModelsListOptions,
  ): Promise<Awaited<ReturnType<APIClient["models"]["list"]>>>;

  createConversationMessageStream(
    conversationId: string,
    body: ConversationMessageCreateBody,
    options?: ConversationMessageCreateOptions,
  ): Promise<
    Awaited<ReturnType<APIClient["conversations"]["messages"]["create"]>>
  >;

  streamConversationMessages(
    conversationId: string,
    body: ConversationMessageStreamBody,
    options?: ConversationMessageStreamOptions,
  ): Promise<
    Awaited<ReturnType<APIClient["conversations"]["messages"]["stream"]>>
  >;

  cancelConversation(
    conversationIdOrAgentId: string,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["cancel"]>>>;

  retrieveRun(
    runId: string,
  ): Promise<Awaited<ReturnType<APIClient["runs"]["retrieve"]>>>;

  streamRunMessages(
    runId: string,
    body: RunMessageStreamBody,
    options?: RunMessageStreamOptions,
  ): Promise<Awaited<ReturnType<APIClient["runs"]["messages"]["stream"]>>>;

  forkConversation(
    conversationId: string,
    options?: ForkConversationOptions,
  ): ReturnType<typeof forkConversationRequest>;
}

interface APIBackendDeps {
  getClient?: GetAPIClient;
  forkConversation?: ForkConversation;
}

export type BackendMode = "api" | "local";

export class APIBackend implements Backend {
  readonly capabilities: BackendCapabilities = {
    remoteMemfs: true,
    serverSideToolManagement: true,
    serverSecrets: true,
    agentFileImportExport: true,
    promptRecompile: true,
    byokProviderRefresh: true,
    localModelCatalog: false,
    localMemfs: false,
  };

  private readonly getApiClientOverride?: GetAPIClient;
  private readonly forkConversationOverride?: ForkConversation;

  constructor(deps: APIBackendDeps = {}) {
    this.getApiClientOverride = deps.getClient;
    this.forkConversationOverride = deps.forkConversation;
  }

  private async getClient(): Promise<APIClient> {
    if (this.getApiClientOverride) {
      return this.getApiClientOverride();
    }
    const { getClient: resolveClient } = await import("@/backend/api/client");
    return resolveClient();
  }

  async retrieveAgent(agentId: string, options?: AgentRetrieveOptions) {
    const client = await this.getClient();
    return client.agents.retrieve(agentId, options);
  }

  async listAgents(body?: AgentListBody) {
    const client = await this.getClient();
    return client.agents.list(body);
  }

  async deleteAgent(agentId: string, options?: AgentDeleteOptions) {
    const client = await this.getClient();
    return client.agents.delete(agentId, options);
  }

  async updateAgent(
    agentId: string,
    body: AgentUpdateBody,
    options?: AgentUpdateOptions,
  ) {
    const client = await this.getClient();
    return client.agents.update(agentId, body, options);
  }

  async createAgent(body: AgentCreateBody, options?: AgentCreateOptions) {
    const client = await this.getClient();
    return client.agents.create(body, options);
  }

  async retrieveConversation(
    conversationId: string,
    options?: ConversationRetrieveOptions,
  ) {
    const client = await this.getClient();
    return client.conversations.retrieve(conversationId, options);
  }

  async listConversations(body?: ConversationListBody) {
    const client = await this.getClient();
    return client.conversations.list(body);
  }

  async createConversation(
    body: ConversationCreateBody,
    options?: ConversationCreateOptions,
  ) {
    const client = await this.getClient();
    return client.conversations.create(body, options);
  }

  async updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
    options?: ConversationUpdateOptions,
  ) {
    const client = await this.getClient();
    return client.conversations.update(conversationId, body, options);
  }

  async recompileConversation(
    conversationId: string,
    body?: ConversationRecompileBody,
    options?: ConversationRecompileOptions,
  ) {
    const client = await this.getClient();
    return client.conversations.recompile(conversationId, body, options);
  }

  async listConversationMessages(
    conversationId: string,
    body?: ConversationMessageListBody,
    options?: ConversationMessageListOptions,
  ) {
    const client = await this.getClient();
    return client.conversations.messages.list(conversationId, body, options);
  }

  async compactConversationMessages(
    conversationId: string,
    body?: ConversationMessageCompactBody,
    options?: ConversationMessageCompactOptions,
  ) {
    const client = await this.getClient();
    return client.conversations.messages.compact(conversationId, body, options);
  }

  async listAgentMessages(
    agentId: string,
    body?: AgentMessageListBody,
    options?: AgentMessageListOptions,
  ) {
    const client = await this.getClient();
    return client.agents.messages.list(agentId, body, options);
  }

  async retrieveMessage(messageId: string, options?: MessageRetrieveOptions) {
    const client = await this.getClient();
    return client.messages.retrieve(messageId, options);
  }

  async listModels(options?: ModelsListOptions) {
    const client = await this.getClient();
    return client.models.list(options);
  }

  async createConversationMessageStream(
    conversationId: string,
    body: ConversationMessageCreateBody,
    options?: ConversationMessageCreateOptions,
  ) {
    const client = await this.getClient();
    return client.conversations.messages.create(conversationId, body, options);
  }

  async streamConversationMessages(
    conversationId: string,
    body: ConversationMessageStreamBody,
    options?: ConversationMessageStreamOptions,
  ) {
    const client = await this.getClient();
    return client.conversations.messages.stream(conversationId, body, options);
  }

  async cancelConversation(conversationIdOrAgentId: string) {
    const client = await this.getClient();
    return client.conversations.cancel(conversationIdOrAgentId);
  }

  async retrieveRun(runId: string) {
    const client = await this.getClient();
    return client.runs.retrieve(runId);
  }

  async streamRunMessages(
    runId: string,
    body: RunMessageStreamBody,
    options?: RunMessageStreamOptions,
  ) {
    const client = await this.getClient();
    return client.runs.messages.stream(runId, body, options);
  }

  async forkConversation(
    conversationId: string,
    options?: ForkConversationOptions,
  ) {
    if (this.forkConversationOverride) {
      return this.forkConversationOverride(conversationId, options);
    }
    const { forkConversation } = await import("@/backend/api/conversations");
    return forkConversation(conversationId, options);
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isExperimentalLocalBackendEnabled(): boolean {
  return resolveBackendMode() === "local";
}

export function getLocalBackendStorageDir(homeDir = homedir()): string {
  return getLocalBackendStorageDirFromPaths(homeDir);
}

function createExperimentalLocalBackend(): Backend {
  return new LocalBackend({
    storageDir: getLocalBackendStorageDir(),
    executionMode:
      process.env.LETTA_LOCAL_BACKEND_EXECUTOR === "deterministic"
        ? "deterministic"
        : "pi",
  });
}

let configuredBackendMode: BackendMode | null = null;

function resolveBackendMode(): BackendMode {
  if (configuredBackendMode) return configuredBackendMode;
  return isTruthyEnv(process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL)
    ? "local"
    : "api";
}

// Per-mode singletons — lazily created, cached for the process lifetime.
// Use these when you need a specific backend regardless of the current active mode
// (e.g. listing agents from both backends simultaneously in the /agents picker).
let localBackendSingleton: Backend | null = null;
let apiBackendSingleton: Backend | null = null;

export function getLocalBackendInstance(): Backend {
  localBackendSingleton ??= createExperimentalLocalBackend();
  return localBackendSingleton;
}

export function getApiBackendInstance(): Backend {
  apiBackendSingleton ??= new APIBackend();
  return apiBackendSingleton;
}

/**
 * Returns the backend responsible for the given agent ID.
 * Local agent IDs (agent-local-*) route to the local backend;
 * all others route to the API backend.
 */
export function getBackendForAgent(agentId: string): Backend {
  return agentId.startsWith("agent-local-")
    ? getLocalBackendInstance()
    : getApiBackendInstance();
}

// The "active" backend — what getBackend() returns. Starts null and is lazily
// set to whichever singleton matches the resolved startup mode.
let backend: Backend | null = null;

export function getBackend(): Backend {
  backend ??=
    resolveBackendMode() === "local"
      ? getLocalBackendInstance()
      : getApiBackendInstance();
  return backend;
}

export function configureBackendMode(mode: BackendMode): void {
  configuredBackendMode = mode;
  process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV] = mode === "local" ? "1" : "0";
  // Point the active backend at the appropriate singleton (creates it if needed).
  backend =
    mode === "local" ? getLocalBackendInstance() : getApiBackendInstance();
}

export function isLocalBackendEnabled(): boolean {
  return resolveBackendMode() === "local";
}

function devBackendStoreOptions() {
  return { storageDir: process.env.LETTA_CODE_DEV_BACKEND_DIR };
}

async function createPiDevBackend(): Promise<Backend> {
  const { FakeHeadlessBackend } = await import(
    "@/backend/dev/fake-headless-backend"
  );
  const { PiStreamAdapter } = await import("@/backend/dev/pi-stream-adapter");
  const { ProviderTurnExecutor } = await import(
    "@/backend/dev/provider-turn-executor"
  );
  return new FakeHeadlessBackend(
    "agent-fake-headless",
    new ProviderTurnExecutor(new PiStreamAdapter({})),
    devBackendStoreOptions(),
  );
}

export async function configureDevBackend(name: string): Promise<void> {
  switch (name) {
    case "fake-headless": {
      const { FakeHeadlessBackend } = await import(
        "@/backend/dev/fake-headless-backend"
      );
      backend = new FakeHeadlessBackend(
        undefined,
        undefined,
        devBackendStoreOptions(),
      );
      return;
    }
    case "fake-headless-tool-call": {
      const { FakeHeadlessBackend } = await import(
        "@/backend/dev/fake-headless-backend"
      );
      const { DeterministicToolCallExecutor } = await import(
        "@/backend/dev/headless-turn-executor"
      );
      backend = new FakeHeadlessBackend(
        "agent-fake-headless",
        new DeterministicToolCallExecutor(),
        devBackendStoreOptions(),
      );
      return;
    }
    case "fake-headless-provider": {
      const { FakeHeadlessBackend } = await import(
        "@/backend/dev/fake-headless-backend"
      );
      const { ProviderTurnExecutor } = await import(
        "@/backend/dev/provider-turn-executor"
      );
      backend = new FakeHeadlessBackend(
        "agent-fake-headless",
        new ProviderTurnExecutor(),
        devBackendStoreOptions(),
      );
      return;
    }
    case "fake-headless-pi": {
      backend = await createPiDevBackend();
      return;
    }
    default:
      throw new Error(`Unknown --dev-backend value "${name}"`);
  }
}

export function __testSetBackend(nextBackend: Backend | null): void {
  // Clear per-mode singletons so subsequent getLocalBackendInstance() /
  // getApiBackendInstance() calls don't return stale instances.
  localBackendSingleton = null;
  apiBackendSingleton = null;
  backend = nextBackend ?? getBackend();
}
