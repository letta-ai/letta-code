import { rmSync } from "node:fs";
import { platform } from "node:os";
import { getConversationId } from "@/agent/context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { detectMemoryFormat } from "@/agent/memory-format";
import { getSubagents, updateSubagent } from "@/agent/subagent-state.js";
import { wrapSubagentLauncher } from "@/agent/subagents/sandbox";
import { getSessionAccessToken } from "@/auth/org-credentials-session";
import {
  type BackendMode,
  getBackend,
  getLocalBackendStorageDir,
} from "@/backend";
import {
  type AgentSandboxOptions,
  SUBAGENT_CLOUD_OPTIONS_ENV,
} from "@/backend/api/environments";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import { INTERRUPTED_BY_USER } from "@/constants";
import { cliPermissions } from "@/permissions/cli-permissions-instance";
import { resolveAllowedMemoryRoots } from "@/permissions/memory-paths";
import { sessionPermissions } from "@/permissions/session";
import {
  getCurrentWorkingDirectory,
  getRuntimeActingUserId,
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
import {
  getEffectiveAgentId,
  resolveEffectiveAgentId,
  shouldRunSubagentEphemerally,
} from "./ephemeral-subagent";
import { allocateSubagentName } from "./names";
import { collectRemoteTurnResult } from "./remote-turn-wait";
import { resolveSubagentHarnessTools } from "./subagent-depth";
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
  buildDeploySystemReminder,
  buildForkSystemReminder,
  shouldPrependDeploySystemReminder,
} from "./subagent-reminders";
import {
  describeSubagentExit,
  type ExecutionState,
  flushPendingProgressText,
  hasSuccessfulToolCall,
  looksLikeTruncatedStreamJson,
  parseResultFromStdout,
  processStreamEvent,
} from "./subagent-stream";

const NO_BASE_TOOL_SUBAGENT_TYPES = new Set(["reflection", "memory", "init"]);

function isProviderNotSupportedError(errorOutput: string): boolean {
  return (
    errorOutput.includes("Provider") &&
    errorOutput.includes("is not supported") &&
    errorOutput.includes("supported providers:")
  );
}

interface BuildSubagentArgsOptions {
  backendMode?: BackendMode;
  promptTransport?: "argv" | "stdin";
  platform?: NodeJS.Platform;
  extraTools?: string[];
  parentAgentId?: string | null;
  systemPromptOverride?: string;
  environment?: string;
  clientMessageId?: string;
  ephemeral?: boolean;
}

