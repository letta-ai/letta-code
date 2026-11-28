import { randomUUID } from "node:crypto";
import { APIError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import { resolveActingUserId } from "@/agent/acting-user";
import { loadPreloadedSkills } from "@/agent/preloaded-skills";
import { createSubagentConversation } from "@/agent/subagents/subagent-conversation";
import { shouldLaunchThroughListener } from "@/agent/subagents/subagent-launcher";
import { disableLocalBackendMemfsForProcess } from "@/backend/local/paths";
import { INTERRUPTED_BY_USER } from "@/constants";
import {
  createHeadlessInterrupt,
  waitForTerminationOutput,
} from "@/headless-interrupt";
import { buildHeadlessSenderReminder } from "@/headless-message-sender";
import { createHeadlessResponseState } from "@/headless-response-state";
import { createStartupBackend } from "@/headless-startup-backend";
import { serializeQueuedMessageAsUserLine } from "@/queue/queued-message-line";
import { getTerminalTelemetrySurface, telemetry } from "@/telemetry";
import {
  trackBoundaryError,
  trackEndTurnNoAssistant,
} from "@/telemetry/error-reporting";
import { extractTelemetryInputText } from "@/telemetry/input";
import { installHeadlessStdoutGuard } from "@/utils/headless-stdout-guard";
import {
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { detectShellContext } from "@/utils/shell-context";
import {
  consumeSubagentLaunch,
  LISTENER_CONNECTION_ENV,
  SUBAGENT_LAUNCH_PROFILE_ENV,
} from "@/utils/subagent-launch-marker";
import { reportSubagentStdoutLoss } from "@/utils/subagent-stdout-failure";
import { isAgentIdCompatibleWithBackend } from "./agent/agent-id";
import type { ApprovalResult } from "./agent/approval-execution";
import {
  CONVERSATION_BUSY_WAIT_TIMEOUT_MS as BUSY_WAIT_MS,
  buildFreshDenialApprovals,
  extractConflictDetail,
  extractConversationBusyRunId,
  fetchRunErrorInfo,
  getPreStreamErrorAction,
  getRetryDelayMs,
  isApprovalPendingError,
  isEmptyResponseRetryable,
  isInvalidToolCallIdsError,
  parseRetryAfterHeaderMs,
  rebuildInputForApprovalResync,
  refreshInputOtidsForNewRequest,
  reportBusyRetryExhausted,
  resumeConversationBusyRequest as resumeBusy,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
  shouldRetryRunMetadataError,
  waitForConversationBusyRunOrThrow as waitForBusyRun,
} from "./agent/approval-recovery";
import { handleBootstrapSessionState } from "./agent/bootstrap-handler";
import {
  CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN,
  formatPlanRotationNotice,
  rotateChatGPTPlanOnQuotaLimit,
} from "./agent/chatgpt-plan-rotation";
import { setAgentContext, setConversationId } from "./agent/context";
import { createAgent } from "./agent/create";
import { handleListMessages } from "./agent/list-messages-handler";
import { getStreamToolContextId, sendMessageStream } from "./agent/message";
import { getModelUpdateArgs, resolveModel } from "./agent/model";
import { updateAgentSystemPrompt } from "./agent/modify";
import { buildCreateAgentOptionsForPersonality } from "./agent/personality";
import { resolvePersonalityId } from "./agent/personality-presets";
import {
  INTERRUPT_RECOVERY_ALERT,
  type MemoryPromptMode,
} from "./agent/prompt-assets";
import { prepareResumedAgentModel } from "./agent/resumed-agent-model";
import { resolveSkillSourcesSelection } from "./agent/skill-sources";
import type { SkillSource } from "./agent/skills";
import { SessionStats } from "./agent/stats";
import {
  type BackendMode,
  type ConversationCreateBody,
  getBackend,
} from "./backend";
import type { ParsedCliArgs } from "./cli/args";
import {
  normalizeConversationShorthandFlags,
  parseCsvListFlag,
  parsePositiveIntFlag,
} from "./cli/flag-utils";
import {
  createBuffers,
  findLastAssistantText,
  type Line,
  markIncompleteToolsAsCancelled,
  toLines,
} from "./cli/helpers/accumulator";
import { classifyApprovals } from "./cli/helpers/approval-classification";
import { createContextTracker } from "./cli/helpers/context-tracker";
import { formatErrorDetails } from "./cli/helpers/error-formatter";
import type {
  ReflectionSettings,
  ReflectionTrigger,
} from "./cli/helpers/memory-reminder";
import { maybeLaunchPostTurnReflection } from "./cli/helpers/post-turn-reflection";
import {
  AUTO_REFLECTION_DESCRIPTION,
  launchReflectionSubagent,
} from "./cli/helpers/reflection-launcher";
import { appendTranscriptDeltaJsonl } from "./cli/helpers/reflection-transcript";
import {
  type DrainStreamHook,
  drainStreamWithResume,
} from "./cli/helpers/stream";
import { installLocalBackendModEventHooks } from "./cli/mods/local-backend-mod-events";
import {
  validateConversationDefaultRequiresAgent,
  validatePrimaryStartupFlagConflicts,
} from "./cli/startup-flag-validation";
import {
  applyStartupReflectionOverrides,
  parseReflectionOverrides,
} from "./cli/startup-reflection-settings";
import { tryCloudHeadlessSend } from "./headless-cloud-send";
import {
  buildEnvironmentLaunchResult,
  type ListenerLaunchResult,
  type ReplyEnvironmentMetadata,
  resolveListenerLaunchTarget,
  takeSubagentCloudOptions,
} from "./headless-environment-response";
import {
  clearHeadlessClientToolRules,
  createHeadlessEphemeralConversation,
  initHeadlessSecrets,
  prepareHeadlessEphemeralBackend,
  resolveAmbientAgentId,
  retrieveHeadlessConversation,
} from "./headless-ephemeral-startup";
import {
  importInitState,
  importInitVerify,
  importInitWaitForWorkflows,
} from "./headless-import-init";
import { launchListenerConversation } from "./headless-listener-launch";
import { resolveHeadlessMemfsPolicy } from "./headless-memfs-policy";
import {
  createHeadlessModAdapter,
  createHeadlessModContext,
  emitHeadlessConversationClose,
  emitHeadlessConversationOpen,
} from "./headless-mod-adapter";
import {
  type HeadlessPermissionResult,
  waitForHeadlessPermissionResponse,
} from "./headless-permission";
import {
  emitLocalToolCalls,
  emitLocalToolReturns,
} from "./headless-tool-events";
import { computeDiffPreviews } from "./helpers/diff-preview";
import { closeClientMcpServers } from "./mcp-runtime";
import { disableModsForProcess, shouldDisableMods } from "./mods/disable";
import type { ModAdapter } from "./mods/mod-adapter";
import { getTurnStartCancel } from "./mods/turn-start-cancel";
import type { ModContext, ModConversationOpenReason } from "./mods/types";
import { formatPermissionDenial } from "./permissions/format-denial";
import { applyStartupPermissionMode } from "./permissions/startup";
import { QueueRuntime } from "./queue/queue-runtime";
import {
  mergeQueuedTurnInput,
  type QueuedTurnInput,
} from "./queue/turn-queue-runtime";
import {
  buildSharedReminderParts,
  prependReminderPartsToContent,
} from "./reminders/engine";
import { runPostTurnMemorySync } from "./reminders/memory-git-sync";
import { createSharedReminderState } from "./reminders/state";
import { getCurrentWorkingDirectory } from "./runtime-context";
import { subagentExecutionSettings } from "./runtime-execution-settings";
import { settingsManager, shouldPersistSessionState } from "./settings-manager";
import { writeWireMessage, writeWireMessageAsync } from "./stream-json-writer";
import { shutdownBackgroundMemoryTasks } from "./tools/impl/memory-task-lifecycle";
import { shutdownMonitors } from "./tools/impl/monitor";
import {
  type ExternalToolDefinition,
  registerExternalTools,
  setExternalToolExecutor,
} from "./tools/manager";
import { prepareToolExecutionContextForScope } from "./tools/toolset";
import type {
  BootstrapSessionStateRequest,
  CanUseToolControlRequest,
  ControlRequest,
  ControlResponse,
  ErrorMessage,
  ListMessagesControlRequest,
  MessageWire,
  QueueLifecycleEvent,
  RecoverPendingApprovalsControlRequest,
  RecoveryMessage,
  ResultMessage,
  RetryMessage,
  StreamEvent,
  SystemInitMessage,
} from "./types/protocol";
import { debugLog, debugWarn, isDebugEnabled } from "./utils/debug";
import { getErrorMessage } from "./utils/error";
import {
  markMilestone,
  measureSinceMilestone,
  reportAllMilestones,
} from "./utils/timing";

const LLM_API_ERROR_MAX_RETRIES = 3;

const EMPTY_RESPONSE_MAX_RETRIES = 2;

const HEADLESS_STREAM_RESUME_POLICY = {
  initialDelayMs: 250,
  maxAttempts: 20,
  maxDelayMs: 2_000,
};

const CONVERSATION_BUSY_MAX_RETRIES = 3;
function trackHeadlessBoundaryError(
  errorType: string,
  error: unknown,
  context: string,
): void {
  trackBoundaryError({
    errorType,
    error,
    context,
  });
}

function reportAndExitHeadless(
  errorType: string,
  error: unknown,
  context: string,
): never {
  trackHeadlessBoundaryError(errorType, error, context);
  console.error(
    error instanceof Error ? `Error: ${error.message}` : String(error),
  );
  process.exit(1);
}

async function reportStartupErrorAndExit(
  errorType: string,
  error: unknown,
  context: string,
  outputFormat: string,
): Promise<never> {
  trackHeadlessBoundaryError(errorType, error, context);
  const message = error instanceof Error ? error.message : String(error);

  if (outputFormat === "stream-json") {
    const errorMsg: ErrorMessage = {
      type: "error",
      message,
      stop_reason: "error",
      session_id: "startup",
      uuid: `startup-error-${randomUUID()}`,
    };
    await writeWireMessageAsync(errorMsg);
  } else {
    console.error(`Error: ${message}`);
  }

  return await flushAndExit(1);
}

export type BidirectionalQueuedInput = QueuedTurnInput<
  MessageCreate["content"]
>;

export function mergeBidirectionalQueuedInput(
  queued: BidirectionalQueuedInput[],
): MessageCreate["content"] | null {
  return mergeQueuedTurnInput(queued, {
    normalizeUserContent: (content) => content,
  });
}

function trackTelemetryUserInputFromContent(
  content: MessageCreate["content"],
  modelId: string,
): void {
  const inputText = extractTelemetryInputText(content);
  if (inputText.length === 0) {
    return;
  }
  telemetry.trackUserInput(inputText, "user", modelId);
}

function shouldTrackTelemetryForQueuedMessage(
  queuedKind?: QueuedMessage["kind"],
): boolean {
  return queuedKind !== "task_notification";
}

function contentToTaskNotificationText(
  content: MessageCreate["content"],
): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
}

function toBidirectionalQueuedInput(
  content: MessageCreate["content"],
  queuedKind?: QueuedMessage["kind"],
): BidirectionalQueuedInput {
  if (queuedKind === "task_notification") {
    return {
      kind: "task_notification",
      text: contentToTaskNotificationText(content),
      content,
    };
  }

  return {
    kind: "user",
    content,
  };
}

export type InterruptAction = "abort-active" | "latch" | "noop";

export function decideInterruptAction(state: {
  hasActiveController: boolean;
  turnStarting: boolean;
}): InterruptAction {
  if (state.hasActiveController) return "abort-active";
  if (state.turnStarting) return "latch";
  return "noop";
}

export const __headlessTestUtils = {
  trackTelemetryUserInputFromContent,
  shouldTrackTelemetryForQueuedMessage,
  contentToTaskNotificationText,
  toBidirectionalQueuedInput,
  prepareHeadlessToolExecutionContext,
};

async function prepareHeadlessToolExecutionContext(params: {
  agentId: string;
  conversationId: string;
  overrideModel?: string | null;
  cachedAgent?: AgentState | null;
  modContext?: ModContext;
  modEvents?: ModAdapter["events"];
}): Promise<{
  preparedToolContext: Awaited<
    ReturnType<typeof prepareToolExecutionContextForScope>
  >;
  availableTools: string[];
}> {
  const preparedToolContext = await prepareToolExecutionContextForScope({
    agentId: params.agentId,
    conversationId: params.conversationId,
    overrideModel: params.overrideModel,
    workingDirectory: getCurrentWorkingDirectory(),
    cachedAgent: params.cachedAgent,
    modContext: params.modContext,
    modEvents: params.modEvents,
  });

  return {
    preparedToolContext,
    availableTools: preparedToolContext.preparedToolContext.clientTools.map(
      (tool) => tool.name,
    ),
  };
}

function isTurnInputArray(
  value: unknown,
): value is Array<MessageCreate | ApprovalCreate> {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

type HeadlessTurnStartEmission =
  | { cancelled: false; input: Array<MessageCreate | ApprovalCreate> }
  | { cancelled: true; reason: string };

async function emitHeadlessTurnStartCancellationOutput(options: {
  agent: AgentState;
  conversationId: string;
  outputFormat: string;
  reason: string;
  sessionId: string;
}): Promise<void> {
  if (options.outputFormat === "stream-json") {
    const errorMsg: ErrorMessage = {
      type: "error",
      message: options.reason,
      stop_reason: "cancelled",
      session_id: options.sessionId,
      uuid: `error-turn-start-cancel-${randomUUID()}`,
    };
    await writeWireMessageAsync(errorMsg);
    const resultMsg: ResultMessage = {
      type: "result",
      subtype: "error",
      session_id: options.sessionId,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      result: options.reason,
      agent_id: options.agent.id,
      conversation_id: options.conversationId,
      run_ids: [],
      usage: null,
      uuid: `result-turn-start-cancel-${randomUUID()}`,
      stop_reason: "cancelled",
    };
    await writeWireMessageAsync(resultMsg);
  } else if (options.outputFormat === "json") {
    await writeFinalHeadlessStdout(
      `${JSON.stringify(
        {
          type: "result",
          subtype: "error",
          is_error: true,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 0,
          result: options.reason,
          agent_id: options.agent.id,
          conversation_id: options.conversationId,
          usage: null,
          stop_reason: "cancelled",
        },
        null,
        2,
      )}\n`,
    );
  } else {
    console.error(`Error: ${options.reason}`);
  }
}

function writeBidirectionalTurnStartCancellation(options: {
  agent: AgentState;
  conversationId: string;
  reason: string;
  sessionId: string;
}): void {
  const errorMsg: ErrorMessage = {
    type: "error",
    message: options.reason,
    stop_reason: "cancelled",
    session_id: options.sessionId,
    uuid: `error-turn-start-cancel-${randomUUID()}`,
  };
  writeWireMessage(errorMsg);

  const resultMsg: ResultMessage = {
    type: "result",
    subtype: "error",
    session_id: options.sessionId,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    result: options.reason,
    agent_id: options.agent.id,
    conversation_id: options.conversationId,
    run_ids: [],
    usage: null,
    uuid: `result-turn-start-cancel-${randomUUID()}`,
    stop_reason: "cancelled",
  };
  writeWireMessage(resultMsg);
}

async function emitHeadlessTurnStart(options: {
  agent: AgentState;
  conversationId: string;
  input: Array<MessageCreate | ApprovalCreate>;
  adapter: ModAdapter;
  context: ModContext;
}): Promise<HeadlessTurnStartEmission> {
  try {
    const event = {
      agentId: options.agent.id,
      conversationId: options.conversationId,
      input: options.input,
    };
    await options.adapter.events.emit("turn_start", event, options.context);
    const cancel = getTurnStartCancel(event);
    if (cancel) return { cancelled: true, reason: cancel.reason };
    return {
      cancelled: false,
      input: isTurnInputArray(event.input) ? event.input : options.input,
    };
  } catch {
    return { cancelled: false, input: options.input };
  }
}

async function emitHeadlessTurnEnd(options: {
  agent: AgentState;
  conversationId: string;
  stopReason: string;
  assistantMessage?: string;
  adapter: ModAdapter;
  context: ModContext;
}): Promise<string | undefined> {
  try {
    const event: {
      agentId: string | null;
      conversationId: string | null;
      stopReason: string;
      assistantMessage?: string;
      continue?: string;
    } = {
      agentId: options.agent.id,
      conversationId: options.conversationId,
      stopReason: options.stopReason,
      assistantMessage: options.assistantMessage,
    };
    await options.adapter.events.emit("turn_end", event, options.context);
    return typeof event.continue === "string" ? event.continue : undefined;
  } catch {
    return undefined;
  }
}

async function sendScopedApprovalMessages(params: {
  agentId: string;
  conversationId: string;
  approvalMessages: Array<MessageCreate | ApprovalCreate>;
  modContext?: ModContext;
  modEvents?: ModAdapter["events"];
}): Promise<Awaited<ReturnType<typeof sendMessageStream>>> {
  const approvalToolContext = await prepareHeadlessToolExecutionContext({
    agentId: params.agentId,
    conversationId: params.conversationId,
    modContext: params.modContext,
    modEvents: params.modEvents,
  });

  return await sendMessageStream(
    params.conversationId,
    params.approvalMessages,
    {
      agentId: params.agentId,
      preparedToolContext:
        approvalToolContext.preparedToolContext.preparedToolContext,
    },
  );
}

async function flushAndExit(code: number): Promise<never> {
  await shutdownMonitors();
  const flushWritable = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolve) => {
      if (stream.destroyed || stream.writableEnded) return resolve();
      stream.write("", () => resolve());
    });

  await closeClientMcpServers();
  const flushed = Promise.allSettled([
    flushWritable(process.stdout),
    flushWritable(process.stderr),
  ]);
  if (code === 143) await waitForTerminationOutput(flushed);
  else await flushed;

  process.exit(code);
}

