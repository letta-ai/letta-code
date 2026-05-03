import type { LanguageModel } from "ai";
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
import { listLocalModels, resolveLocalModelConfig } from "./LocalModelConfig";
import type { LocalStoreOptions } from "./LocalStore";

export type LocalBackendExecutionMode = "ai-sdk" | "deterministic";

export interface LocalBackendOptions {
  storageDir: string;
  defaultAgentId?: string;
  executionMode?: LocalBackendExecutionMode;
  executor?: HeadlessTurnExecutor;
  createModel?: () => LanguageModel;
  streamText?: AISDKStreamTextFunction;
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
  }

  override async listModels() {
    return listLocalModels() as never;
  }
}
