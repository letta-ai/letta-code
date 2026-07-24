import type { Usage } from "@earendil-works/pi-ai";
import {
  DeterministicPongExecutor,
  type HeadlessTurnExecutor,
} from "@/backend/dev/headless-turn-executor";
import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  PiStreamAdapter,
  type PiStreamFunction,
} from "@/backend/dev/pi-stream-adapter";
import type {
  LlmEndInfo,
  LlmStartInfo,
  ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";
import { ProviderTurnExecutor } from "@/backend/dev/provider-turn-executor";
import type { LocalCompactionStats } from "./compaction";
import type { LocalMessage } from "./local-message";

export type LocalBackendExecutionMode = "pi" | "deterministic";

export interface CreateLocalExecutorOptions {
  storageDir: string;
  executionMode?: LocalBackendExecutionMode;
  executor?: HeadlessTurnExecutor;
  stream?: PiStreamFunction;
}

type LocalCompactionCallback = (
  input: ProviderTurnInput,
  trigger: unknown,
) => Promise<{
  uiMessages: LocalMessage[];
  summary: string;
  stats?: LocalCompactionStats;
} | null>;

export function createLocalExecutor(
  options: CreateLocalExecutorOptions,
  modelsRuntime: LocalPiModelsRuntime,
  onContextWindowOverflow?: (
    input: ProviderTurnInput,
    error: unknown,
  ) => ReturnType<LocalCompactionCallback>,
  onContextUsage?: (
    input: ProviderTurnInput,
    usage: Usage,
  ) => ReturnType<LocalCompactionCallback>,
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
      modelsRuntime,
      onContextWindowOverflow,
      onContextUsage,
      onLlmStart,
      onLlmEnd,
    }),
  );
}