export function buildSubagentArgs(
  type: string,
  config: SubagentConfig,
  model: string | null,
  userPrompt: string,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
  options: BuildSubagentArgsOptions = {},
): string[] {
  const args: string[] = [];
  const runtimePlatform = options.platform ?? platform();
  const isDeployingExisting = Boolean(
    existingAgentId || existingConversationId,
  );

  if (options.backendMode) {
    args.push("--backend", options.backendMode);
  }

  if (options.clientMessageId !== undefined)
    args.push("--client-message-id", options.clientMessageId);

  if (options.environment) {
    args.push("--computer", options.environment, "--no-wait");
  }

  if (isDeployingExisting) {
    if (existingConversationId) {
      if (existingConversationId === "default" && existingAgentId) {
        args.push("--agent", existingAgentId);
      }
      args.push("--conv", existingConversationId);
    } else if (existingAgentId) {
      args.push("--agent", existingAgentId, "--new");
    }
  } else {
    args.push(options.ephemeral ? "--ephemeral" : "--new-agent");
    if (options.systemPromptOverride) {
      args.push("--system-custom", options.systemPromptOverride);
    } else {
      args.push("--system", type);
    }
    if (!options.ephemeral) {
      const subagentTags = [`type:${type}`];
      if (options.parentAgentId) {
        subagentTags.push(`parent:${options.parentAgentId}`);
      }
      args.push("--tags", subagentTags.join(","));
    }
    if (model) {
      args.push("--model", model);
    }

    if (type === "reflection" && runtimePlatform !== "win32") {
      args.push("--no-system-info-reminder");
    }
    if (type === "reflection" || type === "memory") {
      args.push("--no-skills");
    }

    if (NO_BASE_TOOL_SUBAGENT_TYPES.has(type) && !options.ephemeral) {
      args.push("--base-tools", "none");
    }
  }

  if (options.promptTransport !== "stdin") {
    args.push("-p", buildSubagentPrompt(type, config, userPrompt));
  }
  args.push("--output-format", "stream-json");
  args.push("--permission-mode", "unrestricted");

  const parentAllowedTools = cliPermissions.getAllowedTools();
  const sessionAllowRules = sessionPermissions.getRules().allow || [];
  const subagentTools =
    config.allowedTools !== "all" && Array.isArray(config.allowedTools)
      ? config.allowedTools
      : [];
  const combinedAllowedTools = [
    ...new Set([...parentAllowedTools, ...sessionAllowRules, ...subagentTools]),
  ];
  if (combinedAllowedTools.length > 0) {
    args.push("--allowedTools", combinedAllowedTools.join(","));
  }

  const parentDisallowedTools = cliPermissions.getDisallowedTools();
  if (parentDisallowedTools.length > 0) {
    args.push("--disallowedTools", parentDisallowedTools.join(","));
  }

  if (
    config.allowedTools !== "all" &&
    Array.isArray(config.allowedTools) &&
    config.allowedTools.length > 0
  ) {
    const scopedTools = Array.from(
      new Set([...(config.allowedTools ?? []), ...(options.extraTools ?? [])]),
    );
    args.push("--tools", scopedTools.join(","));
  }

  if (maxTurns !== undefined && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (config.skills.length > 0) {
    args.push("--pre-load-skills", config.skills.join(","));
  }

  return args;
}

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
  actingUserIdOverride?: string | null,
  parentAgentName?: string | null,
  parentConversationId?: string,
  clientMessageId?: string,
  cloudOptions?: AgentSandboxOptions,
): Promise<SubagentResult> {
  const withModel = (result: SubagentResult): SubagentResult =>
    model ? { ...result, model } : result;

  if (signal?.aborted) {
    return withModel({
      agentId: "",
      report: "",
      success: false,
      error: INTERRUPTED_BY_USER,
    });
  }

  if (model) {
    updateSubagent(subagentId, { model });
  }

  try {
    const activeBackend = getBackend();
    const backendMode: BackendMode = activeBackend.capabilities.localMemfs
      ? "local"
      : "api";
    const boundedUserPrompt = buildSubagentPrompt(type, config, userPrompt);

    let parentAgentId = resolveEffectiveAgentId(parentAgentIdOverride);
    if (!parentAgentId) {
      try {
        parentAgentId = getEffectiveAgentId();
      } catch {}
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
        extraTools: resolveSubagentHarnessTools(type, config),
        parentAgentId,
        systemPromptOverride,
        environment,
        clientMessageId,
        ephemeral: shouldRunSubagentEphemerally({
          backendMode,
          existingAgentId,
          existingConversationId,
          environment,
        }),
      },
    );

    const launcher = resolveSubagentLauncher(cliArgs);

    const settings = await settingsManager.getSettingsWithSecureTokens();
    const inheritedApiKey =
      (await getSessionAccessToken()) ||
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
      subagentSummary:
        existingAgentId || existingConversationId
          ? undefined
          : getSubagents().find((agent) => agent.id === subagentId)
              ?.description,
      subagentName:
        existingAgentId || existingConversationId
          ? undefined
          : allocateSubagentName(parentAgentName),
    });

    delete childEnv[SUBAGENT_CLOUD_OPTIONS_ENV];
    if (cloudOptions)
      childEnv[SUBAGENT_CLOUD_OPTIONS_ENV] = JSON.stringify(cloudOptions);

    const sandbox = wrapSubagentLauncher({
      launcher,
      launchProfile: effectiveLaunchProfile,
      backendMode,
      memoryRoots: inheritedMemoryRoots.roots,
      inheritedPrimaryRoot,
      memoryScope,
      localBackendStorageDir,
      scratchpadDir: childEnv.LETTA_SCRATCHPAD,
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

    proc.once("spawn", () => {
      updateSubagent(subagentId, { status: "running" });
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

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

    if (stdoutBuffer.length > 0) {
      processStreamEvent(stdoutBuffer, state, subagentId);
    }
    flushPendingProgressText(state, subagentId);

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

    if (exitCode !== 0) {
      if (
        !isRetry &&
        (type !== "custom" || !existingConversationId) &&
        isProviderNotSupportedError(stderr)
      ) {
        const { handle: primaryModel } = await getPrimaryAgentModelHandle({
          agentId: parentAgentIdOverride,
        });
        if (primaryModel) {
          return executeSubagent(
            type,
            config,
            primaryModel,
            userPrompt,
            subagentId,
            true,
            signal,
            undefined,
            undefined,
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
            cloudOptions,
          );
        }
      }

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
          true,
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
          cloudOptions,
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

    debugWarn(
      "subagent",
      `Subagent ${subagentId} (agentId=${state.agentId}) exited cleanly (exitCode=${exitCode}) ` +
        `but no result event was captured during streaming. ` +
        `stdout=${Buffer.concat(stdoutChunks).length} bytes, stderr=${stderr.length} bytes`,
    );

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
          true,
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
          cloudOptions,
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
  actingUserId?: string | null,
  resolvedConfig?: SubagentConfig,
  clientMessageId?: string,
  cloudOptions?: AgentSandboxOptions,
): Promise<SubagentResult> {
  const launchActingUserId =
    actingUserId !== undefined
      ? actingUserId
      : getRuntimeContext()?.suppressActingUserFallback
        ? null
        : getRuntimeActingUserId();
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
  let resolvedParentAgentId = resolveEffectiveAgentId(parentAgentId);
  if (!resolvedParentAgentId) {
    try {
      resolvedParentAgentId = getEffectiveAgentId();
    } catch {}
  }
  let resolvedParentConversationId = parentConversationId;
  if (!resolvedParentConversationId) {
    try {
      resolvedParentConversationId = getConversationId() ?? undefined;
    } catch {}
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
    } catch {}
  }

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

  return executeSubagent(
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
    cloudOptions,
  );
}

export function spawnSubagent(
  ...args: Parameters<typeof spawnSubagentInContext>
): Promise<SubagentResult> {
  return runWithRuntimeContext(
    { ...getRuntimeContext(), workingDirectory: getCurrentWorkingDirectory() },
    () => spawnSubagentInContext(...args),
  );
}