async function writeFinalHeadlessStdout(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    if (process.stdout.destroyed || process.stdout.writableEnded) {
      resolve();
      return;
    }
    process.stdout.write(text, () => resolve());
  });
}

export async function handleHeadlessCommand(
  parsedArgs: ParsedCliArgs,
  model?: string,
  skillsDirectoryOverride?: string,
  skillSourcesOverride?: SkillSource[],
  systemInfoReminderEnabledOverride?: boolean,
  startupOptions: { requestedBackendMode?: BackendMode } = {},
) {
  const { values, positionals } = parsedArgs;
  const isAgentLaunch = consumeSubagentLaunch(process.env);
  const senderReminder = buildHeadlessSenderReminder(
    isAgentLaunch,
    values["from-agent"],
  );
  const launchProfile = isAgentLaunch
    ? process.env[SUBAGENT_LAUNCH_PROFILE_ENV]
    : undefined;
  delete process.env[SUBAGENT_LAUNCH_PROFILE_ENV];
  telemetry.setSurface(getTerminalTelemetrySurface(true));
  const modsDisabled = shouldDisableMods({
    cliFlag: values["no-mods"],
  });
  if (modsDisabled) {
    disableModsForProcess();
  }

  if (values.tools !== undefined) {
    const { toolFilter } = await import("@/tools/filter");
    toolFilter.setEnabledTools(values.tools);
  }

  const { cliPermissions } = await import(
    "@/permissions/cli-permissions-instance"
  );
  cliPermissions.setMemoryGuardDisabled(false);

  const permissionModeValue =
    typeof values["permission-mode"] === "string"
      ? values["permission-mode"]
      : undefined;
  const yoloMode = values.yolo;
  const startupPermissionMode = await applyStartupPermissionMode({
    permissionModeValue,
    yoloMode,
  });
  if (!startupPermissionMode.ok) {
    console.error(startupPermissionMode.message);
    process.exit(1);
  }

  if (
    values.allowedTools ||
    values.disallowedTools ||
    values["disable-memory-guard"]
  ) {
    if (values.allowedTools) {
      cliPermissions.setAllowedTools(values.allowedTools);
    }
    if (values.disallowedTools) {
      cliPermissions.setDisallowedTools(values.disallowedTools);
    }
    if (values["disable-memory-guard"]) {
      cliPermissions.setMemoryGuardDisabled(true);
    }
  }

  const inputFormat = values["input-format"];
  const isBidirectionalMode = inputFormat === "stream-json";

  installHeadlessStdoutGuard();

  let prompt = positionals.slice(2).join(" ");

  if (!prompt && !isBidirectionalMode) {
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      prompt = Buffer.concat(chunks).toString("utf-8").trim();
    }
  }

  if (!prompt && !isBidirectionalMode) {
    trackHeadlessBoundaryError(
      "headless_missing_prompt",
      "No prompt provided",
      "headless_startup_input_validation",
    );
    console.error("Error: No prompt provided");
    process.exit(1);
  }
  const devBackend = values["dev-backend"];
  if (typeof devBackend === "string" && devBackend.length > 0) {
    const { configureDevBackend } = await import("@/backend");
    await configureDevBackend(devBackend);
  }
  prepareHeadlessEphemeralBackend(Boolean(values.ephemeral));
  const backend = getBackend();
  markMilestone("HEADLESS_CLIENT_READY");
  const sendExitCode = await tryCloudHeadlessSend(
    values,
    prompt,
    backend,
    isAgentLaunch,
    {
      writeStdout: writeFinalHeadlessStdout,
    },
  );
  if (sendExitCode !== undefined) return flushAndExit(sendExitCode);
  if (values.resume) {
    trackHeadlessBoundaryError(
      "headless_invalid_resume_flag",
      "--resume is for interactive mode only in headless mode",
      "headless_startup_flag_validation",
    );
    console.error(
      "Error: --resume is for interactive mode only (opens conversation selector).\n" +
        "In headless mode, use:\n" +
        "  --conversation <id>  Resume a specific conversation by ID",
    );
    process.exit(1);
  }

  let forceNewConversation = values.new ?? false;
  const fromAgentId = values["from-agent"];
  const explicitEnvironmentSelector =
    values.computer ?? values.environment ?? values.env;
  const inheritedListenerConnectionId = process.env[LISTENER_CONNECTION_ENV];
  const usesRemoteEnvironment = shouldLaunchThroughListener({
    launchProfile,
    cloudBackend: backend.capabilities.environmentRouting,
    connectionId: inheritedListenerConnectionId,
    computer: explicitEnvironmentSelector,
    ephemeral: values.ephemeral,
  });
  if (values["client-message-id"] !== undefined && !usesRemoteEnvironment)
    throw new Error("--client-message-id requires a Cloud input destination");
  const startupBackend = createStartupBackend(backend, usesRemoteEnvironment);

  let agent: AgentState | null = null;
  let ephemeralConversationId: string | null = null;
  let autoEnableMemfsForFreshAgent = false;
  const startupBackendMode = backend.capabilities.localModelCatalog
    ? "local"
    : "api";
  let specifiedAgentId = values.agent;
  const specifiedAgentName = values.name;
  let specifiedConversationId = values.conversation;
  let specifiedAgentIdFromAmbient = false;
  const forceNew = values["new-agent"];
  const ephemeralFlag = values.ephemeral;
  let isDetached = Boolean(ephemeralFlag);
  let parentAgentId: string | null = null;
  const systemPromptPreset = values.system;
  const systemCustom = values["system-custom"];
  const personalityInput = values.personality;
  const embeddingModel = values.embedding;
  const baseToolsRaw = values["base-tools"];
  const skillsDirectory = values.skills ?? skillsDirectoryOverride;
  const noSkillsFlag = values["no-skills"];
  const noBundledSkillsFlag = values["no-bundled-skills"];
  const skillSourcesRaw = values["skill-sources"];
  const memfsFlag = values.memfs;
  const statelessFlag = values.stateless;
  const isSubagent = process.env.LETTA_CODE_AGENT_ROLE === "subagent";
  const memfsPolicyFor = (agentTags?: string[] | null) =>
    resolveHeadlessMemfsPolicy({
      statelessRequested: Boolean(statelessFlag),
      isSubagentRole: isSubagent,
      newAgentRequested: Boolean(forceNew),
      agentTags,
    });
  const memfsPolicy = memfsPolicyFor();
  let isStatelessSession =
    Boolean(ephemeralFlag) || memfsPolicy.isStatelessSession;
  if (isStatelessSession && backend.capabilities.localMemfs)
    disableLocalBackendMemfsForProcess();
  const memfsStartupRaw = values["memfs-startup"];
  const memfsStartupPolicy: "blocking" | "background" | "skip" =
    memfsStartupRaw === "background" || memfsStartupRaw === "skip"
      ? memfsStartupRaw
      : "blocking";
  const requestedMemoryPromptMode: "memfs" | undefined = memfsFlag
    ? "memfs"
    : undefined;
  if (memfsFlag && !backend.capabilities.remoteMemfs) {
    trackHeadlessBoundaryError(
      "headless_memfs_unsupported_backend",
      "MemFS requires a backend with remote MemFS support",
      "headless_startup_memfs_flags",
    );
    console.error("Error: --memfs is not supported by this backend yet");
    process.exit(1);
  }
  const shouldAutoEnableMemfsForNewAgent = !memfsFlag && !isStatelessSession;
  const preLoadSkillsRaw = values["pre-load-skills"];
  const systemInfoReminderEnabled =
    systemInfoReminderEnabledOverride ?? !values["no-system-info-reminder"];
  const reflectionOverrides = (() => {
    try {
      return parseReflectionOverrides(values);
    } catch (error) {
      return reportAndExitHeadless(
        "headless_reflection_overrides_failed",
        error,
        "headless_startup_reflection_overrides",
      );
    }
  })();
  const maxTurnsRaw = values["max-turns"];
  const tagsRaw = values.tags;
  const resolvedSkillSources = (() => {
    if (skillSourcesOverride) {
      return skillSourcesOverride;
    }
    try {
      return resolveSkillSourcesSelection({
        skillSourcesRaw,
        noSkills: noSkillsFlag,
        noBundledSkills: noBundledSkillsFlag,
      });
    } catch (error) {
      return reportAndExitHeadless(
        "headless_skill_sources_failed",
        error,
        "headless_startup_skill_sources",
      );
    }
  })();

  const tags = parseCsvListFlag(tagsRaw);

  let maxTurns: number | undefined;
  try {
    maxTurns = parsePositiveIntFlag({
      rawValue: maxTurnsRaw,
      flagName: "max-turns",
    });
  } catch (error) {
    trackHeadlessBoundaryError(
      "headless_max_turns_parse_failed",
      error,
      "headless_startup_max_turns",
    );
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  try {
    const normalized = normalizeConversationShorthandFlags({
      specifiedConversationId,
      specifiedAgentId,
    });
    specifiedConversationId = normalized.specifiedConversationId ?? undefined;
    specifiedAgentId = normalized.specifiedAgentId ?? undefined;
  } catch (error) {
    return reportAndExitHeadless(
      "headless_conversation_shorthand_failed",
      error,
      "headless_startup_conversation_shorthand",
    );
  }

  const ambientAgentId = resolveAmbientAgentId({
    routed: startupOptions.requestedBackendMode || usesRemoteEnvironment,
    ephemeral: ephemeralFlag,
    explicitTarget:
      specifiedAgentId ||
      specifiedAgentName ||
      specifiedConversationId ||
      forceNew ||
      fromAgentId,
  });
  if (ambientAgentId) {
    specifiedAgentId = ambientAgentId;
    specifiedAgentIdFromAmbient = true;
  }

  try {
    validateConversationDefaultRequiresAgent({
      specifiedConversationId,
      specifiedAgentId,
      forceNew,
    });
  } catch (error) {
    trackHeadlessBoundaryError(
      "headless_conversation_flag_validation_failed",
      error,
      "headless_startup_conversation_flag_validation",
    );
    console.error(
      error instanceof Error ? `Error: ${error.message}` : String(error),
    );
    console.error("Usage: letta --agent agent-xyz --conv default");
    console.error("   or: letta --conv agent-xyz (shorthand)");
    process.exit(1);
  }

  if (fromAgentId) {
    if (!specifiedAgentId && !specifiedConversationId) {
      console.error(
        "Error: --from-agent requires --agent <id> or --conversation <id>.",
      );
      process.exit(1);
    }
    if (forceNew) {
      console.error("Error: --from-agent cannot be used with --new-agent");
      process.exit(1);
    }
    if (!specifiedConversationId && !forceNewConversation) {
      forceNewConversation = true;
    }
  }

  try {
    validatePrimaryStartupFlagConflicts({
      specifiedConversationId,
      specifiedAgentId,
      specifiedAgentName,
      forceNewAgent: forceNew,
      forceNewConversation,
      stateless: statelessFlag,
      ephemeral: ephemeralFlag,
      isHeadless: true,
      memfs: memfsFlag,
      memfsStartup: values["memfs-startup"],
    });
  } catch (error) {
    return reportAndExitHeadless(
      "headless_flag_conflict_validation_failed",
      error,
      "headless_startup_flag_conflicts",
    );
  }

  if (ephemeralFlag && (isBidirectionalMode || usesRemoteEnvironment)) {
    return reportAndExitHeadless(
      "headless_ephemeral_transport_unsupported",
      "--ephemeral supports direct one-shot headless prompts only",
      "headless_startup_flag_conflicts",
    );
  }

  if (specifiedAgentName) {
    if (specifiedAgentId) {
      console.error("Error: --name cannot be used with --agent");
      process.exit(1);
    }
    if (forceNew) {
      console.error("Error: --name cannot be used with --new-agent");
      process.exit(1);
    }
  }

  if (baseToolsRaw && !forceNew) {
    console.error(
      "Error: --base-tools can only be used together with --new to control initial base tools.",
    );
    process.exit(1);
  }

  const baseTools = parseCsvListFlag(baseToolsRaw);

  const personality = personalityInput
    ? resolvePersonalityId(personalityInput)
    : null;
  if (personalityInput && !personality) {
    console.error(
      `Error: Unknown personality "${personalityInput}". Valid: letta-code, tutorial, blank, linus, kawaii, claude, codex`,
    );
    process.exit(1);
  }
  if (personalityInput && !forceNew) {
    console.error("Error: --personality can only be used with --new-agent");
    process.exit(1);
  }

  if (systemPromptPreset && systemCustom) {
    console.error(
      "Error: --system and --system-custom are mutually exclusive. Use one or the other.",
    );
    process.exit(1);
  }

  if (specifiedConversationId && specifiedConversationId !== "default") {
    try {
      debugLog(
        "conversations",
        `retrieve(${specifiedConversationId}) [headless conv→agent lookup]`,
      );
      ({
        agent,
        detached: isDetached,
        parentAgentId,
      } = await retrieveHeadlessConversation(
        startupBackend,
        specifiedConversationId,
      ));
    } catch (error) {
      trackHeadlessBoundaryError(
        "headless_conversation_lookup_failed",
        error,
        "headless_startup_conversation_lookup",
      );
      console.error(`Conversation ${specifiedConversationId} not found`);
      process.exit(1);
    }
  }

  if (!agent && specifiedAgentId) {
    try {
      agent = await startupBackend.retrieveAgent(specifiedAgentId, {
        include: ["agent.tools", "agent.tags"],
      });
    } catch (_error) {
      if (specifiedAgentIdFromAmbient) {
        const ambientMissMessage = startupOptions.requestedBackendMode
          ? `Active agent ${specifiedAgentId} is not available on the ${startupOptions.requestedBackendMode} backend.`
          : `Active agent ${specifiedAgentId} (inferred from the AGENT_ID environment variable) was not found.`;
        console.error(ambientMissMessage);
        if (startupOptions.requestedBackendMode === "local") {
          console.error(
            "--backend local uses the local backend store and will not silently switch to a different cwd-local agent.\n" +
              "Use --new-agent to create a local agent, or pass --agent <local-agent-id> to choose one explicitly.",
          );
        } else {
          console.error(
            "Pass --agent <id>, --conversation <id>, or --new-agent to choose the target explicitly.",
          );
        }
        process.exit(1);
      }
      console.error(`Agent ${specifiedAgentId} not found`);
      process.exit(1);
    }
  }

  if (usesRemoteEnvironment && !backend.capabilities.environmentRouting)
    throw new Error("Computer routing requires the Cloud backend");

  if (!agent && ephemeralFlag) {
    try {
      const result = await createHeadlessEphemeralConversation({
        backendMode: startupBackendMode,
        personality: personalityInput,
        model,
        systemPromptPreset,
        systemPromptCustom: systemCustom,
      });
      ({ agent, parentAgentId } = result);
      ephemeralConversationId = result.conversationId;
    } catch (error) {
      await reportStartupErrorAndExit(
        "headless_ephemeral_conversation_create_failed",
        error,
        "headless_startup_agent_create",
        values["output-format"] || "text",
      );
      throw error;
    }
  }

  if (!agent && forceNew) {
    const { isLettaCloud } = await import("@/agent/memory-filesystem");
    const willAutoEnableMemfs =
      backend.capabilities.remoteMemfs &&
      shouldAutoEnableMemfsForNewAgent &&
      (await isLettaCloud());
    const effectiveMemoryMode: MemoryPromptMode | undefined = backend
      .capabilities.localMemfs
      ? memfsPolicy.isFreshStatelessSubagent
        ? "standard"
        : "local-memfs"
      : (requestedMemoryPromptMode ??
        (willAutoEnableMemfs ? "memfs" : undefined));

    const personalityOptions = personality
      ? await buildCreateAgentOptionsForPersonality({
          personalityId: personality,
          model,
          tags,
        })
      : undefined;
    const modelForUpdateArgs = personalityOptions?.model ?? model;
    const updateArgs = getModelUpdateArgs(modelForUpdateArgs);
    const createOptions = {
      ...(personalityOptions ?? {}),
      model: modelForUpdateArgs,
      embeddingModel,
      updateArgs,
      skillsDirectory,
      parallelToolCalls: true,
      systemPromptPreset,
      systemPromptCustom: systemCustom,
      memoryPromptMode: effectiveMemoryMode,
      baseTools,
      memoryBlocks: personalityOptions?.memoryBlocks,
      tags: personalityOptions?.tags ?? tags,
    };
    let result: Awaited<ReturnType<typeof createAgent>>;
    try {
      result = await createAgent(createOptions);
    } catch (error) {
      await reportStartupErrorAndExit(
        "headless_agent_create_failed",
        error,
        "headless_startup_agent_create",
        values["output-format"] || "text",
      );
      throw error;
    }
    agent = result.agent;
    autoEnableMemfsForFreshAgent = willAutoEnableMemfs;
  }

  if (!agent && startupBackendMode === "local") {
    await settingsManager.loadLocalProjectSettings();
    const localAgentId = settingsManager.getLocalLastAgentId(
      getCurrentWorkingDirectory(),
    );
    if (
      localAgentId &&
      process.env.AGENT_ID &&
      process.env.AGENT_ID !== localAgentId
    ) {
      console.error(
        `Using local backend agent ${localAgentId} from project-local settings (.letta/settings.local.json). \n` +
          `Current session AGENT_ID=${process.env.AGENT_ID}; ` +
          `--backend local switches to a separate persisted local agent.\n`,
      );
    }
    if (
      localAgentId &&
      isAgentIdCompatibleWithBackend(localAgentId, startupBackendMode)
    ) {
      try {
        agent = await backend.retrieveAgent(localAgentId, {
          include: ["agent.tags"],
        });
      } catch (_error) {
        console.error(`Unable to locate agent ${localAgentId} in .letta/`);
      }
    }
  }

  if (!agent && startupBackendMode === "api") {
    const globalAgentId = settingsManager.getGlobalLastAgentId();
    if (
      globalAgentId &&
      isAgentIdCompatibleWithBackend(globalAgentId, startupBackendMode)
    ) {
      try {
        agent = await backend.retrieveAgent(globalAgentId, {
          include: ["agent.tags"],
        });
      } catch (_error) {}
    }
  }

  if (!agent) {
    const { ensureDefaultAgents } = await import("@/agent/defaults");
    const defaultAgent = await ensureDefaultAgents(backend, {
      preferredModel: model,
    });
    if (defaultAgent) {
      agent = defaultAgent;
    }
  }
  if (!agent) {
    console.error("No agent found. Use --new-agent to create a new agent.");
    process.exit(1);
  }
  markMilestone("HEADLESS_AGENT_RESOLVED");
  const publicAgentId = isDetached ? null : agent.id;
  telemetry.setCurrentAgent(publicAgentId, agent.tags);
  const isResumingAgent = !isDetached && !!(specifiedAgentId || !forceNew);
  let conversationModel: Partial<ConversationCreateBody> | undefined;

  if (isResumingAgent) {
    const modelHandle = model ? resolveModel(model) : undefined;
    if (model && typeof modelHandle !== "string") {
      console.error(`Error: Invalid model "${model}"`);
      process.exit(1);
    }
    const prepared = await prepareResumedAgentModel({
      agent,
      modelIdentifier: model,
      modelHandle: modelHandle ?? undefined,
      createsConversation:
        !specifiedConversationId &&
        (forceNewConversation ||
          process.env.LETTA_CODE_AGENT_ROLE !== "subagent"),
      localModelCatalog: backend.capabilities.localModelCatalog,
    });
    agent = prepared.agent;
    conversationModel = prepared.conversationModel;
  }

  let conversationId: string;
  let conversationOpenReason: ModConversationOpenReason = "startup";
  let effectiveReflectionSettings: ReflectionSettings;

  isStatelessSession ||= memfsPolicyFor(agent.tags).isStatelessSession;
  if (isStatelessSession && backend.capabilities.localMemfs)
    disableLocalBackendMemfsForProcess();
  let startupMemfsFlag: boolean | undefined = autoEnableMemfsForFreshAgent
    ? true
    : memfsFlag;

  if (
    !isStatelessSession &&
    !isDetached &&
    backend.capabilities.remoteMemfs &&
    !autoEnableMemfsForFreshAgent
  ) {
    const { hydrateMemfsSettingFromAgent, isLettaCloud } = await import(
      "@/agent/memory-filesystem"
    );
    const memfsEnabled = await hydrateMemfsSettingFromAgent(agent);
    if (!memfsEnabled && (await isLettaCloud())) {
      startupMemfsFlag = true;
    }
  }

  let memfsBgPromise: Promise<unknown> | undefined;

  const secretsReady = initHeadlessSecrets(agent.id, isDetached, parentAgentId);

  if (isStatelessSession || isDetached) {
    settingsManager.setMemfsEnabled(agent.id, false);
  } else if (!backend.capabilities.remoteMemfs) {
    if (backend.capabilities.localMemfs) {
      settingsManager.setMemfsEnabled(agent.id, true);
    }
  } else if (memfsStartupPolicy === "skip") {
    try {
      const { applyMemfsFlags } = await import("@/agent/memory-filesystem");
      await applyMemfsFlags(agent.id, startupMemfsFlag, {
        pullOnExistingRepo: false,
        agentTags: agent.tags,
        skipPromptUpdate: forceNew,
      });
    } catch (error) {
      trackHeadlessBoundaryError(
        "headless_memfs_flags_failed",
        error,
        "headless_startup_memfs_flags",
      );
      console.error(
        `Memory flags failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  } else if (memfsStartupPolicy === "background") {
    const { applyMemfsFlags } = await import("@/agent/memory-filesystem");
    memfsBgPromise = applyMemfsFlags(agent.id, startupMemfsFlag, {
      pullOnExistingRepo: true,
      agentTags: agent.tags,
      skipPromptUpdate: forceNew,
    }).catch((error) => {
      trackHeadlessBoundaryError(
        "headless_memfs_background_pull_failed",
        error,
        "headless_runtime_memfs_background_pull",
      );
      console.error(
        `[memfs background pull] ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } else {
    try {
      const { applyMemfsFlags } = await import("@/agent/memory-filesystem");
      const memfsResult = await applyMemfsFlags(agent.id, startupMemfsFlag, {
        pullOnExistingRepo: true,
        agentTags: agent.tags,
        skipPromptUpdate: forceNew,
      });
      if (memfsResult.pullSummary?.includes("CONFLICT")) {
        trackHeadlessBoundaryError(
          "headless_memfs_conflict",
          "Memory has merge conflicts. Run in interactive mode to resolve.",
          "headless_startup_memfs_sync",
        );
        console.error(
          "Memory has merge conflicts. Run in interactive mode to resolve.",
        );
        process.exit(1);
      }
    } catch (error) {
      trackHeadlessBoundaryError(
        "headless_memfs_sync_failed",
        error,
        "headless_startup_memfs_sync",
      );
      console.error(
        `Memory git sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  if (memfsBgPromise && isResumingAgent) {
    await memfsBgPromise;
  }

  try {
    await secretsReady;
  } catch (error) {
    import("@/utils/debug").then(({ debugLog }) =>
      debugLog(
        "secrets",
        `Failed to init secrets: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  if (isResumingAgent && systemPromptPreset) {
    const result = await updateAgentSystemPrompt(agent.id, systemPromptPreset);
    if (!result.success || !result.agent) {
      trackHeadlessBoundaryError(
        "headless_system_prompt_update_failed",
        result.message,
        "headless_startup_system_prompt",
      );
      console.error(`Failed to update system prompt: ${result.message}`);
      process.exit(1);
    }
    agent = result.agent;
  }

  if (isResumingAgent && !systemPromptPreset) {
    const {
      ensureLettaCodeOriginTag,
      getMemoryPromptModeForAgent,
      scheduleManagedSystemPromptUpdate,
    } = await import("@/agent/system-prompt-versioning");
    let taggedAgent = agent;
    try {
      taggedAgent = await ensureLettaCodeOriginTag(agent);
    } catch (error) {
      debugWarn(
        "headless startup",
        `Failed to ensure Letta Code origin tag for ${agent.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    scheduleManagedSystemPromptUpdate({
      agent: taggedAgent,
      memoryMode: getMemoryPromptModeForAgent(taggedAgent.id),
    });
  }

  if (!isDetached) {
    clearHeadlessClientToolRules(agent);
  }

  try {
    if (isDetached) {
      effectiveReflectionSettings = { trigger: "off", stepCount: 0 };
    } else {
      const resolvedReflectionSettings = await applyStartupReflectionOverrides(
        agent.id,
        reflectionOverrides,
      );
      effectiveReflectionSettings = isStatelessSession
        ? { ...resolvedReflectionSettings, trigger: "off" }
        : resolvedReflectionSettings;
    }
  } catch (error) {
    console.error(
      `Failed to apply sleeptime settings: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (ephemeralConversationId) {
    conversationId = ephemeralConversationId;
    conversationOpenReason = "new";
  } else if (specifiedConversationId) {
    if (specifiedConversationId === "default") {
      conversationId = "default";
      conversationOpenReason = "resume";
    } else {
      try {
        debugLog(
          "conversations",
          `retrieve(${specifiedConversationId}) [headless --conv validate]`,
        );
        await startupBackend.retrieveConversation(specifiedConversationId);
        conversationId = specifiedConversationId;
        conversationOpenReason = "resume";
      } catch {
        console.error(
          `Error: Conversation ${specifiedConversationId} not found`,
        );
        process.exit(1);
      }
    }
  } else if (forceNewConversation) {
    const createParams: ConversationCreateBody = {
      agent_id: agent.id,
      ...conversationModel,
    };
    if (fromAgentId) {
      (createParams as { hidden?: boolean }).hidden = true;
    }
    const conversation = await startupBackend.createConversation(createParams);
    conversationId = conversation.id;
    conversationOpenReason = "new";
  } else if (isSubagent) {
    conversationId = await createSubagentConversation(
      backend.capabilities.environmentRouting,
      process.env.LETTA_PARENT_CONVERSATION_ID,
      agent.id,
      startupBackend.createConversation,
    );
    conversationOpenReason = "startup";
  } else {
    const conversation = await startupBackend.createConversation({
      agent_id: agent.id,
      ...conversationModel,
    });
    conversationId = conversation.id;
    conversationOpenReason = "new";
  }
  markMilestone("HEADLESS_CONVERSATION_READY");

  setConversationId(conversationId);

  if (!isDetached && shouldPersistSessionState()) {
    await settingsManager.loadLocalProjectSettings();
    settingsManager.persistSession(agent.id, conversationId);
  }

  setAgentContext(
    agent.id,
    skillsDirectory,
    resolvedSkillSources,
    agent.name ?? null,
  );

  const outputFormat = values["output-format"] || "text";
  const includePartialMessages = Boolean(values["include-partial-messages"]);
  if (!["text", "json", "stream-json"].includes(outputFormat)) {
    console.error(
      `Error: Invalid output format "${outputFormat}". Valid formats: text, json, stream-json`,
    );
    process.exit(1);
  }
  if (inputFormat && inputFormat !== "stream-json") {
    console.error(
      `Error: Invalid input format "${inputFormat}". Valid formats: stream-json`,
    );
    process.exit(1);
  }
  if (usesRemoteEnvironment && isBidirectionalMode) {
    console.error(
      "Error: remote computer routing cannot be used with --input-format stream-json",
    );
    process.exit(1);
  }

  const sessionStats = new SessionStats();
  const headlessPermissionMode = startupPermissionMode.mode;
  const headlessModAdapter = createHeadlessModAdapter({
    agent,
    backend,
    conversationId,
    permissionMode: headlessPermissionMode,
    reflectionSettings: effectiveReflectionSettings,
    sessionStats,
    disabled: modsDisabled || usesRemoteEnvironment,
  });
  const initialHeadlessModContext = createHeadlessModContext({
    agent,
    conversationId,
    permissionMode: headlessPermissionMode,
    reflectionSettings: effectiveReflectionSettings,
    sessionStats,
  });
  await headlessModAdapter.reload();
  installLocalBackendModEventHooks({
    backend,
    adapter: headlessModAdapter,
    buildContext: (compactConversationId) =>
      createHeadlessModContext({
        agent,
        conversationId: compactConversationId,
        permissionMode: headlessPermissionMode,
        reflectionSettings: effectiveReflectionSettings,
        sessionStats,
      }),
  });
  try {
    await emitHeadlessConversationOpen({
      agent,
      conversationId,
      reason: conversationOpenReason,
      adapter: headlessModAdapter,
      context: initialHeadlessModContext,
    });
  } catch {}

  let availableTools =
    agent.tools?.map((t) => t.name).filter((n): n is string => !!n) || [];
  let cachedAgent: AgentState | null = null;
  let preparedEffectiveModel: string | null | undefined;
  {
    const initialToolContext = await prepareHeadlessToolExecutionContext({
      agentId: agent.id,
      conversationId,
      cachedAgent: agent as AgentState,
      modContext: initialHeadlessModContext,
      modEvents: headlessModAdapter.events,
    });
    availableTools = initialToolContext.availableTools;
    cachedAgent = initialToolContext.preparedToolContext.agent;
    preparedEffectiveModel =
      initialToolContext.preparedToolContext.effectiveModel;
  }
  const reportModel =
    conversationModel?.model ??
    preparedEffectiveModel ??
    agent.llm_config?.model;

  if (isBidirectionalMode) {
    await runBidirectionalMode(
      agent,
      conversationId,
      reportModel,
      outputFormat,
      includePartialMessages,
      availableTools,
      resolvedSkillSources,
      systemInfoReminderEnabled,
      effectiveReflectionSettings,
      headlessModAdapter,
    );
    return;
  }

  const buffers = createBuffers(agent.id);

  telemetry.setSessionStatsGetter(() => sessionStats.getSnapshot());

  const sessionId = agent.id;
  const importedInit = importInitState(
    process.env.LETTA_IMPORT_INIT_WAIT,
    agent.id,
  );
  let headlessConversationClosed = false;
  let lastKnownRunId: string | null = null;
  const exitHeadless = async (
    code: number,
    exitReason: string,
  ): Promise<never> => {
    try {
      if (!headlessConversationClosed) {
        headlessConversationClosed = true;
        const closeModContext = createHeadlessModContext({
          agent,
          conversationId,
          lastRunId: lastKnownRunId,
          permissionMode: headlessPermissionMode,
          reflectionSettings: effectiveReflectionSettings,
          sessionStats,
        });
        try {
          await emitHeadlessConversationClose({
            agent,
            conversationId,
            durationMs: sessionStats.getSnapshot().totalWallMs,
            adapter: headlessModAdapter,
            context: closeModContext,
          });
        } catch {}
      }
      telemetry.trackSessionEnd(sessionStats.getSnapshot(), exitReason);
      await telemetry.flush();
    } finally {
      headlessModAdapter.dispose();
      await shutdownBackgroundMemoryTasks(code);
      telemetry.setSessionStatsGetter(undefined);
    }
    return await flushAndExit(code);
  };

  if (outputFormat === "stream-json") {
    const initEvent: SystemInitMessage = {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      agent_id: publicAgentId,
      conversation_id: conversationId,
      model: reportModel ?? "",
      tools: availableTools,
      cwd: getCurrentWorkingDirectory(),
      mcp_servers: [],
      permission_mode: "",
      slash_commands: [],
      memfs_enabled: settingsManager.isMemfsEnabled(agent.id),
      skill_sources: resolvedSkillSources,
      system_info_reminder_enabled: systemInfoReminderEnabled,
      reflection_trigger: effectiveReflectionSettings.trigger,
      reflection_step_count: effectiveReflectionSettings.stepCount,
      uuid: `init-${agent.id}`,
    };
    writeWireMessage(initEvent);
  }

  const reminderContextTracker = createContextTracker();
  const sharedReminderState = createSharedReminderState();
  let queuedRecoveredApprovalResults: ApprovalResult[] | null = null;

  const resolveAllPendingApprovals = async (
    mode: "queue_for_next_turn" | "send_immediately" = "send_immediately",
  ) => {
    const { getResumeDataFromBackend } = await import("@/agent/check-approval");
    while (true) {
      const freshAgent = isDetached
        ? agent
        : await backend.retrieveAgent(agent.id);

      let resume: Awaited<ReturnType<typeof getResumeDataFromBackend>>;
      try {
        resume = await getResumeDataFromBackend(freshAgent, conversationId);
      } catch (error) {
        if (
          error instanceof APIError &&
          (error.status === 404 || error.status === 422)
        ) {
          break;
        }
        throw error;
      }

      const pendingApprovals = resume.pendingApprovals || [];
      if (pendingApprovals.length === 0) break;

      const denialResults = buildFreshDenialApprovals(
        pendingApprovals,
        STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      ) as ApprovalResult[];
      if (denialResults.length === 0) {
        break;
      }

      if (mode === "queue_for_next_turn") {
        queuedRecoveredApprovalResults = denialResults;
        break;
      }

      const approvalInput: ApprovalCreate = {
        type: "approval",
        approvals: denialResults,
        otid: randomUUID(),
      };

      const approvalMessages: Array<
        | import("@letta-ai/letta-client/resources/agents/agents").MessageCreate
        | import("@letta-ai/letta-client/resources/agents/messages").ApprovalCreate
      > = [approvalInput];
      {
        const { consumeQueuedSkillContent } = await import(
          "@/tools/impl/skill-content-registry"
        );
        const skillContents = consumeQueuedSkillContent();
        if (skillContents.length > 0) {
          approvalMessages.push({
            role: "user" as const,
            content: skillContents.map((sc) => ({
              type: "text" as const,
              text: sc.content,
            })),
            otid: randomUUID(),
          });
        }
      }

      const approvalStream = await sendScopedApprovalMessages({
        agentId: agent.id,
        conversationId,
        approvalMessages,
        modContext: createHeadlessModContext({
          agent,
          conversationId,
          permissionMode: headlessPermissionMode,
          reflectionSettings: effectiveReflectionSettings,
          sessionStats,
        }),
        modEvents: headlessModAdapter.events,
      });
      const drainResult = await drainStreamWithResume(
        approvalStream,
        createBuffers(agent.id),
        () => {},
        undefined,
        undefined,
        undefined,
        reminderContextTracker,
      );
      if (
        drainResult.stopReason === "error" ||
        drainResult.stopReason === "cancelled"
      ) {
        throw new Error(
          `Approval drain ended with stop reason: ${drainResult.stopReason}`,
        );
      }
    }
  };

  if (
    isResumingAgent ||
    (!usesRemoteEnvironment && isDetached && !ephemeralFlag)
  ) {
    try {
      await resolveAllPendingApprovals("queue_for_next_turn");
    } catch (approvalError) {
      if (outputFormat === "stream-json") {
        const errorMsg: ErrorMessage = {
          type: "error",
          message: `Failed to resolve pending approvals on resume: ${approvalError instanceof Error ? approvalError.message : String(approvalError)}`,
          stop_reason: "error",
          session_id: sessionId,
          uuid: `error-pre-loop-approval-${randomUUID()}`,
        };
        writeWireMessage(errorMsg);
      } else {
        console.error(
          `Warning: Failed to resolve pending approvals on resume: ${approvalError instanceof Error ? approvalError.message : String(approvalError)}`,
        );
      }
    }
  }

  const contentParts: MessageCreate["content"] = [];
  const pushPart = (text: string) => {
    if (!text) return;
    contentParts.push({ type: "text", text });
  };

  pushPart(senderReminder);

  if (!usesRemoteEnvironment) {
    const lastRunAt = (agent as { last_run_completion?: string })
      .last_run_completion;
    const { parts: sharedReminderParts } = await buildSharedReminderParts({
      mode: isSubagent ? "subagent" : "headless-one-shot",
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        lastRunAt: lastRunAt ?? null,
        conversationId,
      },
      state: sharedReminderState,
      systemInfoReminderEnabled,
      workingDirectory: getCurrentWorkingDirectory(),
      skillSources: resolvedSkillSources,
      shellContext: detectShellContext(),
    });
    for (const part of sharedReminderParts) {
      pushPart(part.text);
    }
  }

  if (preLoadSkillsRaw && !usesRemoteEnvironment) {
    const { content } = await loadPreloadedSkills(
      preLoadSkillsRaw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
      {
        agentId: agent.id,
        skillSources: resolvedSkillSources,
        logger: (message) => {
          if (isDebugEnabled()) {
            console.warn(`[DEBUG] ${message}`);
          }
        },
      },
    );
    pushPart(content);
  }
  pushPart(prompt);

  telemetry.trackUserInput(prompt, "user", reportModel ?? "unknown");
  if (usesRemoteEnvironment) {
    const environmentSelector = explicitEnvironmentSelector ?? "";
    const target = await resolveListenerLaunchTarget({
      selector: environmentSelector,
      agentId: publicAgentId ?? parentAgentId,
      conversationId,
      inheritedConnectionId: inheritedListenerConnectionId,
      sandboxOptionsJson: takeSubagentCloudOptions(),
    });
    if ("error" in target)
      return reportStartupErrorAndExit(
        "headless_environment_routing_failed",
        new Error(target.error),
        "headless_environment_routing",
        outputFormat,
      );
    const { connectionId, responseEnvironment } = target;
    const launchParams: Parameters<typeof launchListenerConversation>[0] = {
      noWait: isAgentLaunch || Boolean(values["no-wait"]),
      clientMessageId: values["client-message-id"],
      connectionId,
      parentAgentId: parentAgentId ?? undefined,
      scope: {
        agent_id: publicAgentId,
        conversation_id: conversationId,
        acting_user_id: resolveActingUserId(),
      },
      content: contentParts,
      backend,
      onMessage:
        outputFormat === "stream-json"
          ? (message) => {
              const uuid =
                Reflect.get(message, "otid") ??
                Reflect.get(message, "id") ??
                randomUUID();
              writeWireMessage(
                includePartialMessages
                  ? {
                      type: "stream_event",
                      event: message,
                      session_id: sessionId,
                      uuid,
                    }
                  : { ...message, session_id: sessionId, uuid },
              );
            }
          : undefined,
      cwd: environmentSelector ? undefined : getCurrentWorkingDirectory(),
      mode: headlessPermissionMode,
      skillSources: resolvedSkillSources,
      settings: {
        ...(values.tools !== undefined
          ? {
              tools: values.tools
                .split(",")
                .map((tool) => tool.trim())
                .filter(Boolean),
            }
          : {}),
        allowed_tools: cliPermissions.getAllowedTools(),
        disallowed_tools: cliPermissions.getDisallowedTools(),
        disable_memory_guard: cliPermissions.isMemoryGuardDisabled(),
        max_turns: maxTurns,
        preload_skills: parseCsvListFlag(preLoadSkillsRaw),
        cloud_skill_repositories: target.cloudSkillRepositories,
        ...subagentExecutionSettings(process.env),
        ...(!environmentSelector
          ? {
              transcript_path: process.env.TRANSCRIPT_PATH,
              memory_directory:
                process.env.MEMORY_DIR ?? process.env.LETTA_MEMORY_DIR,
            }
          : {}),
      },
    };
    let launchOutcome:
      | ListenerLaunchResult
      | { status: "error"; error: string };
    try {
      launchOutcome = await launchListenerConversation(launchParams);
    } catch (error) {
      trackHeadlessBoundaryError(
        "headless_environment_launch_failed",
        error,
        "headless_environment_launch",
      );
      launchOutcome = { status: "error", error: getErrorMessage(error) };
    }
    const stats = sessionStats.getSnapshot();
    if (outputFormat === "text" && launchOutcome.status === "error") {
      console.error(`Error: ${launchOutcome.error}`);
    } else if (
      outputFormat === "text" &&
      launchOutcome.status === "completed"
    ) {
      await writeFinalHeadlessStdout(`${launchOutcome.text}\n`);
    } else {
      const result = buildEnvironmentLaunchResult(
        {
          sessionId,
          agentId: publicAgentId,
          internalAgentId: agent.id,
          conversationId,
          environment: responseEnvironment,
          durationMs: Math.round(stats.totalWallMs),
          durationApiMs: Math.round(stats.totalApiMs),
        },
        launchOutcome,
      );
      if (outputFormat === "stream-json") writeWireMessage(result);
      else
        await writeFinalHeadlessStdout(
          `${JSON.stringify(result, null, outputFormat === "json" ? 2 : 0)}\n`,
        );
    }

    return exitHeadless(
      launchOutcome.status === "error" ? 1 : 0,
      launchOutcome.status === "error"
        ? "headless_environment_launch_failed"
        : launchOutcome.status === "queued"
          ? "headless_environment_message_queued"
          : "headless_environment_message_complete",
    );
  }

  const responseState = createHeadlessResponseState();
  let currentInput: Array<MessageCreate | ApprovalCreate> = [
    {
      role: "user",
      content: contentParts,
      otid: randomUUID(),
    },
  ];
  const recoveredApprovalResults: ApprovalResult[] =
    queuedRecoveredApprovalResults ?? [];
  if (recoveredApprovalResults.length > 0) {
    currentInput = [
      {
        type: "approval",
        approvals: recoveredApprovalResults,
        otid: randomUUID(),
      },
      ...currentInput,
    ];
    queuedRecoveredApprovalResults = null;
  }
  const turnStartModContext = createHeadlessModContext({
    agent,
    conversationId,
    permissionMode: headlessPermissionMode,
    reflectionSettings: effectiveReflectionSettings,
    sessionStats,
  });
  const initialTurnStartEmission = await emitHeadlessTurnStart({
    agent,
    conversationId,
    input: currentInput,
    adapter: headlessModAdapter,
    context: turnStartModContext,
  });
  if (initialTurnStartEmission.cancelled) {
    await emitHeadlessTurnStartCancellationOutput({
      agent,
      conversationId,
      outputFormat,
      reason: initialTurnStartEmission.reason,
      sessionId,
    });
    await exitHeadless(1, "headless_turn_start_cancelled");
  } else {
    currentInput = initialTurnStartEmission.input;
  }

  let llmApiErrorRetries = 0;
  let emptyResponseRetries = 0;
  let conversationBusyRetries = 0;
  let busyDeadline: number | null = null;
  let chatgptPlanSwaps = 0;
  const chatgptExhaustedProviders = new Set<string>();
  markMilestone("HEADLESS_FIRST_STREAM_START");
  measureSinceMilestone("headless-setup-total", "HEADLESS_CLIENT_READY");
  const checkMaxTurns = async (): Promise<void> => {
    if (maxTurns !== undefined && buffers.usage.stepCount >= maxTurns) {
      if (outputFormat === "stream-json") {
        const errorMsg: ErrorMessage = {
          type: "error",
          message: `Maximum turns limit reached (${buffers.usage.stepCount}/${maxTurns} steps)`,
          stop_reason: "max_steps",
          session_id: sessionId,
          uuid: `error-max-turns-${randomUUID()}`,
        };
        await writeWireMessageAsync(errorMsg);
      } else {
        console.error(
          `Maximum turns limit reached (${buffers.usage.stepCount}/${maxTurns} steps)`,
        );
      }
      await exitHeadless(1, "headless_max_steps_reached");
    }
  };

  const {
    signal: interruptSignal,
    dispose,
    exitInterrupted,
  } = createHeadlessInterrupt(outputFormat, sessionId, exitHeadless);

  try {
    while (true) {
      if (interruptSignal.aborted) {
        await exitInterrupted();
      }

      const hasApprovalContinuation = currentInput.some(
        (item) => item.type === "approval",
      );

      if (!hasApprovalContinuation) {
        await checkMaxTurns();
      }

      {
        const { consumeQueuedSkillContent } = await import(
          "@/tools/impl/skill-content-registry"
        );
        const skillContents = consumeQueuedSkillContent();
        if (skillContents.length > 0) {
          currentInput = [
            ...currentInput,
            {
              role: "user" as const,
              content: skillContents.map((sc) => ({
                type: "text" as const,
                text: sc.content,
              })),
              otid: randomUUID(),
            },
          ];
        }
      }

      let stream: Awaited<ReturnType<typeof sendMessageStream>>;
      let turnToolContextId: string | null = null;
      try {
        const turnToolContext = await prepareHeadlessToolExecutionContext({
          agentId: agent.id,
          conversationId,
          overrideModel: preparedEffectiveModel,
          cachedAgent,
          modContext: createHeadlessModContext({
            agent,
            conversationId,
            permissionMode: headlessPermissionMode,
            reflectionSettings: effectiveReflectionSettings,
            sessionStats,
          }),
          modEvents: headlessModAdapter.events,
        });
        availableTools = turnToolContext.availableTools;
        stream = await sendMessageStream(
          conversationId,
          currentInput,
          {
            agentId: agent.id,
            allowResponseStateReuse: responseState.consume(currentInput),
            preparedToolContext:
              turnToolContext.preparedToolContext.preparedToolContext,
          },
          { maxRetries: 0, signal: interruptSignal },
        );
        turnToolContextId = getStreamToolContextId(stream);
        busyDeadline = null;
      } catch (preStreamError) {
        if (interruptSignal.aborted) {
          await exitInterrupted();
        }

        const errorDetail = extractConflictDetail(preStreamError);

        const preStreamAction = getPreStreamErrorAction(
          errorDetail,
          conversationBusyRetries,
          CONVERSATION_BUSY_MAX_RETRIES,
          {
            status:
              preStreamError instanceof APIError
                ? preStreamError.status
                : undefined,
            transientRetries: llmApiErrorRetries,
            maxTransientRetries: LLM_API_ERROR_MAX_RETRIES,
          },
        );

        if (preStreamAction === "resolve_approval_pending") {
          if (outputFormat === "stream-json") {
            const recoveryMsg: RecoveryMessage = {
              type: "recovery",
              recovery_type: "approval_pending",
              message:
                "Detected pending approval conflict on send; resolving before retry",
              session_id: sessionId,
              uuid: `recovery-pre-stream-${randomUUID()}`,
            };
            writeWireMessage(recoveryMsg);
          } else {
            console.error(
              "Pending approval detected, resolving before retry...",
            );
          }
          await resolveAllPendingApprovals();
          continue;
        }

        const blockingRunId = extractConversationBusyRunId(errorDetail);
        if (preStreamAction === "retry_conversation_busy" || blockingRunId) {
          const resumeStream = await resumeBusy(
            conversationId,
            agent?.id,
            currentInput,
            interruptSignal,
          );
          if (resumeStream) {
            stream = resumeStream as typeof stream;
            conversationBusyRetries = 0;
            busyDeadline = null;
          } else {
            if (blockingRunId) {
              busyDeadline ??= Date.now() + BUSY_WAIT_MS;
              const settled = await waitForBusyRun(
                blockingRunId,
                interruptSignal,
                busyDeadline,
              );
              if (settled) continue;
            }
            if (preStreamAction !== "retry_conversation_busy") {
              reportBusyRetryExhausted(
                errorDetail,
                conversationBusyRetries,
                CONVERSATION_BUSY_MAX_RETRIES,
              );
              throw preStreamError;
            }
            conversationBusyRetries += 1;
            const retryDelayMs = getRetryDelayMs({
              category: "conversation_busy",
              attempt: conversationBusyRetries,
            });
            if (outputFormat === "stream-json") {
              const retryMsg: RetryMessage = {
                type: "retry",
                reason: "error",
                attempt: conversationBusyRetries,
                max_attempts: CONVERSATION_BUSY_MAX_RETRIES,
                delay_ms: retryDelayMs,
                session_id: sessionId,
                uuid: `retry-conversation-busy-${randomUUID()}`,
              };
              writeWireMessage(retryMsg);
            } else {
              console.error(
                `Conversation is busy, waiting ${Math.round(retryDelayMs / 1000)}s and retrying...`,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }
        }
        if (preStreamAction === "retry_transient") {
          const attempt = llmApiErrorRetries + 1;
          llmApiErrorRetries = attempt;
          const retryAfterMs =
            preStreamError instanceof APIError
              ? parseRetryAfterHeaderMs(
                  preStreamError.headers?.get("retry-after"),
                )
              : null;
          const delayMs = getRetryDelayMs({
            category: "transient_provider",
            attempt,
            detail: errorDetail,
            retryAfterMs,
          });
          if (outputFormat === "stream-json") {
            const retryMsg: RetryMessage = {
              type: "retry",
              reason: "llm_api_error",
              attempt,
              max_attempts: LLM_API_ERROR_MAX_RETRIES,
              delay_ms: delayMs,
              session_id: sessionId,
              uuid: `retry-pre-stream-${randomUUID()}`,
            };
            writeWireMessage(retryMsg);
          } else {
            const delaySeconds = Math.round(delayMs / 1000);
            console.error(
              `Transient API error before streaming (attempt ${attempt} of ${LLM_API_ERROR_MAX_RETRIES}), retrying in ${delaySeconds}s...`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          conversationBusyRetries = 0;
          continue;
        }
        reportBusyRetryExhausted(
          errorDetail,
          conversationBusyRetries,
          CONVERSATION_BUSY_MAX_RETRIES,
        );
        conversationBusyRetries = 0;
        throw preStreamError;
      }
      let approvalPendingRecovery = false;
      let streamJsonHook: DrainStreamHook | undefined;
      if (outputFormat === "stream-json") {
        streamJsonHook = ({ chunk, shouldOutput, errorInfo }) => {
          let shouldOutputChunk = shouldOutput;
          if (errorInfo && shouldOutput) {
            const errorEvent: ErrorMessage = {
              type: "error",
              message: errorInfo.message,
              stop_reason: "error",
              run_id: errorInfo.run_id,
              session_id: sessionId,
              uuid: randomUUID(),
              ...(errorInfo.error_type &&
                errorInfo.run_id && {
                  api_error: {
                    message_type: "error_message",
                    message: errorInfo.message,
                    error_type: errorInfo.error_type,
                    detail: errorInfo.detail,
                    run_id: errorInfo.run_id,
                  },
                }),
            };
            writeWireMessage(errorEvent);
            shouldOutputChunk = false;
          }
          if (
            isApprovalPendingError(errorInfo?.detail) ||
            isApprovalPendingError(errorInfo?.message)
          ) {
            const recoveryRunId = errorInfo?.run_id;
            const recoveryMsg: RecoveryMessage = {
              type: "recovery",
              recovery_type: "approval_pending",
              message:
                "Detected pending approval conflict; auto-denying stale approval and retrying",
              run_id: recoveryRunId ?? undefined,
              session_id: sessionId,
              uuid: `recovery-${recoveryRunId || randomUUID()}`,
            };
            writeWireMessage(recoveryMsg);
            approvalPendingRecovery = true;
            return { stopReason: "error", shouldAccumulate: true };
          }
          const messageType = (chunk as { message_type?: string }).message_type;
          if (
            messageType === "approval_request_message" ||
            messageType === "approval_response_message"
          ) {
            shouldOutputChunk = false;
          }
          if (shouldOutputChunk) {
            const chunkWithIds = chunk as typeof chunk & {
              otid?: string;
              id?: string;
            };
            const uuid = chunkWithIds.otid || chunkWithIds.id;
            if (includePartialMessages) {
              const streamEvent: StreamEvent = {
                type: "stream_event",
                event: chunk,
                session_id: sessionId,
                uuid: uuid || randomUUID(),
              };
              writeWireMessage(streamEvent);
            } else {
              const msg: MessageWire = {
                type: "message",
                ...chunk,
                session_id: sessionId,
                uuid: uuid || randomUUID(),
              };
              writeWireMessage(msg);
            }
          }

          return { shouldOutput: shouldOutputChunk, shouldAccumulate: true };
        };
      }

      const result = await drainStreamWithResume(
        stream,
        buffers,
        () => {},
        interruptSignal,
        undefined,
        streamJsonHook,
        reminderContextTracker,
        undefined,
        HEADLESS_STREAM_RESUME_POLICY,
      );
      const { apiDurationMs, stopReason } = result;
      const approvals = result.approvals || [];
      const lastRunId = result.lastRunId || null;
      const fallbackError = result.fallbackError ?? null;
      if (lastRunId) lastKnownRunId = lastRunId;

      sessionStats.endTurn(apiDurationMs);

      if (stopReason === "cancelled" || interruptSignal.aborted) {
        await exitInterrupted();
      }

      if (
        stopReason !== "requires_approval" &&
        !approvalPendingRecovery &&
        !(stopReason === "error" && fallbackError)
      ) {
        await checkMaxTurns();
      }

      if (approvalPendingRecovery) {
        await resolveAllPendingApprovals();
        continue;
      }

      if (stopReason === "end_turn") {
        llmApiErrorRetries = 0;
        emptyResponseRetries = 0;
        conversationBusyRetries = 0;
        chatgptPlanSwaps = 0;
        chatgptExhaustedProviders.clear();

        const continueMessage = await emitHeadlessTurnEnd({
          agent,
          conversationId,
          stopReason,
          assistantMessage: findLastAssistantText(toLines(buffers)),
          adapter: headlessModAdapter,
          context: turnStartModContext,
        });

        if (continueMessage) {
          currentInput = [
            {
              role: "user",
              content: continueMessage,
              otid: randomUUID(),
            },
          ];
          const continueTurnStartEmission = await emitHeadlessTurnStart({
            agent,
            conversationId,
            input: currentInput,
            adapter: headlessModAdapter,
            context: turnStartModContext,
          });
          if (continueTurnStartEmission.cancelled) {
            await emitHeadlessTurnStartCancellationOutput({
              agent,
              conversationId,
              outputFormat,
              reason: continueTurnStartEmission.reason,
              sessionId,
            });
            await exitHeadless(1, "headless_turn_start_cancelled");
          } else {
            currentInput = continueTurnStartEmission.input;
          }
          continue;
        }

        if (importedInit) {
          try {
            const followUp = await importInitWaitForWorkflows(importedInit);
            if (followUp) {
              currentInput = [
                { role: "user", content: followUp, otid: randomUUID() },
              ];
              continue;
            }
          } catch (error) {
            console.error(`Import initialization blocked: ${String(error)}`);
            await exitHeadless(1, "import_init_workflow_failed");
          }
        }
        break;
      }

      if (stopReason === "requires_approval") {
        if (approvals.length === 0) {
          console.error("Unexpected empty approvals array");
          await exitHeadless(1, "headless_requires_approval_empty");
        }

        type Decision =
          | {
              type: "approve";
              approval: {
                toolCallId: string;
                toolName: string;
                toolArgs: string;
              };
            }
          | {
              type: "deny";
              approval: {
                toolCallId: string;
                toolName: string;
                toolArgs: string;
              };
              reason: string;
            };

        const { autoAllowed, autoDenied, needsUserInput } =
          await classifyApprovals(approvals, {
            requireArgsForAutoApprove: true,
            missingNameReason: "Tool call incomplete - missing name",
            toolContextId: turnToolContextId ?? undefined,
          });

        const decisions: Decision[] = [
          ...autoAllowed.map((ac) => ({
            type: "approve" as const,
            approval: ac.approval,
          })),
          ...needsUserInput.map((ac) => {
            return {
              type: "deny" as const,
              approval: ac.approval,
              reason: "Tool requires approval (headless mode)",
            };
          }),
          ...autoDenied.map((ac) => ({
            type: "deny" as const,
            approval: ac.approval,
            reason: formatPermissionDenial(ac.permission, ac.denyReason),
          })),
        ];

        const { executeApprovalBatch } = await import(
          "@/agent/approval-execution"
        );

        if (outputFormat === "stream-json") {
          emitLocalToolCalls(decisions, sessionId);
        }

        const executedResults = await executeApprovalBatch(
          decisions,
          undefined,
          {
            abortSignal: interruptSignal,
            toolContextId: turnToolContextId ?? undefined,
          },
        );

        if (interruptSignal.aborted) {
          await exitInterrupted();
        }

        if (outputFormat === "stream-json") {
          emitLocalToolReturns(executedResults, sessionId);
        }

        currentInput = responseState.prepare(
          executedResults,
          needsUserInput.length === 0,
        );
        continue;
      }

      let latestErrorText: string | null = null;
      const linesForTurn = toLines(buffers);
      for (let i = linesForTurn.length - 1; i >= 0; i -= 1) {
        const line = linesForTurn[i];
        if (
          line?.kind === "error" &&
          "text" in line &&
          typeof line.text === "string"
        ) {
          latestErrorText = line.text;
          break;
        }
      }

      const runErrorInfo = await fetchRunErrorInfo(lastRunId),
        detailFromRun = runErrorInfo?.detail ?? runErrorInfo?.message;

      if (chatgptPlanSwaps < CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN) {
        const rotation = await rotateChatGPTPlanOnQuotaLimit({
          agentId: agent.id,
          conversationId,
          currentHandle: null,
          error: result.errorInfo ?? runErrorInfo ?? latestErrorText,
          exhaustedProviders: chatgptExhaustedProviders,
          signal: interruptSignal,
        });
        if (rotation) {
          chatgptPlanSwaps += 1;
          const rotationMessage = formatPlanRotationNotice(rotation);
          if (outputFormat === "stream-json") {
            const retryMsg: RetryMessage = {
              type: "retry",
              reason: "llm_api_error",
              attempt: chatgptPlanSwaps,
              max_attempts: CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN,
              delay_ms: 0,
              run_id: lastRunId ?? undefined,
              session_id: sessionId,
              uuid: `retry-${lastRunId || randomUUID()}`,
            };
            writeWireMessage(retryMsg);
          } else {
            console.error(rotationMessage);
          }

          currentInput = refreshInputOtidsForNewRequest(currentInput);
          continue;
        }
      }

      if (stopReason === "llm_api_error") {
        if (llmApiErrorRetries < LLM_API_ERROR_MAX_RETRIES) {
          const attempt = llmApiErrorRetries + 1;
          llmApiErrorRetries = attempt;

          const delayMs = getRetryDelayMs({
            category: "transient_provider",
            attempt,
            detail: detailFromRun,
          });

          if (outputFormat === "stream-json") {
            const retryMsg: RetryMessage = {
              type: "retry",
              reason: "llm_api_error",
              attempt,
              max_attempts: LLM_API_ERROR_MAX_RETRIES,
              delay_ms: delayMs,
              run_id: lastRunId ?? undefined,
              session_id: sessionId,
              uuid: `retry-${lastRunId || randomUUID()}`,
            };
            writeWireMessage(retryMsg);
          } else {
            const delaySeconds = Math.round(delayMs / 1000);
            console.error(
              `LLM API error encountered (attempt ${attempt} of ${LLM_API_ERROR_MAX_RETRIES}), retrying in ${delaySeconds}s...`,
            );
          }

          await new Promise((resolve) => setTimeout(resolve, delayMs));

          currentInput = refreshInputOtidsForNewRequest(currentInput);
          continue;
        }
      }

      const invalidIdsDetected =
        isInvalidToolCallIdsError(detailFromRun) ||
        isInvalidToolCallIdsError(latestErrorText);
      if (invalidIdsDetected) {
        if (outputFormat === "stream-json") {
          const recoveryMsg: RecoveryMessage = {
            type: "recovery",
            recovery_type: "invalid_tool_call_ids",
            message:
              "Tool call ID mismatch; fetching actual pending approvals and resyncing",
            run_id: lastRunId ?? undefined,
            session_id: sessionId,
            uuid: `recovery-${lastRunId || randomUUID()}`,
          };
          writeWireMessage(recoveryMsg);
        } else {
          console.error(
            "Tool call ID mismatch; fetching actual pending approvals...",
          );
        }

        try {
          currentInput = await rebuildInputForApprovalResync(
            agent.id,
            conversationId,
            currentInput,
          );
          continue;
        } catch {
          if (outputFormat === "stream-json") {
            const errorMsg: ErrorMessage = {
              type: "error",
              message: "Failed to reconcile pending approvals for resync",
              stop_reason: stopReason,
              run_id: lastRunId ?? undefined,
              session_id: sessionId,
              uuid: `error-${lastRunId || randomUUID()}`,
            };
            await writeWireMessageAsync(errorMsg);
          } else {
            console.error("Failed to reconcile pending approvals for resync");
          }
          await exitHeadless(1, "headless_approval_resync_failed");
        }
      }

      const nonRetriableReasons: StopReasonType[] = [
        "cancelled",
        "requires_approval",
        "max_steps",
        "max_tokens_exceeded",
        "context_window_overflow_in_system_prompt",
        "end_turn",
        "tool_rule",
        "no_tool_call",
      ];
      if (nonRetriableReasons.includes(stopReason)) {
      } else if (llmApiErrorRetries < LLM_API_ERROR_MAX_RETRIES) {
        try {
          let errorType: string | undefined;
          let detail = detailFromRun ?? latestErrorText ?? "";
          let explicitRetryable: boolean | undefined;

          if (lastRunId) {
            const run = await getBackend().retrieveRun(lastRunId);
            const metaError = run.metadata?.error as
              | {
                  error_type?: string;
                  message?: string;
                  detail?: string;
                  retryable?: boolean;
                  error?: {
                    error_type?: string;
                    detail?: string;
                    retryable?: boolean;
                  };
                }
              | undefined;

            errorType = metaError?.error_type ?? metaError?.error?.error_type;
            detail = metaError?.detail ?? metaError?.error?.detail ?? detail;
            explicitRetryable =
              metaError?.retryable ?? metaError?.error?.retryable;
          }

          if (
            isEmptyResponseRetryable(
              errorType,
              detail,
              emptyResponseRetries,
              EMPTY_RESPONSE_MAX_RETRIES,
            )
          ) {
            const attempt = emptyResponseRetries + 1;
            const delayMs = getRetryDelayMs({
              category: "empty_response",
              attempt,
            });

            emptyResponseRetries = attempt;

            if (attempt >= EMPTY_RESPONSE_MAX_RETRIES) {
              const nudgeMessage: MessageCreate = {
                role: "user",
                content: `<system-reminder>The previous response was empty. Please provide a response with either text content or a tool call.</system-reminder>`,
                otid: randomUUID(),
              };
              currentInput = [...currentInput, nudgeMessage];
            }

            if (outputFormat === "stream-json") {
              const retryMsg: RetryMessage = {
                type: "retry",
                reason: "llm_api_error",
                attempt,
                max_attempts: EMPTY_RESPONSE_MAX_RETRIES,
                delay_ms: delayMs,
                run_id: lastRunId ?? undefined,
                session_id: sessionId,
                uuid: `retry-empty-${lastRunId || randomUUID()}`,
              };
              writeWireMessage(retryMsg);
            } else {
              console.error(
                `Empty LLM response, retrying (attempt ${attempt} of ${EMPTY_RESPONSE_MAX_RETRIES})...`,
              );
            }

            await new Promise((resolve) => setTimeout(resolve, delayMs));
            currentInput = refreshInputOtidsForNewRequest(currentInput);
            continue;
          }

          if (
            explicitRetryable === true ||
            (explicitRetryable !== false &&
              shouldRetryRunMetadataError(errorType, detail))
          ) {
            const attempt = llmApiErrorRetries + 1;
            const delayMs = getRetryDelayMs({
              category: "transient_provider",
              attempt,
              detail,
            });

            llmApiErrorRetries = attempt;

            if (outputFormat === "stream-json") {
              const retryMsg: RetryMessage = {
                type: "retry",
                reason: "llm_api_error",
                attempt,
                max_attempts: LLM_API_ERROR_MAX_RETRIES,
                delay_ms: delayMs,
                run_id: lastRunId ?? undefined,
                session_id: sessionId,
                uuid: `retry-${lastRunId || randomUUID()}`,
              };
              writeWireMessage(retryMsg);
            } else {
              const delaySeconds = Math.round(delayMs / 1000);
              console.error(
                `LLM API error encountered (attempt ${attempt} of ${LLM_API_ERROR_MAX_RETRIES}), retrying in ${delaySeconds}s...`,
              );
            }

            await new Promise((resolve) => setTimeout(resolve, delayMs));
            currentInput = refreshInputOtidsForNewRequest(currentInput);
            continue;
          }
        } catch (_e) {
          if (
            shouldRetryRunMetadataError(
              undefined,
              detailFromRun ?? latestErrorText,
            )
          ) {
            const attempt = llmApiErrorRetries + 1;
            const detail = detailFromRun ?? latestErrorText;
            const delayMs = getRetryDelayMs({
              category: "transient_provider",
              attempt,
              detail,
            });

            llmApiErrorRetries = attempt;

            if (outputFormat === "stream-json") {
              const retryMsg: RetryMessage = {
                type: "retry",
                reason: "llm_api_error",
                attempt,
                max_attempts: LLM_API_ERROR_MAX_RETRIES,
                delay_ms: delayMs,
                run_id: lastRunId ?? undefined,
                session_id: sessionId,
                uuid: `retry-${lastRunId || randomUUID()}`,
              };
              writeWireMessage(retryMsg);
            } else {
              const delaySeconds = Math.round(delayMs / 1000);
              console.error(
                `LLM API error encountered (attempt ${attempt} of ${LLM_API_ERROR_MAX_RETRIES}), retrying in ${delaySeconds}s...`,
              );
            }

            await new Promise((resolve) => setTimeout(resolve, delayMs));
            currentInput = refreshInputOtidsForNewRequest(currentInput);
            continue;
          }
        }
      }

      markIncompleteToolsAsCancelled(buffers, true, "stream_error");

      const errorLines = toLines(buffers).filter(
        (line) => line.kind === "error",
      );
      const errorMessages = errorLines
        .map((line) => ("text" in line ? line.text : ""))
        .filter(Boolean);

      let errorMessage =
        errorMessages.length > 0
          ? errorMessages.join("; ")
          : fallbackError || `Unexpected stop reason: ${stopReason}`;

      let finalRun: Run | null = null;
      if (lastRunId) {
        try {
          finalRun = await getBackend().retrieveRun(lastRunId);
          if (finalRun.metadata?.error && errorMessages.length === 0) {
            const errorData = finalRun.metadata.error as {
              type?: string;
              message?: string;
              detail?: string;
            };
            const errorObject = {
              error: {
                error: errorData,
                run_id: lastRunId,
              },
            };
            errorMessage = formatErrorDetails(errorObject, agent.id);
          }
        } catch (_e) {
          errorMessage = `${errorMessage}\n(Unable to fetch additional error details from server)`;
        }
      }

      if (
        lastRunId &&
        finalRun &&
        !finalRun.metadata?.error &&
        (finalRun.status === "created" || finalRun.status === "running")
      ) {
        try {
          await backend.cancelRun(finalRun.agent_id || agent.id, lastRunId);
        } catch {}
      }

      trackHeadlessBoundaryError(
        "headless_turn_failed",
        errorMessage,
        "headless_turn_execution",
      );
      if (outputFormat === "stream-json") {
        const errorMsg: ErrorMessage = {
          type: "error",
          message: errorMessage,
          stop_reason: stopReason,
          run_id: lastRunId ?? undefined,
          session_id: sessionId,
          uuid: `error-${lastRunId || randomUUID()}`,
        };
        await writeWireMessageAsync(errorMsg);
      } else {
        console.error(`Error: ${errorMessage}`);
      }
      await exitHeadless(1, "headless_stop_reason_error");
    }
  } catch (error) {
    if (interruptSignal.aborted) {
      await exitInterrupted();
    }
    markIncompleteToolsAsCancelled(buffers, true, "stream_error");

    const errorDetails = formatErrorDetails(error, agent.id);
    trackHeadlessBoundaryError(
      "headless_runtime_exception",
      error,
      "headless_turn_execution",
    );

    if (outputFormat === "stream-json") {
      const errorMsg: ErrorMessage = {
        type: "error",
        message: errorDetails,
        stop_reason: "error",
        run_id: lastKnownRunId ?? undefined,
        session_id: sessionId,
        uuid: `error-${lastKnownRunId || randomUUID()}`,
      };
      await writeWireMessageAsync(errorMsg);
    } else {
      console.error(`Error: ${errorDetails}`);
    }
    await exitHeadless(1, "headless_runtime_exception");
  } finally {
    dispose();
  }
  if (interruptSignal.aborted) await exitInterrupted();

  await runPostTurnMemorySync({
    conversationId,
    agentId: agent.id,
    isEnabled: (id) => settingsManager.isMemfsEnabled(id),
    debugLabel: "Post-turn headless memory sync",
    emitWarning: (text) => {
      if (outputFormat !== "stream-json") {
        console.error(text);
      }
    },
  });

  if (importedInit) {
    try {
      importInitVerify(importedInit);
    } catch (error) {
      console.error(`Import initialization incomplete: ${String(error)}`);
      await exitHeadless(1, "import_init_incomplete");
    }
  }

  sessionStats.updateUsageFromBuffers(buffers);

  const lines = toLines(buffers);
  const reversed = [...lines].reverse();

  const lastAssistant = reversed.find(
    (line) =>
      line.kind === "assistant" &&
      "text" in line &&
      typeof line.text === "string" &&
      line.text.trim().length > 0,
  ) as Extract<Line, { kind: "assistant" }> | undefined;

  const lastReasoning = reversed.find(
    (line) =>
      line.kind === "reasoning" &&
      "text" in line &&
      typeof line.text === "string" &&
      line.text.trim().length > 0,
  ) as Extract<Line, { kind: "reasoning" }> | undefined;

  const lastToolResult = reversed.find(
    (line) =>
      line.kind === "tool_call" &&
      "resultText" in line &&
      typeof (line as Extract<Line, { kind: "tool_call" }>).resultText ===
        "string" &&
      ((line as Extract<Line, { kind: "tool_call" }>).resultText ?? "").trim()
        .length > 0,
  ) as Extract<Line, { kind: "tool_call" }> | undefined;

  const resultText =
    lastAssistant?.text ||
    lastReasoning?.text ||
    lastToolResult?.resultText ||
    "No assistant response found";

  if (!lastAssistant && (lastReasoning || lastToolResult)) {
    trackEndTurnNoAssistant({
      fallbackKind: lastReasoning ? "reasoning" : "tool_call",
      modelHandle: reportModel ?? model,
      runId: lastKnownRunId ?? undefined,
      isSubagent,
      subagentType:
        systemPromptPreset ??
        agent.tags?.find((t) => t.startsWith("type:"))?.slice(5),
    });
  }

  const stats = sessionStats.getSnapshot();
  const usage = {
    prompt_tokens: stats.usage.promptTokens,
    completion_tokens: stats.usage.completionTokens,
    total_tokens: stats.usage.totalTokens,
    step_count: stats.usage.stepCount,
    cached_input_tokens: stats.usage.cachedInputTokens,
    cache_write_tokens: stats.usage.cacheWriteTokens,
    reasoning_tokens: stats.usage.reasoningTokens,
    ...(stats.usage.contextTokens !== undefined && {
      context_tokens: stats.usage.contextTokens,
    }),
  };

  if (outputFormat === "json") {
    const output = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: Math.round(stats.totalWallMs),
      duration_api_ms: Math.round(stats.totalApiMs),
      num_turns: stats.usage.stepCount,
      result: resultText,
      agent_id: publicAgentId,
      conversation_id: conversationId,
      ...(fromAgentId
        ? { environment: { source: "same-environment" as const } }
        : {}),
      usage,
    };
    await writeFinalHeadlessStdout(`${JSON.stringify(output, null, 2)}\n`);
  } else if (outputFormat === "stream-json") {
    const allRunIds = new Set<string>();
    for (const line of toLines(buffers)) {
      if ("run_id" in line && typeof line.run_id === "string") {
        allRunIds.add(line.run_id);
      }
    }

    const resultUuid =
      allRunIds.size > 0
        ? `result-${Array.from(allRunIds).pop()}`
        : `result-${agent.id}`;
    const resultEvent: ResultMessage & {
      environment?: ReplyEnvironmentMetadata;
    } = {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      duration_ms: Math.round(stats.totalWallMs),
      duration_api_ms: Math.round(stats.totalApiMs),
      num_turns: stats.usage.stepCount,
      result: resultText,
      agent_id: publicAgentId,
      conversation_id: conversationId,
      ...(fromAgentId
        ? { environment: { source: "same-environment" as const } }
        : {}),
      run_ids: Array.from(allRunIds),
      usage,
      uuid: resultUuid,
    };
    if (!(await writeWireMessageAsync(resultEvent))) {
      reportSubagentStdoutLoss();
      await exitHeadless(1, "headless_result_write_lost");
    }
  } else {
    if (!resultText || resultText === "No assistant response found") {
      console.error("No assistant response found");
      await exitHeadless(1, "headless_missing_result_text");
    }
    await writeFinalHeadlessStdout(`${resultText}\n`);
  }

  markMilestone("HEADLESS_COMPLETE");
  reportAllMilestones();
  await exitHeadless(0, "headless_complete");
}

async function runBidirectionalMode(
  agent: AgentState,
  conversationId: string,
  effectiveModel: string | null | undefined,
  _outputFormat: string,
  includePartialMessages: boolean,
  availableTools: string[],
  skillSources: SkillSource[],
  systemInfoReminderEnabled: boolean,
  reflectionSettings: ReflectionSettings,
  headlessModAdapter: ModAdapter,
): Promise<void> {
  const sessionId = agent.id;
  const backend = getBackend();
  const telemetryModelId =
    effectiveModel ?? agent.llm_config?.model ?? "unknown";
  const readline = await import("node:readline");
  const systemPromptRecompileByConversation = new Map<string, Promise<void>>();
  const queuedSystemPromptRecompileByConversation = new Set<string>();
  let headlessConversationClosed = false;
  const exitBidirectional = async (
    code: number,
    exitReason: string,
  ): Promise<never> => {
    try {
      if (!headlessConversationClosed) {
        headlessConversationClosed = true;
        try {
          await emitHeadlessConversationClose({
            agent,
            conversationId,
            durationMs: null,
            adapter: headlessModAdapter,
            context: createHeadlessModContext({
              agent,
              conversationId,
              reflectionSettings,
            }),
          });
        } catch {}
      }
      telemetry.trackSessionEnd(undefined, exitReason);
      await telemetry.flush();
    } finally {
      headlessModAdapter.dispose();
      await shutdownBackgroundMemoryTasks(code);
    }
    return await flushAndExit(code);
  };

  const initEvent: SystemInitMessage = {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    agent_id: agent.id,
    conversation_id: conversationId,
    model: effectiveModel ?? agent.llm_config?.model ?? "",
    tools: availableTools,
    cwd: getCurrentWorkingDirectory(),
    mcp_servers: [],
    permission_mode: "",
    slash_commands: [],
    memfs_enabled: settingsManager.isMemfsEnabled(agent.id),
    skill_sources: skillSources,
    system_info_reminder_enabled: systemInfoReminderEnabled,
    reflection_trigger: reflectionSettings.trigger,
    reflection_step_count: reflectionSettings.stepCount,
    uuid: `init-${agent.id}`,
  };
  writeWireMessage(initEvent);

  let currentAbortController: AbortController | null = null;
  let pendingInterrupt = false;
  let turnStarting = false;
  const reminderContextTracker = createContextTracker();
  const sharedReminderState = createSharedReminderState();
  const isSubagent = process.env.LETTA_CODE_AGENT_ROLE === "subagent";
  const maybeLaunchReflectionSubagent = async (
    triggerSource: Exclude<ReflectionTrigger, "off">,
  ): Promise<boolean> => {
    const result = await launchReflectionSubagent({
      agentId: agent.id,
      conversationId,
      memfsEnabled: settingsManager.isMemfsEnabled(agent.id),
      triggerSource,
      reflectionSettings,
      description: AUTO_REFLECTION_DESCRIPTION,
      recompileByConversation: systemPromptRecompileByConversation,
      recompileQueuedByConversation: queuedSystemPromptRecompileByConversation,
    });
    return result.launched;
  };

  const resolveAllPendingApprovals = async () => {
    const { getResumeDataFromBackend } = await import("@/agent/check-approval");
    while (true) {
      const freshAgent = await backend.retrieveAgent(agent.id);

      let resume: Awaited<ReturnType<typeof getResumeDataFromBackend>>;
      try {
        resume = await getResumeDataFromBackend(freshAgent, conversationId);
      } catch (error) {
        if (
          error instanceof APIError &&
          (error.status === 404 || error.status === 422)
        ) {
          break;
        }
        throw error;
      }

      const pendingApprovals = resume.pendingApprovals || [];
      if (pendingApprovals.length === 0) break;

      const denialResults = buildFreshDenialApprovals(
        pendingApprovals,
        STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      ) as ApprovalResult[];
      if (denialResults.length === 0) {
        break;
      }

      const approvalInput: ApprovalCreate = {
        type: "approval",
        approvals: denialResults,
        otid: randomUUID(),
      };

      const approvalMessages: Array<
        | import("@letta-ai/letta-client/resources/agents/agents").MessageCreate
        | import("@letta-ai/letta-client/resources/agents/messages").ApprovalCreate
      > = [approvalInput];

      {
        const { consumeQueuedSkillContent } = await import(
          "@/tools/impl/skill-content-registry"
        );
        const skillContents = consumeQueuedSkillContent();
        if (skillContents.length > 0) {
          approvalMessages.push({
            role: "user" as const,
            content: skillContents.map((sc) => ({
              type: "text" as const,
              text: sc.content,
            })),
            otid: randomUUID(),
          });
        }
      }

      const approvalStream = await sendScopedApprovalMessages({
        agentId: agent.id,
        conversationId,
        approvalMessages,
        modContext: createHeadlessModContext({
          agent,
          conversationId,
          reflectionSettings,
        }),
        modEvents: headlessModAdapter.events,
      });
      const drainResult = await drainStreamWithResume(
        approvalStream,
        createBuffers(agent.id),
        () => {},
        undefined,
        undefined,
        undefined,
        reminderContextTracker,
      );
      if (
        drainResult.stopReason === "error" ||
        drainResult.stopReason === "cancelled"
      ) {
        throw new Error(
          `Approval drain ended with stop reason: ${drainResult.stopReason}`,
        );
      }
    }
  };

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  const lineQueue: string[] = [];
  let lineResolver: ((line: string | null) => void) | null = null;

  const emitQueueEvent = (e: QueueLifecycleEvent): void => {
    writeWireMessage(e);
  };

  let turnInProgress = false;
  let priorTurnInterrupted = false;

  const msgQueueRuntime = new QueueRuntime({
    callbacks: {
      onEnqueued: (item, queueLen) =>
        emitQueueEvent({
          type: "queue_item_enqueued",
          item_id: item.id,
          client_message_id: item.clientMessageId ?? `cm-${item.id}`,
          source: item.source,
          kind: item.kind,
          queue_len: queueLen,
          session_id: sessionId,
          uuid: `q-enq-${item.id}`,
        }),
      onDequeued: (batch) =>
        emitQueueEvent({
          type: "queue_batch_dequeued",
          batch_id: batch.batchId,
          item_ids: batch.items.map((i) => i.id),
          merged_count: batch.mergedCount,
          queue_len_after: batch.queueLenAfter,
          session_id: sessionId,
          uuid: `q-deq-${batch.batchId}`,
        }),
      onCleared: (reason, clearedCount) =>
        emitQueueEvent({
          type: "queue_cleared",
          reason,
          cleared_count: clearedCount,
          session_id: sessionId,
          uuid: `q-clr-${randomUUID()}`,
        }),
    },
  });

  function parseUserLine(raw: string): {
    kind: "message" | "task_notification";
    content: MessageCreate["content"];
  } | null {
    if (!raw.trim()) return null;
    try {
      const parsed: {
        type?: string;
        message?: { content?: MessageCreate["content"] };
        _queuedKind?: string;
      } = JSON.parse(raw);
      if (parsed.type !== "user" || parsed.message?.content === undefined)
        return null;
      const kind =
        parsed._queuedKind === "task_notification"
          ? "task_notification"
          : "message";
      return { kind, content: parsed.message.content };
    } catch {
      return null;
    }
  }

  let blockedEmittedThisTurn = false;
  function maybeNotifyBlocked(raw: string): void {
    if (!turnInProgress || blockedEmittedThisTurn) return;
    if (!parseUserLine(raw)) return;
    blockedEmittedThisTurn = true;
    const queueLen = lineQueue.filter((l) => parseUserLine(l) !== null).length;
    emitQueueEvent({
      type: "queue_blocked",
      reason: "runtime_busy",
      queue_len: Math.max(1, queueLen),
      session_id: sessionId,
      uuid: `q-blk-${randomUUID()}`,
    });
  }

  function enqueueForTracking(input: BidirectionalQueuedInput): void {
    if (input.kind === "task_notification") {
      msgQueueRuntime.enqueue({
        kind: "task_notification",
        source: "task_notification",
        text: input.text,
        content: input.content,
      } as Parameters<typeof msgQueueRuntime.enqueue>[0]);
    } else if (input.kind === "cron_prompt") {
      msgQueueRuntime.enqueue({
        kind: "cron_prompt",
        source: "cron",
        text: input.text,
      } as Parameters<typeof msgQueueRuntime.enqueue>[0]);
    } else {
      msgQueueRuntime.enqueue({
        kind: "message",
        source: "user",
        content: input.content,
      } as Parameters<typeof msgQueueRuntime.enqueue>[0]);
    }
  }

  setMessageQueueAdder((queuedMessage) => {
    const syntheticUserLine = serializeQueuedMessageAsUserLine(queuedMessage);
    maybeNotifyBlocked(syntheticUserLine);
    if (lineResolver) {
      const resolve = lineResolver;
      lineResolver = null;
      resolve(syntheticUserLine);
      return;
    }
    lineQueue.push(syntheticUserLine);
  });

  rl.on("line", (line) => {
    maybeNotifyBlocked(line);
    let parsedLine: {
      type?: string;
      request?: { subtype?: string };
      request_id?: string | number;
    } | null = null;
    try {
      parsedLine = JSON.parse(line);
    } catch {}
    const interruptRequestId =
      parsedLine?.type === "control_request" &&
      parsedLine?.request?.subtype === "interrupt"
        ? String(parsedLine.request_id ?? "")
        : null;
    if (interruptRequestId !== null) {
      const action = decideInterruptAction({
        hasActiveController: currentAbortController !== null,
        turnStarting,
      });
      if (action === "abort-active") {
        (currentAbortController as AbortController).abort();
        if (lineResolver) {
          const resolve = lineResolver;
          lineResolver = null;
          resolve(null);
        }
      } else if (action === "latch") {
        pendingInterrupt = true;
      }
      const interruptResponse: ControlResponse = {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: interruptRequestId,
        },
        session_id: sessionId,
        uuid: randomUUID(),
      };
      writeWireMessage(interruptResponse);
      return;
    }
    if (lineResolver) {
      if (parsedLine?.type === "user") turnStarting = true;
      const resolve = lineResolver;
      lineResolver = null;
      resolve(line);
    } else {
      lineQueue.push(line);
    }
  });

  rl.on("close", () => {
    setMessageQueueAdder(null);
    msgQueueRuntime.clear("shutdown");
    if (lineResolver) {
      const resolve = lineResolver;
      lineResolver = null;
      resolve(null);
    }
  });

  async function getNextLine(): Promise<string | null> {
    if (lineQueue.length > 0) {
      return lineQueue.shift() ?? null;
    }
    return new Promise<string | null>((resolve) => {
      lineResolver = resolve;
    });
  }

  const EXTERNAL_TOOL_WAIT_ABORTED = Symbol("externalToolWaitAborted");
  type ExternalToolWaitOutcome =
    | string
    | null
    | typeof EXTERNAL_TOOL_WAIT_ABORTED;

  async function getNextLineOrAbort(
    signal: AbortSignal | undefined,
  ): Promise<ExternalToolWaitOutcome> {
    if (signal?.aborted) return EXTERNAL_TOOL_WAIT_ABORTED;
    if (lineQueue.length > 0) return lineQueue.shift() ?? null;
    if (!signal) return getNextLine();
    return new Promise<ExternalToolWaitOutcome>((resolve) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        if (lineResolver === settle) lineResolver = null;
        resolve(EXTERNAL_TOOL_WAIT_ABORTED);
      };
      const settle = (line: string | null) => {
        cleanup();
        resolve(line);
      };
      signal.addEventListener("abort", onAbort);
      lineResolver = settle;
    });
  }

  async function requestPermission(
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<HeadlessPermissionResult> {
    const requestId = `perm-${toolCallId}`;

    const diffs = await computeDiffPreviews(toolName, toolInput);

    const canUseToolRequest: CanUseToolControlRequest = {
      subtype: "can_use_tool",
      tool_name: toolName,
      input: toolInput,
      tool_call_id: toolCallId,
      permission_suggestions: [],
      blocked_path: null,
      ...(diffs.length > 0 ? { diffs } : {}),
    };

    const controlRequest: ControlRequest = {
      type: "control_request",
      request_id: requestId,
      request: canUseToolRequest,
    };

    writeWireMessage(controlRequest);

    return waitForHeadlessPermissionResponse({
      requestId,
      getNextLine,
      restoreDeferredLines: (lines) => lineQueue.unshift(...lines),
      interruptTurn: () => currentAbortController?.abort(),
    });
  }

  async function recoverPendingApprovalsFromControlRequest(
    request: RecoverPendingApprovalsControlRequest,
  ): Promise<{
    recovered: boolean;
    pending_approval: boolean;
    approvals_processed: number;
  }> {
    const targetAgentId = request.agent_id ?? agent.id;
    const targetConversationId = request.conversation_id ?? conversationId;

    if (targetAgentId !== agent.id) {
      throw new Error(
        `recover_pending_approvals agent mismatch: ${targetAgentId} != ${agent.id}`,
      );
    }

    const { getResumeDataFromBackend } = await import("@/agent/check-approval");

    let approvalsProcessed = 0;
    const MAX_RECOVERY_PASSES = 8;

    for (let pass = 0; pass < MAX_RECOVERY_PASSES; pass += 1) {
      const freshAgent = await backend.retrieveAgent(agent.id);

      let resume: Awaited<ReturnType<typeof getResumeDataFromBackend>>;
      try {
        resume = await getResumeDataFromBackend(
          freshAgent,
          targetConversationId,
          {
            includeMessageHistory: false,
          },
        );
      } catch (error) {
        if (
          error instanceof APIError &&
          (error.status === 404 || error.status === 422)
        ) {
          return {
            recovered: true,
            pending_approval: false,
            approvals_processed: approvalsProcessed,
          };
        }
        throw error;
      }

      const pendingApprovals = resume.pendingApprovals || [];
      if (pendingApprovals.length === 0) {
        return {
          recovered: true,
          pending_approval: false,
          approvals_processed: approvalsProcessed,
        };
      }

      const denialResults = buildFreshDenialApprovals(
        pendingApprovals,
        STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      ) as ApprovalResult[];
      if (denialResults.length === 0) {
        return {
          recovered: false,
          pending_approval: true,
          approvals_processed: approvalsProcessed,
        };
      }
      approvalsProcessed += denialResults.length;

      const approvalInput: ApprovalCreate = {
        type: "approval",
        approvals: denialResults,
        otid: randomUUID(),
      };
      const approvalStream = await sendScopedApprovalMessages({
        agentId: agent.id,
        conversationId: targetConversationId,
        approvalMessages: [approvalInput],
        modContext: createHeadlessModContext({
          agent,
          conversationId: targetConversationId,
          reflectionSettings,
        }),
        modEvents: headlessModAdapter.events,
      });

      const drainResult = await drainStreamWithResume(
        approvalStream,
        createBuffers(agent.id),
        () => {},
        undefined,
        undefined,
        undefined,
        reminderContextTracker,
      );

      if (drainResult.stopReason === "error") {
        throw new Error(
          drainResult.fallbackError ||
            "recover_pending_approvals failed while applying approvals",
        );
      }
    }

    return {
      recovered: false,
      pending_approval: true,
      approvals_processed: approvalsProcessed,
    };
  }

  while (true) {
    const line = await getNextLine();
    if (line === null) break;
    if (!line.trim()) continue;

    let message: {
      type: string;
      message?: { role: string; content: MessageCreate["content"] };
      request_id?: string;
      request?: { subtype: string };
      session_id?: string;
      _queuedKind?: QueuedMessage["kind"];
    };

    try {
      message = JSON.parse(line);
    } catch {
      const errorMsg: ErrorMessage = {
        type: "error",
        message: "Invalid JSON input",
        stop_reason: "error",
        session_id: sessionId,
        uuid: randomUUID(),
      };
      writeWireMessage(errorMsg);
      continue;
    }

    if (message.type === "control_request") {
      const subtype = message.request?.subtype;
      const requestId = message.request_id;

      if (subtype === "initialize") {
        const initResponse: ControlResponse = {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId ?? "",
            response: {
              agent_id: agent.id,
              model: effectiveModel ?? agent.llm_config?.model,
              tools: availableTools,
              memfs_enabled: settingsManager.isMemfsEnabled(agent.id),
              skill_sources: skillSources,
              system_info_reminder_enabled: systemInfoReminderEnabled,
              reflection_trigger: reflectionSettings.trigger,
              reflection_step_count: reflectionSettings.stepCount,
            },
          },
          session_id: sessionId,
          uuid: randomUUID(),
        };
        writeWireMessage(initResponse);
      } else if (subtype === "interrupt") {
        if (
          currentAbortController !== null &&
          decideInterruptAction({
            hasActiveController: true,
            turnStarting,
          }) === "abort-active"
        ) {
          (currentAbortController as AbortController).abort();
        }
        const interruptResponse: ControlResponse = {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId ?? "",
          },
          session_id: sessionId,
          uuid: randomUUID(),
        };
        writeWireMessage(interruptResponse);
      } else if (subtype === "register_external_tools") {
        const toolsRequest = message.request as {
          tools?: ExternalToolDefinition[];
        };
        const tools = toolsRequest.tools ?? [];

        registerExternalTools(tools);

        setExternalToolExecutor(
          async (toolCallId, toolName, input, context) => {
            const signal = context?.signal;
            if (signal?.aborted) {
              return {
                content: [{ type: "text", text: INTERRUPTED_BY_USER }],
                isError: true,
              };
            }
            const execRequest: ControlRequest = {
              type: "control_request",
              request_id: `ext-${toolCallId}`,
              request: {
                subtype: "execute_external_tool",
                tool_call_id: toolCallId,
                tool_name: toolName,
                input,
              } as unknown as CanUseToolControlRequest,
            };
            writeWireMessage(execRequest);

            const deferredLines: string[] = [];
            try {
              while (true) {
                const line = await getNextLineOrAbort(signal);
                if (line === EXTERNAL_TOOL_WAIT_ABORTED) {
                  return {
                    content: [{ type: "text", text: INTERRUPTED_BY_USER }],
                    isError: true,
                  };
                }
                if (line === null) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: currentAbortController?.signal.aborted
                          ? INTERRUPTED_BY_USER
                          : "stdin closed",
                      },
                    ],
                    isError: true,
                  };
                }
                if (!line.trim()) continue;

                try {
                  const msg = JSON.parse(line);
                  if (
                    msg.type === "control_response" &&
                    msg.response?.subtype === "external_tool_result"
                  ) {
                    if (msg.response.tool_call_id === toolCallId) {
                      return {
                        content: msg.response.content ?? [
                          { type: "text", text: "" },
                        ],
                        isError: msg.response.is_error ?? false,
                      };
                    }
                    continue;
                  }
                } catch {}
                deferredLines.push(line);
              }
            } finally {
              if (deferredLines.length > 0) lineQueue.unshift(...deferredLines);
            }
          },
        );

        const registerResponse: ControlResponse = {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId ?? "",
            response: { registered: tools.length },
          },
          session_id: sessionId,
          uuid: randomUUID(),
        };
        writeWireMessage(registerResponse);
      } else if (subtype === "bootstrap_session_state") {
        const bootstrapReq = message.request as BootstrapSessionStateRequest;
        const { getResumeDataFromBackend } = await import(
          "@/agent/check-approval"
        );
        let hasPendingApproval = false;

        try {
          const freshAgent = await backend.retrieveAgent(agent.id);
          const resume = await getResumeDataFromBackend(
            freshAgent,
            conversationId,
            {
              includeMessageHistory: false,
            },
          );
          hasPendingApproval = (resume.pendingApprovals?.length ?? 0) > 0;
        } catch (error) {
          if (
            !(error instanceof APIError) ||
            (error.status !== 404 && error.status !== 422)
          ) {
            console.warn(
              `[bootstrap] pending-approval probe failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        const bootstrapResp = await handleBootstrapSessionState({
          bootstrapReq,
          sessionContext: {
            agentId: agent.id,
            conversationId,
            model: effectiveModel ?? agent.llm_config?.model,
            tools: availableTools,
            memfsEnabled: settingsManager.isMemfsEnabled(agent.id),
            sessionId,
          },
          requestId: requestId ?? "",
          backend,
          hasPendingApproval,
        });
        writeWireMessage(bootstrapResp);
      } else if (subtype === "list_messages") {
        const listReq = message.request as ListMessagesControlRequest;
        const listResp = await handleListMessages({
          listReq,
          sessionConversationId: conversationId,
          sessionAgentId: agent.id,
          sessionId,
          requestId: requestId ?? "",
          backend,
        });
        writeWireMessage(listResp);
      } else if (subtype === "recover_pending_approvals") {
        const recoverReq =
          message.request as RecoverPendingApprovalsControlRequest;
        try {
          const recovery =
            await recoverPendingApprovalsFromControlRequest(recoverReq);
          const recoveryResponse: ControlResponse = {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId ?? "",
              response: recovery,
            },
            session_id: sessionId,
            uuid: randomUUID(),
          };
          writeWireMessage(recoveryResponse);
        } catch (error) {
          const recoveryError: ControlResponse = {
            type: "control_response",
            response: {
              subtype: "error",
              request_id: requestId ?? "",
              error: error instanceof Error ? error.message : String(error),
            },
            session_id: sessionId,
            uuid: randomUUID(),
          };
          writeWireMessage(recoveryError);
        }
      } else {
        const errorResponse: ControlResponse = {
          type: "control_response",
          response: {
            subtype: "error",
            request_id: requestId ?? "",
            error: `Unknown control request subtype: ${subtype}`,
          },
          session_id: sessionId,
          uuid: randomUUID(),
        };
        writeWireMessage(errorResponse);
      }
      continue;
    }

    if (message.type === "user" && message.message?.content !== undefined) {
      const firstQueuedInput = toBidirectionalQueuedInput(
        message.message.content,
        message._queuedKind,
      );
      if (
        firstQueuedInput.kind === "user" &&
        shouldTrackTelemetryForQueuedMessage(message._queuedKind)
      ) {
        trackTelemetryUserInputFromContent(
          message.message.content,
          telemetryModelId,
        );
      }

      const queuedInputs: BidirectionalQueuedInput[] = [firstQueuedInput];

      while (lineQueue.length > 0) {
        const candidate = lineQueue[0];
        if (!candidate?.trim()) {
          lineQueue.shift();
          continue;
        }

        let parsedCandidate: {
          type?: string;
          message?: { content?: MessageCreate["content"] };
          _queuedKind?: QueuedMessage["kind"];
        };
        try {
          parsedCandidate = JSON.parse(candidate);
        } catch {
          break;
        }

        if (
          parsedCandidate.type === "user" &&
          parsedCandidate.message?.content !== undefined
        ) {
          lineQueue.shift();
          const queuedInput = toBidirectionalQueuedInput(
            parsedCandidate.message.content,
            parsedCandidate._queuedKind,
          );
          if (
            queuedInput.kind === "user" &&
            shouldTrackTelemetryForQueuedMessage(parsedCandidate._queuedKind)
          ) {
            trackTelemetryUserInputFromContent(
              parsedCandidate.message.content,
              telemetryModelId,
            );
          }
          queuedInputs.push(queuedInput);
          continue;
        }

        break;
      }

      for (const input of queuedInputs) {
        enqueueForTracking(input);
      }
      msgQueueRuntime.consumeItems(queuedInputs.length);

      const userContent = mergeBidirectionalQueuedInput(queuedInputs);
      if (userContent === null) {
        turnStarting = false;
        pendingInterrupt = false;
        continue;
      }

      currentAbortController = new AbortController();
      if (pendingInterrupt) {
        pendingInterrupt = false;
        currentAbortController.abort();
      }
      turnStarting = false;
      turnInProgress = true;
      try {
        const buffers = createBuffers(agent.id);
        const startTime = performance.now();
        const userOtid = randomUUID();
        const userTranscriptText = extractTelemetryInputText(userContent);
        if (userTranscriptText.length > 0) {
          const userLineId = `user-${userOtid}`;
          buffers.byId.set(userLineId, {
            kind: "user",
            id: userLineId,
            text: userTranscriptText,
            otid: userOtid,
          });
          buffers.userLineIdByOtid.set(userOtid, userLineId);
          buffers.order.push(userLineId);
        }
        let numTurns = 0;
        let lastStopReason: StopReasonType | null = null;
        let sawStreamError = false;
        let preStreamTransientRetries = 0;

        const lastRunAt = (agent as { last_run_completion?: string })
          .last_run_completion;
        const { parts: sharedReminderParts } = await buildSharedReminderParts({
          mode: isSubagent ? "subagent" : "headless-bidirectional",
          agent: {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            lastRunAt: lastRunAt ?? null,
            conversationId,
          },
          state: sharedReminderState,
          systemInfoReminderEnabled,
          workingDirectory: getCurrentWorkingDirectory(),
          skillSources,
        });
        const turnStartModContext = createHeadlessModContext({
          agent,
          conversationId,
          reflectionSettings,
        });
        const enrichedContent = prependReminderPartsToContent(userContent, [
          ...sharedReminderParts,
        ]);

        const responseState = createHeadlessResponseState();
        let currentInput: Array<MessageCreate | ApprovalCreate> = [
          { role: "user", content: enrichedContent, otid: userOtid },
        ];
        const turnStartEmission = await emitHeadlessTurnStart({
          agent,
          conversationId,
          input: currentInput,
          adapter: headlessModAdapter,
          context: turnStartModContext,
        });
        if (turnStartEmission.cancelled) {
          writeBidirectionalTurnStartCancellation({
            agent,
            conversationId,
            reason: turnStartEmission.reason,
            sessionId,
          });
          continue;
        }
        currentInput = turnStartEmission.input;

        if (priorTurnInterrupted) {
          priorTurnInterrupted = false;
          currentInput.unshift({
            role: "user",
            content: INTERRUPT_RECOVERY_ALERT,
            otid: randomUUID(),
          });
          try {
            await resolveAllPendingApprovals();
          } catch (recoveryError) {
            debugWarn(
              "approval",
              `Post-interrupt approval recovery failed: ${
                recoveryError instanceof Error
                  ? recoveryError.message
                  : String(recoveryError)
              }`,
            );
          }
        }

        approvalLoop: while (true) {
          numTurns++;

          if (currentAbortController?.signal.aborted) {
            break;
          }

          {
            const { consumeQueuedSkillContent } = await import(
              "@/tools/impl/skill-content-registry"
            );
            const skillContents = consumeQueuedSkillContent();
            if (skillContents.length > 0) {
              currentInput = [
                ...currentInput,
                {
                  role: "user" as const,
                  content: skillContents.map((sc) => ({
                    type: "text" as const,
                    text: sc.content,
                  })),
                },
              ];
            }
          }

          let stream: Awaited<ReturnType<typeof sendMessageStream>>;
          let turnToolContextId: string | null = null;
          try {
            const turnToolContext = await prepareHeadlessToolExecutionContext({
              agentId: agent.id,
              conversationId,
              modContext: createHeadlessModContext({
                agent,
                conversationId,
                reflectionSettings,
              }),
              modEvents: headlessModAdapter.events,
            });
            availableTools = turnToolContext.availableTools;
            stream = await sendMessageStream(conversationId, currentInput, {
              agentId: agent.id,
              allowResponseStateReuse: responseState.consume(currentInput),
              preparedToolContext:
                turnToolContext.preparedToolContext.preparedToolContext,
            });
            turnToolContextId = getStreamToolContextId(stream);
          } catch (preStreamError) {
            const errorDetail = extractConflictDetail(preStreamError);

            const preStreamAction = getPreStreamErrorAction(errorDetail, 0, 0, {
              status:
                preStreamError instanceof APIError
                  ? preStreamError.status
                  : undefined,
              transientRetries: preStreamTransientRetries,
              maxTransientRetries: LLM_API_ERROR_MAX_RETRIES,
            });

            if (preStreamAction === "resolve_approval_pending") {
              const recoveryMsg: RecoveryMessage = {
                type: "recovery",
                recovery_type: "approval_pending",
                message:
                  "Detected pending approval conflict on send; resolving before retry",
                session_id: sessionId,
                uuid: `recovery-bidir-${randomUUID()}`,
              };
              writeWireMessage(recoveryMsg);
              await resolveAllPendingApprovals();
              continue;
            }

            if (preStreamAction === "retry_transient") {
              const attempt = preStreamTransientRetries + 1;
              const retryAfterMs =
                preStreamError instanceof APIError
                  ? parseRetryAfterHeaderMs(
                      preStreamError.headers?.get("retry-after"),
                    )
                  : null;
              const delayMs = getRetryDelayMs({
                category: "transient_provider",
                attempt,
                detail: errorDetail,
                retryAfterMs,
              });
              preStreamTransientRetries = attempt;

              const retryMsg: RetryMessage = {
                type: "retry",
                reason: "llm_api_error",
                attempt,
                max_attempts: LLM_API_ERROR_MAX_RETRIES,
                delay_ms: delayMs,
                session_id: sessionId,
                uuid: `retry-bidir-${randomUUID()}`,
              };
              writeWireMessage(retryMsg);

              await new Promise((resolve) => setTimeout(resolve, delayMs));
              continue;
            }

            throw preStreamError;
          }
          preStreamTransientRetries = 0;
          const streamJsonHook: DrainStreamHook = ({
            chunk,
            shouldOutput,
            errorInfo,
          }) => {
            if (errorInfo && shouldOutput) {
              sawStreamError = true;
              const errorEvent: ErrorMessage = {
                type: "error",
                message: errorInfo.message,
                stop_reason: "error",
                run_id: errorInfo.run_id,
                session_id: sessionId,
                uuid: randomUUID(),
                ...(errorInfo.error_type &&
                  errorInfo.run_id && {
                    api_error: {
                      message_type: "error_message",
                      message: errorInfo.message,
                      error_type: errorInfo.error_type,
                      detail: errorInfo.detail,
                      run_id: errorInfo.run_id,
                    },
                  }),
              };
              writeWireMessage(errorEvent);
              return { shouldAccumulate: true };
            }

            if (!shouldOutput) {
              return { shouldAccumulate: true };
            }

            const messageType = (chunk as { message_type?: string })
              .message_type;
            if (
              messageType === "approval_request_message" ||
              messageType === "approval_response_message"
            ) {
              return { shouldAccumulate: true };
            }

            const chunkWithIds = chunk as typeof chunk & {
              otid?: string;
              id?: string;
            };
            const uuid = chunkWithIds.otid || chunkWithIds.id;

            if (includePartialMessages) {
              const streamEvent: StreamEvent = {
                type: "stream_event",
                event: chunk,
                session_id: sessionId,
                uuid: uuid || randomUUID(),
              };
              writeWireMessage(streamEvent);
            } else {
              const msg: MessageWire = {
                type: "message",
                ...chunk,
                session_id: sessionId,
                uuid: uuid || randomUUID(),
              };
              writeWireMessage(msg);
            }

            return { shouldAccumulate: true };
          };

          const result = await drainStreamWithResume(
            stream,
            buffers,
            () => {},
            currentAbortController?.signal,
            undefined,
            streamJsonHook,
            reminderContextTracker,
          );
          const stopReason = result.stopReason;
          lastStopReason = stopReason;
          const approvals = result.approvals || [];

          if (stopReason === "end_turn") {
            break;
          }

          if (
            currentAbortController?.signal.aborted ||
            stopReason === "cancelled"
          ) {
            break;
          }

          if (stopReason === "requires_approval") {
            if (approvals.length === 0) {
              lastStopReason = "error";
              break;
            }

            type Decision =
              | {
                  type: "approve";
                  approval: {
                    toolCallId: string;
                    toolName: string;
                    toolArgs: string;
                  };
                  matchedRule: string;
                }
              | {
                  type: "deny";
                  approval: {
                    toolCallId: string;
                    toolName: string;
                    toolArgs: string;
                  };
                  reason: string;
                };

            const { autoAllowed, autoDenied, needsUserInput } =
              await classifyApprovals(approvals, {
                requireArgsForAutoApprove: true,
                missingNameReason: "Tool call incomplete - missing name",
                toolContextId: turnToolContextId ?? undefined,
              });

            const decisions: Decision[] = [
              ...autoAllowed.map((ac) => ({
                type: "approve" as const,
                approval: ac.approval,
                matchedRule:
                  "matchedRule" in ac.permission && ac.permission.matchedRule
                    ? ac.permission.matchedRule
                    : "auto-approved",
              })),
              ...autoDenied.map((ac) => ({
                type: "deny" as const,
                approval: ac.approval,
                reason: formatPermissionDenial(ac.permission, ac.denyReason),
              })),
            ];

            for (const ac of needsUserInput) {
              const permResponse = await requestPermission(
                ac.approval.toolCallId,
                ac.approval.toolName,
                ac.parsedArgs,
              );

              if (permResponse.interrupted) {
                break approvalLoop;
              }

              if (permResponse.decision === "allow") {
                const finalApproval = permResponse.updatedInput
                  ? {
                      ...ac.approval,
                      toolArgs: JSON.stringify(permResponse.updatedInput),
                    }
                  : ac.approval;

                decisions.push({
                  type: "approve",
                  approval: finalApproval,
                  matchedRule: "SDK callback approved",
                });
              } else {
                decisions.push({
                  type: "deny",
                  approval: ac.approval,
                  reason: permResponse.reason || "Denied by SDK callback",
                });
              }
            }

            const { executeApprovalBatch } = await import(
              "@/agent/approval-execution"
            );

            emitLocalToolCalls(decisions, sessionId);

            let executedResults: ApprovalResult[];
            try {
              executedResults = await executeApprovalBatch(
                decisions,
                undefined,
                {
                  toolContextId: turnToolContextId ?? undefined,
                  abortSignal: currentAbortController.signal,
                },
              );
            } catch (error) {
              if (currentAbortController?.signal.aborted) {
                break;
              }
              throw error;
            }

            emitLocalToolReturns(executedResults, sessionId);

            currentInput = responseState.prepare(
              executedResults,
              needsUserInput.length === 0,
            );
            continue;
          }

          break;
        }

        const durationMs = performance.now() - startTime;
        const lines = toLines(buffers);
        const reversed = [...lines].reverse();
        const lastAssistant = reversed.find(
          (line) =>
            line.kind === "assistant" &&
            "text" in line &&
            typeof line.text === "string" &&
            line.text.trim().length > 0,
        ) as Extract<Line, { kind: "assistant" }> | undefined;
        const lastReasoning = reversed.find(
          (line) =>
            line.kind === "reasoning" &&
            "text" in line &&
            typeof line.text === "string" &&
            line.text.trim().length > 0,
        ) as Extract<Line, { kind: "reasoning" }> | undefined;
        const lastToolResult = reversed.find(
          (line) =>
            line.kind === "tool_call" &&
            "resultText" in line &&
            typeof (line as Extract<Line, { kind: "tool_call" }>).resultText ===
              "string" &&
            (
              (line as Extract<Line, { kind: "tool_call" }>).resultText ?? ""
            ).trim().length > 0,
        ) as Extract<Line, { kind: "tool_call" }> | undefined;
        const resultText =
          lastAssistant?.text ||
          lastReasoning?.text ||
          lastToolResult?.resultText ||
          "";

        const isAborted = currentAbortController?.signal.aborted;
        const isError =
          sawStreamError ||
          (lastStopReason &&
            lastStopReason !== "end_turn" &&
            lastStopReason !== "requires_approval");
        const subtype: ResultMessage["subtype"] = isAborted
          ? "interrupted"
          : isError
            ? "error"
            : "success";

        if (subtype === "success" && lastStopReason === "end_turn") {
          try {
            await appendTranscriptDeltaJsonl(agent.id, conversationId, lines);
          } catch (transcriptError) {
            debugWarn(
              "memory",
              `Failed to append transcript delta: ${
                transcriptError instanceof Error
                  ? transcriptError.message
                  : String(transcriptError)
              }`,
            );
          }
          try {
            await maybeLaunchPostTurnReflection({
              agentId: agent.id,
              conversationId,
              memfsEnabled: settingsManager.isMemfsEnabled(agent.id),
              reflectionSettings,
              reminderState: sharedReminderState,
              contextTracker: reminderContextTracker,
              launch: maybeLaunchReflectionSubagent,
            });
          } catch (reflectionError) {
            debugWarn(
              "memory",
              `Failed to evaluate post-turn reflection: ${
                reflectionError instanceof Error
                  ? reflectionError.message
                  : String(reflectionError)
              }`,
            );
          }
        }

        const resultMsg: ResultMessage = {
          type: "result",
          subtype,
          session_id: sessionId,
          duration_ms: Math.round(durationMs),
          duration_api_ms: 0,
          num_turns: numTurns,
          result: resultText,
          agent_id: agent.id,
          conversation_id: conversationId,
          run_ids: [],
          usage: null,
          uuid: `result-${agent.id}-${Date.now()}`,
          ...(subtype === "error" && {
            stop_reason:
              lastStopReason && lastStopReason !== "end_turn"
                ? lastStopReason
                : "error",
          }),
        };
        writeWireMessage(resultMsg);
      } catch (error) {
        const errorDetails = formatErrorDetails(error, agent.id);
        trackHeadlessBoundaryError(
          "headless_bidirectional_runtime_exception",
          error,
          "headless_bidirectional_turn",
        );
        const errorMsg: ErrorMessage = {
          type: "error",
          message: errorDetails,
          stop_reason: "error",
          session_id: sessionId,
          uuid: randomUUID(),
        };
        writeWireMessage(errorMsg);

        const errorResultMsg: ResultMessage = {
          type: "result",
          subtype: "error",
          session_id: sessionId,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 0,
          result: null,
          agent_id: agent.id,
          conversation_id: conversationId,
          run_ids: [],
          usage: null,
          uuid: `result-error-${agent.id}-${Date.now()}`,
          stop_reason: "error",
        };
        writeWireMessage(errorResultMsg);
      } finally {
        await runPostTurnMemorySync({
          conversationId,
          agentId: agent.id,
          isEnabled: (id) => settingsManager.isMemfsEnabled(id),
          debugLabel: "Post-turn headless memory sync",
        });
        turnInProgress = false;
        blockedEmittedThisTurn = false;
        priorTurnInterrupted = currentAbortController?.signal.aborted === true;
        currentAbortController = null;
      }
      continue;
    }

    const errorMsg: ErrorMessage = {
      type: "error",
      message: `Unknown message type: ${message.type}`,
      stop_reason: "error",
      session_id: sessionId,
      uuid: randomUUID(),
    };
    writeWireMessage(errorMsg);
  }

  setMessageQueueAdder(null);
  await exitBidirectional(0, "headless_bidirectional_stdin_closed");
}
