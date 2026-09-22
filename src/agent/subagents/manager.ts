/**
 * Subagent manager for spawning and coordinating subagents
 *
 * This module handles:
 * - Spawning subagents via letta CLI in headless mode
 * - Executing subagents and collecting final reports
 * - Managing parallel subagent execution
 */

import { rmSync } from "node:fs";
import { resolveActingUserId } from "@/agent/acting-user";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { detectMemoryFormat } from "@/agent/memory-format";
import type { ModelReasoningEffort } from "@/agent/model";
import recallSubagentPrompt from "@/agent/prompts/recall_subagent.md";
import recallSubagentLocalPrompt from "@/agent/prompts/recall_subagent_local.md";
import { updateSubagent } from "@/agent/subagent-state.js";
import { wrapSubagentLauncher } from "@/agent/subagents/sandbox";
import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import {
  type BackendMode,
  getBackend,
  getLocalBackendStorageDir,
} from "@/backend";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import {
  INTERRUPTED_BY_USER,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "@/constants";
import { resolveAllowedMemoryRoots } from "@/permissions/memory-paths";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
  runWithRuntimeContext,
} from "@/runtime-context";
import { getRuntimeExecutionEnv } from "@/runtime-execution-settings";
import { settingsManager } from "@/settings-manager";
import { debugLog, debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import { isSubagentStdoutLostError } from "@/utils/subagent-stdout-failure";
import { wrapManagedWorkloadLauncher } from "@/utils/systemd-workload-scope";
import {
  getAllSubagentConfigs,
  resolveSubagentConfigForMemoryFormat,
  type SubagentConfig,
  type SubagentMemoryScope,
  type SubagentResult,
} from ".";
import { buildSubagentPrompt } from "./context-budget";
import { allocateSubagentName } from "./names";
import { collectRemoteTurnResult } from "./remote-turn-wait";
import { buildSubagentArgs } from "./subagent-args";
import {
  composeSubagentChildEnv,
  resolveSubagentInheritedPrimaryRoot,
  resolveSubagentLauncher,
  resolveSubagentWorkingDirectory,
} from "./subagent-launcher";
import {
  getCurrentBillingTier,
  getPrimaryAgentModelHandle,
  resolveSubagentModel,
} from "./subagent-model";
import { spawnSubagentProcess } from "./subagent-process";
import {
  describeSubagentExit,
  type ExecutionState,
  hasSuccessfulToolCall,
  looksLikeTruncatedStreamJson,
  parseResultFromStdout,
  processStreamEvent,
} from "./subagent-stream";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if an error message indicates an unsupported provider
 */
function isProviderNotSupportedError(errorOutput: string): boolean {
  return (
    errorOutput.includes("Provider") &&
    errorOutput.includes("is not supported") &&
    errorOutput.includes("supported providers:")
  );
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Execute a subagent and collect its final report by spawning letta in headless mode
 */
async function executeSubagent(
  type: string,
  config: SubagentConfig,
  model: string | null,
  userPrompt: string,
  subagentId: string,
  isRetry = false,
  signal?: AbortSignal,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
  parentAgentIdOverride?: string,
  transcriptPath?: string,
  memoryScope?: SubagentMemoryScope,
  systemPromptOverride?: string,
  environment?: string,
  actingUserIdOverride?: string,
  parentAgentName?: string | null,
  parentConversationId?: string,
  clientMessageId?: string,
  reasoningEffort?: ModelReasoningEffort,
): Promise<SubagentResult> {
  const withModel = (result: SubagentResult): SubagentResult =>
    model ? { ...result, model } : result;

  // Check if already aborted before starting
  if (signal?.aborted) {
    return withModel({
      agentId: "",
      report: "",
      success: false,
      error: INTERRUPTED_BY_USER,
    });
  }

  // Update the state with the model being used (may differ on retry/fallback)
  if (model) {
    updateSubagent(subagentId, { model });
  }

  try {
    const activeBackend = getBackend();
    const backendMode: BackendMode = activeBackend.capabilities.localMemfs
      ? "local"
      : "api";
    const boundedUserPrompt = buildSubagentPrompt(type, config, userPrompt);

    let parentAgentId = parentAgentIdOverride;
    if (!parentAgentId) {
      try {
        parentAgentId = getCurrentAgentId();
      } catch {
        // Context not available — subagent will have no parent scope.
      }
    }

    const cliArgs = buildSubagentArgs(
      type,
      config,
      model,
      userPrompt,
      existingAgentId,
      existingConversationId,
      maxTurns,
      {
        backendMode,
        promptTransport: "stdin",
        parentAgentId,
        systemPromptOverride,
        environment,
        clientMessageId,
        reasoningEffort,
      },
    );

    const launcher = resolveSubagentLauncher(cliArgs);

    // Resolve auth once in parent and forward to child to avoid per-subagent
    // keychain lookups under high parallel fan-out.
    const settings = await settingsManager.getSettingsWithSecureTokens();
    const inheritedApiKey =
      getDesktopAccessToken() ||
      process.env.LETTA_API_KEY ||
      settings.env?.LETTA_API_KEY;
    const inheritedBaseUrl =
      process.env.LETTA_BASE_URL || settings.env?.LETTA_BASE_URL;
    const inheritedMemoryRoots = resolveAllowedMemoryRoots({
      currentAgentId: parentAgentId ?? null,
      env: getRuntimeExecutionEnv(
        process.env,
        getRuntimeContext()?.executionSettings,
      ),
    });
    const effectiveLaunchProfile = memoryScope
      ? "memory-subagent"
      : config.launchProfile;
    const localBackendStorageDir =
      backendMode === "local" ? getLocalBackendStorageDir() : null;
    const inheritedPrimaryRoot = resolveSubagentInheritedPrimaryRoot({
      backendMode,
      parentAgentId,
      inheritedPrimaryRoot: inheritedMemoryRoots.primaryRoot,
      localBackendStorageDir,
    });
    const subagentWorkingDirectory = resolveSubagentWorkingDirectory(
      { ...process.env, USER_CWD: getCurrentWorkingDirectory() },
      getCurrentWorkingDirectory(),
      {
        subagentType: type,
        launchProfile: effectiveLaunchProfile,
        inheritedPrimaryRoot,
        memoryScope,
      },
    );
    const parentProcessEnv: NodeJS.ProcessEnv = {
      ...getRuntimeExecutionEnv(
        process.env,
        getRuntimeContext()?.executionSettings,
      ),
      USER_CWD: subagentWorkingDirectory,
    };
    const childEnv = composeSubagentChildEnv({
      parentProcessEnv,
      listenerConnectionId: getRuntimeContext()?.connectionId,
      backendMode,
      localBackendStorageDir,
      parentAgentId,
      subagentType: type,
      parentConversationId,
      launchProfile: effectiveLaunchProfile,
      inheritedPrimaryRoot,
      memoryScope,
      inheritedApiKey,
      inheritedBaseUrl,
      actingUserId: actingUserIdOverride,
      transcriptPath,
      subagentId,
      subagentName:
        existingAgentId || existingConversationId
          ? undefined
          : allocateSubagentName(parentAgentName),
    });

    // Optionally confine subagents with the memory-subagent profile to an OS filesystem sandbox.
    // Returns null (spawn unchanged) when disabled, not applicable, or no
    // backend is available on this host.
    const sandbox = wrapSubagentLauncher({
      launcher,
      launchProfile: effectiveLaunchProfile,
      backendMode,
      memoryRoots: inheritedMemoryRoots.roots,
      inheritedPrimaryRoot,
      memoryScope,
      localBackendStorageDir,
    });
    const spawnLauncher = sandbox
      ? { command: sandbox.command, args: sandbox.args }
      : launcher;
    const spawnEnv = sandbox
      ? { ...childEnv, ...sandbox.sandboxEnv }
      : childEnv;
    if (sandbox) {
      debugLog(
        "subagent",
        `memory subagent child sandboxed via ${sandbox.backend}`,
      );
    }

    const managedLauncher = wrapManagedWorkloadLauncher(
      [spawnLauncher.command, ...spawnLauncher.args],
      { env: spawnEnv },
    );
    const [managedCommand, ...managedArgs] = managedLauncher;
    if (!managedCommand) {
      throw new Error("Subagent executable is required");
    }
    signal?.throwIfAborted();
    const runningProcess = spawnSubagentProcess(managedCommand, managedArgs, {
      cwd: subagentWorkingDirectory,
      env: spawnEnv,
      signal,
    });
    const proc = runningProcess.process;
    proc.stdin.on("error", () => {});
    proc.stdin.end(boundedUserPrompt);

    // Consider execution "running" once the child process has successfully spawned.
    // This avoids waiting on subagent init events (e.g. agentURL) to reflect progress.
    proc.once("spawn", () => {
      updateSubagent(subagentId, { status: "running" });
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Initialize execution state
    const state: ExecutionState = {
      agentId: existingAgentId || null,
      conversationId: existingConversationId || null,
      finalResult: null,
      finalError: null,
      enqueueReceipt: null,
      resultStats: null,
      displayedToolCalls: new Set(),
      toolCallStatuses: new Map(),
    };

    // Parse child stdout manually instead of using readline. This keeps the
    // stream handling simple and avoids Bun/runtime-specific instability in
    // nested child-process line readers.
    let stdoutBuffer = "";
    proc.stdout.on("data", (data: Buffer | string) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      stdoutChunks.push(chunk);
      stdoutBuffer += chunk.toString("utf-8");

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        processStreamEvent(line, state, subagentId);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data);
    });

    // Wait for process to complete
    const { exitCode, exitSignal } = await runningProcess.completion;

    if (
      effectiveLaunchProfile === "memory-subagent" &&
      !parentProcessEnv.LETTA_SCRATCHPAD?.trim() &&
      childEnv.LETTA_SCRATCHPAD
    ) {
      try {
        rmSync(childEnv.LETTA_SCRATCHPAD, { recursive: true, force: true });
      } catch (error) {
        debugWarn(
          "subagent",
          `Failed to clean up memory-subagent scratchpad: ${getErrorMessage(error)}`,
        );
      }
    }

    // Ensure the trailing partial line is processed before completing.
    // Without this, late tool events can be dropped before Task marks completion.
    if (stdoutBuffer.length > 0) {
      processStreamEvent(stdoutBuffer, state, subagentId);
    }

    // Check if process was aborted by user
    if (runningProcess.wasAborted()) {
      return withModel({
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: INTERRUPTED_BY_USER,
      });
    }

    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

    // Handle non-zero exit code
    if (exitCode !== 0) {
      // A prepared conversation must fail rather than switch models and agents.
      if (
        !isRetry &&
        (type !== "custom" || !existingConversationId) &&
        isProviderNotSupportedError(stderr)
      ) {
        const { handle: primaryModel } = await getPrimaryAgentModelHandle({
          agentId: parentAgentIdOverride,
        });
        if (primaryModel) {
          // New agent is required: deploying an existing agent omits --model,
          // so the retry would keep the unsupported provider. Keep memoryScope
          // and systemPromptOverride so the replacement child uses the same
          // writable tree and prompt the first attempt was given.
          return executeSubagent(
            type,
            config,
            primaryModel,
            userPrompt,
            subagentId,
            true, // Mark as retry to prevent infinite loops
            signal,
            undefined, // existingAgentId: new agent so --model applies
            undefined, // existingConversationId
            maxTurns,
            parentAgentIdOverride,
            transcriptPath,
            memoryScope,
            systemPromptOverride,
            environment,
            actingUserIdOverride,
            parentAgentName,
            parentConversationId,
            clientMessageId,
            reasoningEffort,
          );
        }
      }

      // The child lost its stdout stream before it could deliver the result
      // envelope (it exits non-zero with a marker on stderr). The stream is
      // gone but the payload is retryable — respawn once.
      if (!isRetry && isSubagentStdoutLostError(stderr)) {
        debugWarn(
          "subagent",
          `Subagent ${subagentId} lost stdout before its result envelope; retrying once`,
        );
        return executeSubagent(
          type,
          config,
          model,
          userPrompt,
          subagentId,
          true, // Mark as retry to prevent infinite loops
          signal,
          existingAgentId,
          existingConversationId,
          maxTurns,
          parentAgentIdOverride,
          transcriptPath,
          memoryScope,
          systemPromptOverride,
          environment,
          actingUserIdOverride,
          parentAgentName,
          parentConversationId,
          clientMessageId,
          reasoningEffort,
        );
      }

      const propagatedError = state.finalError?.trim();

      return withModel({
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error:
          propagatedError || describeSubagentExit(exitCode, exitSignal, stderr),
      });
    }

    // The child submitted a computer-routed send and exited with the receipt.
    // Follow the remote turn from here; the remote listener owns execution.
    if (state.enqueueReceipt) {
      return withModel(
        await collectRemoteTurnResult(
          state.enqueueReceipt,
          state,
          subagentId,
          signal,
        ),
      );
    }

    // Return captured result if available
    if (state.finalResult !== null) {
      const toolFailureError =
        type === "reflection" && !hasSuccessfulToolCall(state)
          ? "Reflection could not complete because it did not finish a successful tool call."
          : undefined;
      const completionError = state.finalError ?? toolFailureError;
      return withModel({
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: state.finalResult,
        success: !completionError,
        error: completionError,
        totalTokens: state.resultStats?.totalTokens,
        stepCount: state.resultStats?.stepCount,
        durationMs: state.resultStats?.durationMs,
      });
    }

    // Return error if captured
    if (state.finalError) {
      debugWarn(
        "subagent",
        `Subagent ${subagentId} (agentId=${state.agentId}) exited with captured error: ${state.finalError}. ` +
          `exitCode=${exitCode}, stderr=${stderr.length} bytes`,
      );
      return withModel({
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: state.finalError,
        totalTokens: state.resultStats?.totalTokens,
        stepCount: state.resultStats?.stepCount,
        durationMs: state.resultStats?.durationMs,
      });
    }

    // No result or error captured during streaming — this is unusual
    debugWarn(
      "subagent",
      `Subagent ${subagentId} (agentId=${state.agentId}) exited cleanly (exitCode=${exitCode}) ` +
        `but no result event was captured during streaming. ` +
        `stdout=${Buffer.concat(stdoutChunks).length} bytes, stderr=${stderr.length} bytes`,
    );

    // Fallback: parse from stdout
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    debugLog(
      "subagent",
      `Falling back to parseResultFromStdout for ${subagentId} (agentId=${state.agentId}). ` +
        `stdout=${stdout.length} bytes, stderr=${stderr.length} bytes, exitCode=${exitCode}`,
    );
    const result = parseResultFromStdout(stdout, state.agentId);
    if (!result.success) {
      debugWarn(
        "subagent",
        `parseResultFromStdout failed for ${subagentId}: ${result.error}. ` +
          `stdout first 500 chars: ${stdout.slice(0, 500)}`,
      );
      // A clean exit whose stream ends mid-line means the result envelope was
      // truncated in transit even though the child believed it succeeded
      // (observed under high parallel fan-out, #3257) — respawn once instead
      // of dropping the response. Other parse failures (e.g. well-formed but
      // unexpected output) are not retried: the child may have already
      // performed side effects, so only unambiguous truncation is worth it.
      if (!isRetry && looksLikeTruncatedStreamJson(stdout)) {
        debugWarn(
          "subagent",
          `Subagent ${subagentId} stdout ends mid-line with no result envelope; retrying once`,
        );
        return executeSubagent(
          type,
          config,
          model,
          userPrompt,
          subagentId,
          true, // Mark as retry to prevent infinite loops
          signal,
          existingAgentId,
          existingConversationId,
          maxTurns,
          parentAgentIdOverride,
          transcriptPath,
          memoryScope,
          systemPromptOverride,
          environment,
          actingUserIdOverride,
          parentAgentName,
          parentConversationId,
          clientMessageId,
          reasoningEffort,
        );
      }
    }
    return withModel(result);
  } catch (error) {
    return withModel({
      agentId: "",
      report: "",
      success: false,
      error: getErrorMessage(error),
    });
  }
}

/**
 * Build a system reminder prefix for deployed agents
 */
function buildDeploySystemReminder(
  senderAgentName: string,
  senderAgentId: string,
): string {
  return `${SYSTEM_REMINDER_OPEN}
This task is from "${senderAgentName}" (agent ID: ${senderAgentId}), which deployed you as a subagent inside the Letta Code CLI (docs.letta.com/letta-code).
You have access to local tools (Bash, Read, Write, Edit, etc.) in their codebase.
Your final message will be returned to the caller.
${SYSTEM_REMINDER_CLOSE}

`;
}

export function shouldPrependDeploySystemReminder(
  existingAgentId: string | undefined,
  parentAgentId: string,
): boolean {
  return !existingAgentId || existingAgentId !== parentAgentId;
}

export function recallPromptForBackend(backendMode?: BackendMode): string {
  return backendMode === "local"
    ? recallSubagentLocalPrompt
    : recallSubagentPrompt;
}

function buildForkSystemReminder(
  subagentType?: string,
  backendMode?: BackendMode,
): string {
  if (subagentType === "recall") {
    const recallPrompt = recallPromptForBackend(backendMode);
    return `${SYSTEM_REMINDER_OPEN}
You have been forked from the primary conversational thread to run as an independent subagent. The fork only exists so you can see the parent agent's conversation trajectory in-context as reference — you are NOT the primary agent and do not share its tools.

**Your sole task is now to search previous conversation history and provide a report. Ignore any existing ongoing tasks.** Do not attempt to continue, finish, or act on anything the primary agent was in the middle of doing.

Your toolset is limited to Bash and Read. You cannot edit files, run skills, dispatch further tasks, or take any action beyond searching messages and returning a report.

You CANNOT ask questions mid-execution — all instructions are provided upfront.
Your final message will be returned to the caller.

${recallPrompt}
${SYSTEM_REMINDER_CLOSE}

`;
  }

  return `${SYSTEM_REMINDER_OPEN}
You have been forked from the primary conversational thread to run as an independent subagent. The fork only exists so you can see the parent agent's conversation trajectory in-context as reference — you are NOT the primary agent.

**Your sole task is the one described in the user message below. Ignore any existing ongoing tasks from the inherited trajectory.** Do not attempt to continue, finish, or act on anything the primary agent was in the middle of doing.

You inherit the primary agent's toolset.

You CANNOT ask questions mid-execution — all instructions are provided upfront.
Your final message will be returned to the caller.
${SYSTEM_REMINDER_CLOSE}

`;
}

/**
 * Spawn a subagent and execute it autonomously
 *
 * @param type - Subagent type (e.g., "code-reviewer", "general-purpose")
 * @param prompt - The task prompt for the subagent
 * @param userModel - Optional model override from the parent agent
 * @param subagentId - ID for tracking in the state store (registered by Task tool)
 * @param signal - Optional abort signal for interruption handling
 * @param existingAgentId - Optional ID of an existing agent to deploy
 * @param existingConversationId - Optional conversation ID to resume
 * @param parentAgentId - Parent agent ID captured at the synchronous call
 *   site. Preferred over reading `getCurrentAgentId()` here because this
 *   function runs after several async yields and the in-process context
 *   may have drifted (e.g., the listener processing another agent's turn).
 */
async function spawnSubagentInContext(
  type: string,
  prompt: string,
  userModel: string | undefined,
  subagentId: string,
  signal?: AbortSignal,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
  forkedContext?: boolean,
  parentAgentId?: string,
  transcriptPath?: string,
  parentConversationId?: string,
  memoryScope?: SubagentMemoryScope,
  systemPromptOverride?: string,
  environment?: string,
  actingUserId?: string,
  resolvedConfig?: SubagentConfig,
  clientMessageId?: string,
  reasoningEffort?: ModelReasoningEffort,
): Promise<SubagentResult> {
  const launchActingUserId = resolveActingUserId(actingUserId);
  let config = resolvedConfig ?? (await getAllSubagentConfigs())[type];

  if (!config) {
    return {
      agentId: "",
      report: "",
      success: false,
      error: `Unknown subagent type: ${type}`,
    };
  }

  const isDeployingExisting = Boolean(
    existingAgentId || existingConversationId,
  );

  const activeBackend = getBackend();
  const backendMode: BackendMode = activeBackend.capabilities.localMemfs
    ? "local"
    : "api";
  // Resolve parent scope before model selection so local subagents inherit the
  // active conversation's model override, not just the agent default.
  let resolvedParentAgentId = parentAgentId;
  if (!resolvedParentAgentId) {
    try {
      resolvedParentAgentId = getCurrentAgentId();
    } catch {
      // Context unavailable — carry forward undefined.
    }
  }
  let resolvedParentConversationId = parentConversationId;
  if (!resolvedParentConversationId) {
    try {
      resolvedParentConversationId = getConversationId() ?? undefined;
    } catch {
      // Context unavailable — carry forward undefined.
    }
  }
  const { handle: parentModelHandle, agent: parentAgent } =
    await getPrimaryAgentModelHandle({
      agentId: resolvedParentAgentId,
      conversationId: resolvedParentConversationId,
    });
  const formatConfig = resolveSubagentConfigForMemoryFormat(
    config,
    resolvedParentAgentId
      ? detectMemoryFormat(
          getScopedMemoryFilesystemRoot(resolvedParentAgentId),
          activeBackend.capabilities.localMemfs,
        )
      : "memfs-v1",
    activeBackend.capabilities.localMemfs,
  );
  const effectiveSystemPromptOverride =
    systemPromptOverride ??
    (formatConfig.systemPrompt !== config.systemPrompt
      ? formatConfig.systemPrompt
      : undefined);
  config = formatConfig;
  const billingTier = await getCurrentBillingTier();

  // For existing agents, don't override model; for new agents, use provided or config default
  const model = isDeployingExisting
    ? null
    : await resolveSubagentModel({
        userModel,
        recommendedModel: config.recommendedModel,
        recommendedModelSource: config.recommendedModelSource,
        parentModelHandle,
        billingTier,
        subagentType: type,
        backendMode,
      });
  // Build the prompt with system reminder for deployed agents
  let finalPrompt = prompt;
  if (
    (type !== "custom" || forkedContext) &&
    isDeployingExisting &&
    resolvedParentAgentId
  ) {
    try {
      const cachedParent =
        parentAgent ??
        (await getBackend().retrieveAgent(resolvedParentAgentId));
      if (forkedContext) {
        const systemReminder = buildForkSystemReminder(type, backendMode);
        finalPrompt = systemReminder + prompt;
      } else if (
        shouldPrependDeploySystemReminder(
          existingAgentId,
          resolvedParentAgentId,
        )
      ) {
        const systemReminder = buildDeploySystemReminder(
          cachedParent.name ?? "",
          resolvedParentAgentId,
        );
        finalPrompt = systemReminder + prompt;
      }
    } catch {
      // If we can't get parent agent info, proceed without the reminder
    }
  }

  // Fork subagents (e.g. recall) deploy the parent agent into a forked
  // conversation. They don't emit an init event carrying agent_id/
  // conversation_id (which is the usual source of agentURL), so without this
  // the card would have no link and any fallback would route to the parent's
  // main conversation. Set the link eagerly to the forked conversation so it
  // opens the subagent's own thread instead.
  if ((forkedContext || type === "custom") && existingConversationId) {
    const forkAgentURL = existingAgentId
      ? buildAgentReference(existingAgentId, {
          conversationId: existingConversationId,
        })
      : undefined;
    updateSubagent(subagentId, {
      agentId: existingAgentId,
      agentURL: forkAgentURL,
      conversationId: existingConversationId,
    });
  }

  // Execute subagent - state updates are handled via the state store
  const result = await executeSubagent(
    type,
    config,
    model,
    finalPrompt,
    subagentId,
    false,
    signal,
    existingAgentId,
    existingConversationId,
    maxTurns,
    resolvedParentAgentId,
    transcriptPath,
    memoryScope,
    effectiveSystemPromptOverride,
    environment,
    launchActingUserId,
    parentAgent?.name,
    resolvedParentConversationId,
    clientMessageId,
    reasoningEffort,
  );

  return result;
}

export function spawnSubagent(
  ...args: Parameters<typeof spawnSubagentInContext>
): Promise<SubagentResult> {
  // A background child keeps its launch directory even if its parent changes
  // worktrees while model/configuration lookup is still awaiting I/O.
  return runWithRuntimeContext(
    { ...getRuntimeContext(), workingDirectory: getCurrentWorkingDirectory() },
    () => spawnSubagentInContext(...args),
  );
}
