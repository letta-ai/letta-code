import type { LanguageModel } from "ai";
import {
  AISDKStreamAdapter,
  type AISDKStreamTextFunction,
} from "../dev/AISDKStreamAdapter";
import { FakeHeadlessBackend } from "../dev/FakeHeadlessBackend";
import {
  DeterministicPongExecutor,
  type HeadlessTurnExecutor,
} from "../dev/HeadlessTurnExecutor";
import { ProviderTurnExecutor } from "../dev/ProviderTurnExecutor";
import { listLocalModels, resolveLocalModelConfig } from "./LocalModelConfig";
import type { LocalStoreOptions } from "./LocalStore";

export type LocalBackendExecutionMode = "ai-sdk" | "fake";

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
  if (options.executionMode === "fake") {
    return new DeterministicPongExecutor();
  }
  return new ProviderTurnExecutor(
    new AISDKStreamAdapter({
      createModel: options.createModel,
      streamText: options.streamText,
    }),
  );
}

export class LocalBackend extends FakeHeadlessBackend {
  constructor(options: LocalBackendOptions) {
    const modelConfig = resolveLocalModelConfig();
    const storeOptions: LocalStoreOptions = {
      storageDir: options.storageDir,
      seedDefaultAgent: false,
      strictAgentAccess: true,
      strictConversationAccess: true,
      defaultAgentModel: modelConfig.handle,
      defaultAgentModelSettings: modelConfig.modelSettings,
    };
    super(options.defaultAgentId, createLocalExecutor(options), storeOptions);
  }

  override async listModels() {
    return listLocalModels() as never;
  }
}
