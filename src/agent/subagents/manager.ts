/**
 * Subagent manager for spawning and coordinating subagents
 *
 * This module handles:
 * - Spawning subagents via letta CLI in headless mode
 * - Executing subagents and collecting final reports
 * - Managing parallel subagent execution
 */

import { spawn } from "node:child_process";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import recallSubagentPrompt from "@/agent/prompts/recall_subagent.md";
import recallSubagentLocalPrompt from "@/agent/prompts/recall_subagent_local.md";
import { updateSubagent } from "@/agent/subagent-state.js";
import { wrapSubagentLauncher } from "@/agent/subagents/sandbox";
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
import { cliPermissions } from "@/permissions/cli-permissions-instance";
import { resolveAllowedMemoryRoots } from "@/permissions/memory-paths";
import { sessionPermissions } from "@/permissions/session";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
} from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { debugLog, debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import {
  getAllSubagentConfigs,
  type SubagentConfig,
  type SubagentMemoryScope,
  type SubagentResult,
} from ".";
import {
  estimateStartupContextTokens,
  REFLECTION_STARTUP_CONTEXT_CHAR_LIMIT,
  REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT,
} from "./context-budget";
import {
  buildInheritedChannelContextPayload,
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
import {
  type ExecutionState,
  parseResultFromStdout,
  processStreamEvent,
} from "./subagent-stream";

// ============================================================================
// Constants
// ============================================================================

/**
 * Subagent types that don't need server-side base tools (web_search,
 * fetch_webpage). These agents operate on local memory/git state and have
 * no use for internet access. Spawning them with `--base-tools none`
 * keeps their tool list minimal.
 *
 * fork/recall are excluded because they deploy the parent agent and
 * never trigger fresh agent creation, so base tools are out of scope.
 */
const NO_BASE_TOOL_SUBAGENT_TYPES = new Set([
  "reflection",
  "memory",
  "history-analyzer",
  "init",
]);

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

function getReflectionStartupNotice(): string {
  return `[Reflection startup context truncated: system prompt + initial message are capped at ~${REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT.toLocaleString()} estimated tokens. Some parent memory preview content was omitted; read files directly from MEMORY_DIR if needed.]`;
}

function buildMinimalParentMemorySection(maxChars: number): string {
  const notice = getReflectionStartupNotice();
  const section = `<parent_memory>\n${notice}\n</parent_memory>`;
  if (section.length <= maxChars) {
    return section;
  }
  return section.slice(0, Math.max(0, maxChars));
}

function shrinkParentMemorySection(section: string, maxChars: number): string {
  const notice = getReflectionStartupNotice();
  const treeMatch = section.match(
    /<memory_filesystem>[\s\S]*?<\/memory_filesystem>/,
  );
  const prefix = "<parent_memory>\n";
  const suffix = "\n</parent_memory>";

  const tree = treeMatch?.[0];
  if (tree) {
    const candidate = `${prefix}${tree}\n${notice}${suffix}`;
    if (candidate.length <= maxChars) {
      return candidate;
    }
  }

  return buildMinimalParentMemorySection(maxChars);
}

function hardTruncateReflectionPrompt(
  prompt: string,
  maxChars: number,
): string {
  const notice = `\n${getReflectionStartupNotice()}`;
  if (maxChars <= notice.length) {
    return notice.slice(0, Math.max(0, maxChars));
  }
  return `${prompt.slice(0, maxChars - notice.length).trimEnd()}${notice}`;
}

function capReflectionStartupPrompt(
  type: string,
  systemPrompt: string,
  userPrompt: string,
): string {
  if (type !== "reflection") {
    return userPrompt;
  }

  const estimatedTokens = estimateStartupContextTokens(
    `${systemPrompt}\n${userPrompt}`,
  );
  if (estimatedTokens <= REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT) {
    return userPrompt;
  }

  const allowedPromptChars = Math.max(
    0,
    REFLECTION_STARTUP_CONTEXT_CHAR_LIMIT - systemPrompt.length - 1,
  );
  const parentMemoryMatch = userPrompt.match(
    /<parent_memory>[\s\S]*?<\/parent_memory>/,
  );

  if (parentMemoryMatch?.index !== undefined) {
    const start = parentMemoryMatch.index;
    const end = start + parentMemoryMatch[0].length;
    const outsideChars = userPrompt.length - parentMemoryMatch[0].length;
    const parentMemoryBudget = Math.max(0, allowedPromptChars - outsideChars);
    const replacement = shrinkParentMemorySection(
      parentMemoryMatch[0],
      parentMemoryBudget,
    );
    const candidate = `${userPrompt.slice(0, start)}${replacement}${userPrompt.slice(end)}`;
    if (candidate.length <= allowedPromptChars) {
      return candidate;
    }
  }

  return hardTruncateReflectionPrompt(userPrompt, allowedPromptChars);
}

export function buildSubagentPrompt(
  type: string,
  config: SubagentConfig,
  userPrompt: string,
): string {
  return capReflectionStartupPrompt(type, config.systemPrompt, userPrompt);
}

interface BuildSubagentArgsOptions {
  backendMode?: BackendMode;
  promptTransport?: "argv" | "stdin";
  extraTools?: string[];
  parentAgentId?: string | null;
  /**
   * Replace the subagent's configured persona: pass `--system-custom <text>`
   * to the child instead of `--system <type>`. Only applies to new agents.
   */
  systemPromptOverride?: string;
}

/**
 * Build CLI arguments for spawning a subagent
 */
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
  const isDeployingExisting = Boolean(
    existingAgentId || existingConversationId,
  );

  if (options.backendMode) {
    args.push("--backend", options.backendMode);
  }

  if (isDeployingExisting) {
    // Deploy existing agent/conversation
    if (existingConversationId) {
      // conversation_id is sufficient (headless derives agent from it)
      args.push("--conv", existingConversationId);
    } else if (existingAgentId) {
      // agent_id only - use --new to create a new conversation for thread safety
      // (multiple parallel calls to the same agent need separate conversations)
      args.push("--agent", existingAgentId, "--new");
    }
    // Don't pass --system (existing agent keeps its prompt)
    // Don't pass --model (existing agent keeps its model)
  } else {
    // Create new agent (original behavior). A systemPromptOverride replaces the
    // configured persona with a caller-supplied prompt via `--system-custom`
    // (mutually exclusive with `--system`).
    if (options.systemPromptOverride) {
      args.push("--new-agent", "--system-custom", options.systemPromptOverride);
    } else {
      args.push("--new-agent", "--system", type);
    }
    const subagentTags = [`type:${type}`];
    if (options.parentAgentId) {
      subagentTags.push(`parent:${options.parentAgentId}`);
    }
    args.push("--tags", subagentTags.join(","));
    // Newly spawned subagents are stateless (non-memfs). The headless
    // entrypoint derives this from LETTA_CODE_AGENT_ROLE=subagent — no CLI
    // flag needed, and no user-facing opt-out exists.
    if (model) {
      args.push("--model", model);
    }

    // Reflection-specific startup flags: match the memory_reflection training
    // env so the trained policy sees identical prompt suffixes and skill
    // availability at inference time as it did during training.
    if (type === "reflection") {
      args.push("--no-system-info-reminder");
      args.push("--no-skills");
    }

    // Skip server-side base tools (web_search, fetch_webpage) for subagents
    // that operate purely on local memory/git state.
    if (NO_BASE_TOOL_SUBAGENT_TYPES.has(type)) {
      args.push("--base-tools", "none");
    }
  }

  if (options.promptTransport !== "stdin") {
    args.push("-p", buildSubagentPrompt(type, config, userPrompt));
  }
  args.push("--output-format", "stream-json");
  args.push("--permission-mode", "unrestricted");

  // Build list of auto-approved tools:
  // 1. Inherit from parent (CLI + session rules)
  // 2. Add subagent's allowed tools (so they don't hang on approvals)
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

  // Add tool filtering if specified (applies to both new and existing agents)
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

  // Add max turns limit if specified
  if (maxTurns !== undefined && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  // Pre-load skills specified in the subagent config
  if (config.skills.length > 0) {
    args.push("--pre-load-skills", config.skills.join(","));
  }

  return args;
}

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
): Promise<SubagentResult> {
  // Check if already aborted before starting
  if (signal?.aborted) {
    return {
      agentId: "",
      report: "",
      success: false,
      error: INTERRUPTED_BY_USER,
    };
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
    const runtimeContext = getRuntimeContext();
    const inheritedChannelContext =
      buildInheritedChannelContextPayload(runtimeContext);
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
        extraTools:
          config.fork && inheritedChannelContext
            ? ["MessageChannel"]
            : undefined,
        systemPromptOverride,
      },
    );

    const launcher = resolveSubagentLauncher(cliArgs);

    // Resolve auth once in parent and forward to child to avoid per-subagent
    // keychain lookups under high parallel fan-out.
    const settings = await settingsManager.getSettingsWithSecureTokens();
    const inheritedApiKey =
      process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
    const inheritedBaseUrl =
      process.env.LETTA_BASE_URL || settings.env?.LETTA_BASE_URL;
    const inheritedMemoryRoots = resolveAllowedMemoryRoots({
      currentAgentId: parentAgentId ?? null,
    });
    const localBackendStorageDir =
      backendMode === "local" ? getLocalBackendStorageDir() : null;
    const inheritedPrimaryRoot = resolveSubagentInheritedPrimaryRoot({
      backendMode,
      parentAgentId,
      inheritedPrimaryRoot: inheritedMemoryRoots.primaryRoot,
      localBackendStorageDir,
    });
    const subagentWorkingDirectory = resolveSubagentWorkingDirectory(
      process.env,
      getCurrentWorkingDirectory(),
      {
        subagentType: type,
        launchProfile: config.launchProfile,
        inheritedPrimaryRoot,
        memoryScope,
      },
    );
    const childEnv = composeSubagentChildEnv({
      parentProcessEnv: {
        ...process.env,
        USER_CWD: subagentWorkingDirectory,
      },
      backendMode,
      localBackendStorageDir,
      parentAgentId,
      launchProfile: config.launchProfile,
      inheritedPrimaryRoot,
      memoryScope,
      inheritedApiKey,
      inheritedBaseUrl,
      transcriptPath,
      inheritedChannelContext,
    });

    // Optionally confine subagents with the memory-subagent profile to an OS filesystem sandbox.
    // Returns null (spawn unchanged) when disabled, not applicable, or no
    // backend is available on this host.
    const sandbox = wrapSubagentLauncher({
      launcher,
      launchProfile: config.launchProfile,
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

    const proc = spawn(spawnLauncher.command, spawnLauncher.args, {
      cwd: subagentWorkingDirectory,
      env: spawnEnv,
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(boundedUserPrompt);

    // Consider execution "running" once the child process has successfully spawned.
    // This avoids waiting on subagent init events (e.g. agentURL) to reflect progress.
    proc.once("spawn", () => {
      updateSubagent(subagentId, { status: "running" });
    });

    // Set up abort handler to kill the child process
    let wasAborted = false;
    const abortHandler = () => {
      wasAborted = true;
      proc.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abortHandler);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Initialize execution state
    const state: ExecutionState = {
      agentId: existingAgentId || null,
      conversationId: existingConversationId || null,
      finalResult: null,
      finalError: null,
      resultStats: null,
      displayedToolCalls: new Set(),
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
    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on("close", resolve);
      proc.on("error", () => resolve(null));
    });

    // Ensure the trailing partial line is processed before completing.
    // Without this, late tool events can be dropped before Task marks completion.
    if (stdoutBuffer.length > 0) {
      processStreamEvent(stdoutBuffer, state, subagentId);
    }

    // Clean up abort listener
    signal?.removeEventListener("abort", abortHandler);

    // Check if process was aborted by user
    if (wasAborted) {
      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: INTERRUPTED_BY_USER,
      };
    }

    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

    // Handle non-zero exit code
    if (exitCode !== 0) {
      // Check if this is a provider-not-supported error and we haven't retried yet
      if (!isRetry && isProviderNotSupportedError(stderr)) {
        const { handle: primaryModel } = await getPrimaryAgentModelHandle({
          agentId: parentAgentIdOverride,
        });
        if (primaryModel) {
          // Retry with the primary agent's model
          return executeSubagent(
            type,
            config,
            primaryModel,
            userPrompt,
            subagentId,
            true, // Mark as retry to prevent infinite loops
            signal,
            undefined, // existingAgentId
            undefined, // existingConversationId
            maxTurns,
            parentAgentIdOverride,
            transcriptPath,
          );
        }
      }

      const propagatedError = state.finalError?.trim();
      const fallbackError = stderr || `Subagent exited with code ${exitCode}`;

      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: propagatedError || fallbackError,
      };
    }

    // Return captured result if available
    if (state.finalResult !== null) {
      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: state.finalResult,
        success: !state.finalError,
        error: state.finalError || undefined,
        totalTokens: state.resultStats?.totalTokens,
        stepCount: state.resultStats?.stepCount,
        durationMs: state.resultStats?.durationMs,
      };
    }

    // Return error if captured
    if (state.finalError) {
      debugWarn(
        "subagent",
        `Subagent ${subagentId} (agentId=${state.agentId}) exited with captured error: ${state.finalError}. ` +
          `exitCode=${exitCode}, stderr=${stderr.length} bytes`,
      );
      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: state.finalError,
        totalTokens: state.resultStats?.totalTokens,
        stepCount: state.resultStats?.stepCount,
        durationMs: state.resultStats?.durationMs,
      };
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
    }
    return result;
  } catch (error) {
    return {
      agentId: "",
      report: "",
      success: false,
      error: getErrorMessage(error),
    };
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

Your toolset is limited to Bash, Read, and TaskOutput. You cannot edit files, run skills, dispatch further tasks, or take any action beyond searching messages and returning a report.

You CANNOT ask questions mid-execution — all instructions are provided upfront.
Your final message will be returned to the caller.

${recallPrompt}
${SYSTEM_REMINDER_CLOSE}

`;
  }

  return `${SYSTEM_REMINDER_OPEN}
You have been forked from the primary conversational thread to run as an independent subagent. The fork only exists so you can see the parent agent's conversation trajectory in-context as reference — you are NOT the primary agent and do not share its full toolset.

**Your sole task is the one described in the user message below. Ignore any existing ongoing tasks from the inherited trajectory.** Do not attempt to continue, finish, or act on anything the primary agent was in the middle of doing.

You have a scoped toolset that may differ from the primary agent's. Stay within it; don't assume you have the primary's full tool access.

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
export async function spawnSubagent(
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
): Promise<SubagentResult> {
  const allConfigs = await getAllSubagentConfigs();
  const config = allConfigs[type];

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
  const billingTier = await getCurrentBillingTier();

  // For existing agents, don't override model; for new agents, use provided or config default
  const model = isDeployingExisting
    ? null
    : await resolveSubagentModel({
        userModel,
        recommendedModel: config.recommendedModel,
        parentModelHandle,
        billingTier,
        subagentType: type,
        backendMode,
      });
  // Build the prompt with system reminder for deployed agents
  let finalPrompt = prompt;
  if (isDeployingExisting && resolvedParentAgentId) {
    try {
      const cachedParent =
        parentAgent ??
        (await getBackend().retrieveAgent(resolvedParentAgentId));
      if (forkedContext) {
        const systemReminder = buildForkSystemReminder(type, backendMode);
        finalPrompt = systemReminder + prompt;
      } else {
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
  if (forkedContext && existingAgentId && existingConversationId) {
    const forkAgentURL = buildAgentReference(existingAgentId, {
      conversationId: existingConversationId,
    });
    updateSubagent(subagentId, {
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
    systemPromptOverride,
  );

  return result;
}
