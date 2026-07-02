export { isContextWindowOverflowError } from "@/backend/dev/context-window-overflow";
export {
  formatLocalMessagesForSummary,
  isLocalSlidingWindowCompactionPlanningError,
  LOCAL_ALL_COMPACTION_PROMPT,
  LOCAL_DEFAULT_COMPACTION_MODE,
  LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE,
  LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT,
  type LocalCompactionMode,
  type LocalCompactionStats,
  LocalSlidingWindowCompactionPlanningError,
  planLocalSlidingWindowCompaction,
} from "./compaction";
export { LocalBackend, type LocalBackendOptions } from "./local-backend";
export type {
  LocalMessage,
  LocalMessageMetadata,
  LocalMessageProviderMetadata,
} from "./local-message";
export {
  type LocalModelConfig,
  listLocalModels,
  localModelHandle,
  localProviderType,
  resolveLocalModel,
  resolveLocalModelConfig,
  resolveLocalProvider,
} from "./local-model-config";
export {
  createOrUpdateLocalProvider,
  deleteLocalProvider,
  getLocalChatGPTOAuth,
  getLocalProviderApiKeyByName,
  getLocalProviderApiKeyByType,
  getLocalProviderAuthPath,
  getLocalProviderByName,
  getLocalProviderRecordByName,
  isLocalProviderTypeSupported,
  LOCAL_ANTHROPIC_PROVIDER_NAME,
  LOCAL_BEDROCK_PROVIDER_NAME,
  LOCAL_CHATGPT_PROVIDER_NAME,
  LOCAL_GOOGLE_AI_PROVIDER_NAME,
  LOCAL_KIMI_CODE_PROVIDER_NAME,
  LOCAL_LLAMA_CPP_PROVIDER_NAME,
  LOCAL_LMSTUDIO_PROVIDER_NAME,
  LOCAL_MINIMAX_PROVIDER_NAME,
  LOCAL_MOONSHOT_PROVIDER_NAME,
  LOCAL_OLLAMA_CLOUD_PROVIDER_NAME,
  LOCAL_OLLAMA_PROVIDER_NAME,
  LOCAL_OPENAI_PROVIDER_NAME,
  LOCAL_OPENROUTER_PROVIDER_NAME,
  LOCAL_ZAI_CODING_PROVIDER_NAME,
  LOCAL_ZAI_PROVIDER_NAME,
  type LocalProviderAuth,
  type LocalProviderRecord,
  listLocalProviderRecords,
  listLocalProviders,
  removeLocalProviderByName,
  setLocalChatGPTOAuth,
  updateLocalProvider,
} from "./local-provider-auth-store";
export {
  isHiddenLocalAgentRecord,
  type LocalAgentRecord,
  LocalBackendNotFoundError,
  LocalStore,
  type LocalStoreOptions,
  projectLocalAgentState,
  type StoredMessage,
  type StoredTurnInput,
} from "./local-store";
export type { ProviderStreamPart } from "./local-stream-chunks";
export {
  getLocalBackendMemoryFilesystemRoot,
  getLocalBackendStorageDir,
  isLocalBackendEnvEnabled,
  isLocalBackendNoMemfsEnvEnabled,
  LOCAL_BACKEND_NO_MEMFS_ENV,
} from "./paths";
