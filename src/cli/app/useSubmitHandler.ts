// src/cli/app/useSubmitHandler.ts

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { useCallback } from "react";
import type { ApprovalResult } from "../../agent/approval-execution";
import {
  buildFreshDenialApprovals,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
} from "../../agent/approval-recovery";
import { getResumeDataFromBackend } from "../../agent/check-approval";
import {
  applySetMaxContext,
  formatSetMaxContextResult,
} from "../../agent/maxContext";
import { ISOLATED_BLOCK_LABELS } from "../../agent/memory";
import {
  ensureMemoryFilesystemDirs,
  getScopedMemoryFilesystemRoot,
} from "../../agent/memoryFilesystem";
import { detectPersonalityFromPersonaFile } from "../../agent/personality";
import { recordSessionEnd } from "../../agent/sessionHistory";
import { getBackend } from "../../backend";
import { getAgentContextOverview } from "../../backend/api/agents";
import { getClient } from "../../backend/api/client";
import { getBalanceMetadata } from "../../backend/api/metadata";
import {
  DEFAULT_SUMMARIZATION_MODEL,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "../../constants";
import {
  runPreCompactHooks,
  runSessionStartHooks,
  runUserPromptSubmitHooks,
} from "../../hooks";
import { permissionMode } from "../../permissions/mode";
import { DEFAULT_COMPLETION_PROMISE, ralphMode } from "../../ralph/mode";
import { buildSharedReminderParts } from "../../reminders/engine";
import { getPlanModeReminder } from "../../reminders/planModeReminder";
import { syncReminderStateFromContextTracker } from "../../reminders/state";
import { settingsManager } from "../../settings-manager";
import { telemetry } from "../../telemetry";
import { debugLog, debugWarn } from "../../utils/debug";
import {
  handleMcpAdd,
  type McpCommandContext,
  setActiveCommandId as setActiveMcpCommandId,
} from "../commands/mcp";
import {
  addCommandResult,
  handlePin,
  handleProfileDelete,
  handleProfileSave,
  handleProfileUsage,
  handleUnpin,
  type ProfileCommandContext,
  setActiveCommandId as setActiveProfileCommandId,
  validateProfileLoad,
} from "../commands/profile";
import { validateAgentName } from "../components/PinDialog";
import { formatUsageStats } from "../components/SessionStats";
import { toLines } from "../helpers/accumulator";
import { buildChatUrl } from "../helpers/appUrls";
import { backfillBuffers } from "../helpers/backfill";
import {
  type ContextWindowOverview,
  renderContextUsage,
} from "../helpers/contextChart";
import { resetContextHistory } from "../helpers/contextTracker";
import { formatErrorDetails } from "../helpers/errorFormatter";
import {
  buildDoctorMessage,
  buildInitMessage,
  gatherInitGitContext,
} from "../helpers/initCommand";
import { buildLogoutSuccessMessage } from "../helpers/logoutMessage";
import { getReflectionSettings } from "../helpers/memoryReminder";
import { handleMemorySubagentCompletion } from "../helpers/memorySubagentCompletion";
import {
  buildMessageContentFromDisplay,
  clearPlaceholdersInText,
} from "../helpers/pasteRegistry";
import { generatePlanFilePath } from "../helpers/planName";
import { resolveReasoningTabToggleCommand } from "../helpers/reasoningTabToggle";
import {
  buildAutoReflectionPayload,
  buildParentMemorySnapshot,
  buildReflectionSubagentPrompt,
  finalizeAutoReflectionPayload,
} from "../helpers/reflectionTranscript";
import {
  resolvePromptChar,
  resolveStatusLineConfig,
} from "../helpers/statusLineConfig";
import { formatStatusLineHelp } from "../helpers/statusLineHelp";
import { buildStatusLinePayload } from "../helpers/statusLinePayload";
import { executeStatusLineCommand } from "../helpers/statusLineRuntime";
import {
  estimateSystemTokens,
  setSystemPromptDoctorState,
} from "../helpers/systemPromptWarning.ts";
import { extractTaskNotificationsForDisplay } from "../helpers/taskNotifications";
import { getRandomThinkingVerb } from "../helpers/thinkingMessages";

import { isInteractiveCommand, isNonStateCommand } from "./commandRouting";
import { AUTO_REFLECTION_DESCRIPTION } from "./constants";
import { buildTextParts } from "./contentParts";
import { appendOptimisticUserLine, createClientOtid, uid } from "./ids";
import {
  buildRalphContinuationReminder,
  buildRalphFirstTurnReminder,
  parseRalphArgs,
} from "./ralph";
import { hasActiveReflectionSubagent } from "./reflection";
import { saveLastSessionBeforeExit } from "./session";
import type { StaticItem } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: the submit router is split mechanically from the coordinator and keeps legacy closure types until follow-up narrowing.
type SubmitHandlerContext = Record<string, any>;

export function useSubmitHandler(ctx: SubmitHandlerContext) {
  const {
    abortControllerRef,
    agentDescription,
    agentId,
    agentIdRef,
    agentLastRunAt,
    agentName,
    agentState,
    agentStateRef,
    appendTaskNotificationEvents,
    bashCommandCacheRef,
    buffersRef,
    cacheLastPlanFilePath,
    checkPendingApprovalsForSlashCommand,
    chromeColumns,
    commandRunner,
    commandRunning,
    consumeQueuedApprovalInputForCurrentConversation,
    contextTrackerRef,
    conversationGenerationRef,
    conversationId,
    conversationIdRef,
    currentModelDisplay,
    currentModelHandle,
    currentModelId,
    currentModelLabel,
    currentModelProvider,
    currentReasoningEffort,
    currentSystemPromptId,
    currentToolset,
    effectiveContextWindowSize,
    emittedIdsRef,
    firstUserQueryRef,
    flushPendingReasoningEffort,
    generateConversationTitle,
    handleAgentSelect,
    handleBtwCommand,
    handleExit,
    hasBackfilledRef,
    isAgentBusy,
    isExecutingTool,
    lastRunIdRef,
    llmConfigRef,
    maybeCarryOverActiveConversationModel,
    needsEagerApprovalCheck,
    networkPhase,
    openTrajectorySegment,
    overrideContentPartsRef,
    pendingApprovals,
    pendingConversationSwitchRef,
    pendingGitReminderRef,
    pendingRalphConfig,
    processConversation,
    processConversationWithQueuedApprovals,
    profileConfirmPending,
    projectDirectory,
    queuedApprovalResults,
    queuedSystemPromptRecompileByConversationRef,
    reasoningTabCycleEnabled,
    recoverRestoredPendingApprovals,
    refreshDerived,
    resetBootstrapReminderState,
    resetDeferredToolCallCommits,
    resetPendingReasoningCycle,
    resetTrajectoryBases,
    runEndHooks,
    sessionHooksRanRef,
    sessionStartFeedbackRef,
    sessionStatsRef,
    setActiveOverlay,
    setAgentDescription,
    setAgentState,
    setCommandRunning,
    setConversationAutoTitleEligibility,
    setConversationIdAndRef,
    setConversationOverrideContextWindowLimit,
    setConversationOverrideModelSettings,
    setCurrentPersonalityId,
    setDequeueEpoch,
    setFeedbackPrefill,
    setHasConversationModelOverride,
    setLines,
    setLlmConfig,
    setModelSelectorOptions,
    setNeedsEagerApprovalCheck,
    setPendingRalphConfig,
    setPinDialogLocal,
    setProfileConfirmPending,
    setReasoningTabCycleEnabled,
    setSearchQuery,
    setStaticItems,
    setStaticRenderEpoch,
    setStreaming,
    setThinkingMessage,
    setTokenStreamingEnabled,
    setTrajectoryTokenBase,
    setUiPermissionMode,
    setUiRalphActive,
    sharedReminderStateRef,
    shouldAutoGenerateConversationTitleRef,
    startOverlayCommand,
    streaming,
    systemInfoReminderEnabled,
    systemPromptRecompileByConversationRef,
    tokenStreamingEnabled,
    trajectoryRunTokenStartRef,
    trajectoryTokenDisplayRef,
    triggerStatusLineRefresh,
    tuiQueueRef,
    uiPermissionMode,
    updateAgentName,
    updateMemorySyncCommand,
    userCancelledRef,
  } = ctx;

  // biome-ignore lint/correctness/useExhaustiveDependencies: moved from AppCoordinator; dependencies are preserved from the original callback.
  const onSubmit = useCallback(
    async (message?: string): Promise<{ submitted: boolean }> => {
      const msg = message?.trim() ?? "";
      const overrideContentParts = overrideContentPartsRef.current;
      const hasOverrideContent = overrideContentParts !== null;
      if (overrideContentParts) {
        overrideContentPartsRef.current = null;
      }
      const { notifications: taskNotifications, cleanedText } =
        extractTaskNotificationsForDisplay(msg);
      const userTextForInput = cleanedText.trim();
      const isSystemOnly =
        taskNotifications.length > 0 && userTextForInput.length === 0;

      // Handle profile load confirmation (Enter to continue)
      if (profileConfirmPending && !msg && !hasOverrideContent) {
        // User pressed Enter with empty input - proceed with loading
        const { name, agentId: targetAgentId, cmdId } = profileConfirmPending;
        const cmd = commandRunner.getHandle(cmdId, `/profile load ${name}`);
        cmd.update({ output: "Loading profile...", phase: "running" });
        setProfileConfirmPending(null);
        await handleAgentSelect(targetAgentId, {
          profileName: name,
          commandId: cmdId,
        });
        return { submitted: true };
      }

      // Cancel profile confirmation if user types something else
      if (profileConfirmPending && msg) {
        const { cmdId, name } = profileConfirmPending;
        const cmd = commandRunner.getHandle(cmdId, `/profile load ${name}`);
        cmd.fail("Cancelled");
        setProfileConfirmPending(null);
        // Continue processing the new message
      }

      if (!msg && !hasOverrideContent) return { submitted: false };

      // If the user just cycled reasoning tiers, flush the final choice before
      // sending the next message so the upcoming run uses the selected tier.
      await flushPendingReasoningEffort();

      // Run UserPromptSubmit hooks - can block the prompt from being processed
      const isCommand = userTextForInput.startsWith("/");
      const hookResult = isSystemOnly
        ? { blocked: false, feedback: [] as string[] }
        : await runUserPromptSubmitHooks(
            userTextForInput,
            isCommand,
            agentId,
            conversationIdRef.current,
          );
      if (!isSystemOnly && hookResult.blocked) {
        // Show feedback from hook in the transcript
        const feedbackId = uid("status");
        const feedback = hookResult.feedback.join("\n") || "Blocked by hook";
        buffersRef.current.byId.set(feedbackId, {
          kind: "status",
          id: feedbackId,
          lines: [
            `<user-prompt-submit-hook>${feedback}</user-prompt-submit-hook>`,
          ],
        });
        buffersRef.current.order.push(feedbackId);
        refreshDerived();
        return { submitted: false };
      }

      // Capture successful hook feedback to inject into agent context
      const userPromptSubmitHookFeedback =
        hookResult.feedback.length > 0
          ? `${SYSTEM_REMINDER_OPEN}\n${hookResult.feedback.join("\n")}\n${SYSTEM_REMINDER_CLOSE}`
          : "";

      // Capture the generation at submission time, BEFORE any async work.
      // This allows detecting if ESC was pressed during async operations.
      const submissionGeneration = conversationGenerationRef.current;

      // Track user input (agent_id automatically added from telemetry.currentAgentId)
      if (!isSystemOnly && userTextForInput.length > 0) {
        telemetry.trackUserInput(
          userTextForInput,
          "user",
          currentModelId || "unknown",
        );
      }

      if (
        shouldAutoGenerateConversationTitleRef.current &&
        firstUserQueryRef.current === null &&
        !isSystemOnly &&
        userTextForInput.length > 0 &&
        !userTextForInput.startsWith("/")
      ) {
        firstUserQueryRef.current = userTextForInput
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100);
      }

      // Block submission if waiting for explicit user action (approvals)
      // In this case, input is hidden anyway, so this shouldn't happen
      if (pendingApprovals.length > 0) {
        return { submitted: false };
      }

      // Queue message if agent is busy (streaming, executing tool, or running command)
      // This allows messages to queue up while agent is working

      // Reset cancellation flag before queue check - this ensures queued messages
      // can be dequeued even if the user just cancelled. The dequeue effect checks
      // userCancelledRef.current, so we must clear it here to prevent blocking.
      userCancelledRef.current = false;

      // If there are queued messages and agent is not busy, bump epoch to trigger
      // dequeue effect. Without this, the effect won't re-run because refs aren't
      // in its deps array (only state values are).
      if (!isAgentBusy() && (tuiQueueRef.current?.length ?? 0) > 0) {
        debugLog(
          "queue",
          `Bumping dequeueEpoch: userCancelledRef was reset, ${tuiQueueRef.current?.length ?? 0} message(s) queued, agent not busy`,
        );
        setDequeueEpoch((e: number) => e + 1);
      }

      const isSlashCommand = userTextForInput.startsWith("/");
      // Interactive/non-state slash commands bypass queueing so menus stay responsive
      // while the agent is busy. Overlay writes are still deferred via queuedOverlayAction.
      const shouldBypassQueue =
        isSlashCommand &&
        (isInteractiveCommand(userTextForInput) ||
          isNonStateCommand(userTextForInput));

      if (isAgentBusy() && isSlashCommand && !shouldBypassQueue) {
        const attemptedCommand = userTextForInput.split(/\s+/)[0] || "/";
        const disabledMessage = `'${attemptedCommand}' is disabled while the agent is running.`;
        const cmd = commandRunner.start(userTextForInput, disabledMessage);
        cmd.fail(disabledMessage);
        return { submitted: true }; // Clears input
      }

      if (isAgentBusy() && !shouldBypassQueue) {
        // Enqueue via QueueRuntime — onEnqueued callback updates queueDisplay.
        tuiQueueRef.current?.enqueue({
          kind: "message",
          source: "user",
          content: msg,
        } as Parameters<typeof tuiQueueRef.current.enqueue>[0]);
        setDequeueEpoch((e: number) => e + 1);
        return { submitted: true }; // Clears input
      }

      // Note: userCancelledRef.current was already reset above before the queue check
      // to ensure the dequeue effect isn't blocked by a stale cancellation flag.

      // Handle pending Ralph config - activate ralph mode but let message flow through normal path
      // This ensures session context and other reminders are included
      // Track if we just activated so we can use first turn reminder vs continuation
      let justActivatedRalph = false;
      if (pendingRalphConfig && !msg.startsWith("/")) {
        const { completionPromise, maxIterations, isYolo } = pendingRalphConfig;
        ralphMode.activate(msg, completionPromise, maxIterations, isYolo);
        setUiRalphActive(true);
        setPendingRalphConfig(null);
        justActivatedRalph = true;
        if (isYolo) {
          permissionMode.setMode("bypassPermissions");
          setUiPermissionMode("bypassPermissions");
        }

        const ralphState = ralphMode.getState();

        // Add status to transcript
        const statusId = uid("status");
        const promiseDisplay = ralphState.completionPromise
          ? `"${ralphState.completionPromise.slice(0, 50)}${ralphState.completionPromise.length > 50 ? "..." : ""}"`
          : "(none)";
        buffersRef.current.byId.set(statusId, {
          kind: "status",
          id: statusId,
          lines: [
            `🔄 ${isYolo ? "yolo-ralph" : "ralph"} mode started (iter 1/${maxIterations || "∞"})`,
            `Promise: ${promiseDisplay}`,
          ],
        });
        buffersRef.current.order.push(statusId);
        refreshDerived();

        // Don't return - let message flow through normal path which will:
        // 1. Add session context reminder (if first message)
        // 2. Add ralph mode reminder (since ralph is now active)
        // 3. Add other reminders (skill unload, memory, etc.)
      }

      let aliasedMsg = msg;
      if (msg === "exit" || msg === "quit") {
        aliasedMsg = "/exit";
      }

      // Handle commands (messages starting with "/")
      if (aliasedMsg.startsWith("/")) {
        const trimmed = aliasedMsg.trim();

        // Special handling for /model command - opens selector
        if (trimmed === "/model") {
          startOverlayCommand(
            "model",
            "/model",
            "Opening model selector...",
            "Models dialog dismissed",
          );
          setModelSelectorOptions({}); // Clear any filters from previous connection
          setActiveOverlay("model");
          return { submitted: true };
        }

        // Special handling for /install-github-app command - interactive setup wizard
        if (trimmed === "/install-github-app") {
          if (getBackend().capabilities.localModelCatalog) {
            const cmd = commandRunner.start(
              trimmed,
              "Checking GitHub App installer support...",
            );
            cmd.fail(
              "GitHub App installation is not supported by the local backend.",
            );
            return { submitted: true };
          }
          startOverlayCommand(
            "install-github-app",
            "/install-github-app",
            "Opening GitHub App installer...",
            "GitHub App installer dismissed",
          );
          setActiveOverlay("install-github-app");
          return { submitted: true };
        }

        // Special handling for /sleeptime command - opens reflection settings
        if (trimmed === "/sleeptime") {
          startOverlayCommand(
            "sleeptime",
            "/sleeptime",
            "Opening sleeptime settings...",
            "Sleeptime settings dismissed",
          );
          setActiveOverlay("sleeptime");
          return { submitted: true };
        }

        // Special handling for /compaction command - opens compaction mode settings
        if (trimmed === "/compaction") {
          startOverlayCommand(
            "compaction",
            "/compaction",
            "Opening compaction settings...",
            "Compaction settings dismissed",
          );
          setActiveOverlay("compaction");
          return { submitted: true };
        }

        // Special handling for /toolset command - opens selector
        if (trimmed === "/toolset") {
          startOverlayCommand(
            "toolset",
            "/toolset",
            "Opening toolset selector...",
            "Toolset dialog dismissed",
          );
          setActiveOverlay("toolset");
          return { submitted: true };
        }

        if (trimmed === "/experiments") {
          startOverlayCommand(
            "experiment",
            "/experiments",
            "Opening experiments selector...",
            "Experiments dialog dismissed",
          );
          setActiveOverlay("experiment");
          return { submitted: true };
        }

        // Special handling for /ade command - open agent in browser
        if (trimmed === "/ade") {
          const adeUrl = buildChatUrl(agentId, {
            conversationId: conversationIdRef.current,
          });

          const cmd = commandRunner.start("/ade", "Opening ADE...");

          // Fire-and-forget browser open
          import("open")
            .then(({ default: open }) => open(adeUrl, { wait: false }))
            .catch(() => {
              // Silently ignore - user can use the URL from the output
            });

          // Always show the URL in case browser doesn't open
          cmd.finish(`Opening ADE...\n→ ${adeUrl}`, true);
          return { submitted: true };
        }

        // Special handling for /system command - opens system prompt selector
        if (trimmed === "/system") {
          startOverlayCommand(
            "system",
            "/system",
            "Opening system prompt selector...",
            "System prompt dialog dismissed",
          );
          setActiveOverlay("system");
          return { submitted: true };
        }

        // Special handling for /personality command - opens personality selector
        if (trimmed === "/personality") {
          startOverlayCommand(
            "personality",
            "/personality",
            "Opening personality selector...",
            "Personality selector dismissed",
          );

          if (settingsManager.isMemfsEnabled(agentId)) {
            try {
              const memoryRoot = getScopedMemoryFilesystemRoot(agentId);
              const personaCandidates = [
                join(memoryRoot, "system", "persona.md"),
                join(memoryRoot, "memory", "system", "persona.md"),
              ];
              const personaPath = personaCandidates.find((candidate) =>
                existsSync(candidate),
              );

              if (personaPath) {
                const personaContent = readFileSync(personaPath, "utf-8");
                setCurrentPersonalityId(
                  detectPersonalityFromPersonaFile(personaContent),
                );
              } else {
                setCurrentPersonalityId(null);
              }
            } catch {
              setCurrentPersonalityId(null);
            }
          } else {
            setCurrentPersonalityId(null);
          }

          setActiveOverlay("personality");
          return { submitted: true };
        }

        // Special handling for /subagents command - opens subagent manager
        if (trimmed === "/subagents") {
          startOverlayCommand(
            "subagent",
            "/subagents",
            "Opening subagent manager...",
            "Subagent manager dismissed",
          );
          setActiveOverlay("subagent");
          return { submitted: true };
        }

        // Special handling for /memory command - opens memory viewer overlay
        if (trimmed === "/memory") {
          startOverlayCommand(
            "memory",
            "/memory",
            "Opening memory viewer...",
            "Memory viewer dismissed",
          );
          setActiveOverlay("memory");
          return { submitted: true };
        }

        // /palace - open Memory Palace directly in the browser (skips TUI overlay)
        if (trimmed === "/palace") {
          const cmd = commandRunner.start(
            "/palace",
            "Opening Memory Palace...",
          );

          if (!settingsManager.isMemfsEnabled(agentId)) {
            cmd.finish(
              "Memory Palace requires memfs. Run /memfs enable first.",
              false,
            );
            return { submitted: true };
          }

          const { generateAndOpenMemoryViewer } = await import(
            "../../web/generate-memory-viewer"
          );
          generateAndOpenMemoryViewer(agentId, {
            agentName: agentName ?? undefined,
            conversationId:
              conversationId !== "default" ? conversationId : undefined,
          })
            .then((result) => {
              if (result.opened) {
                cmd.finish("Opened Memory Palace in browser", true);
              } else {
                cmd.finish(`Open manually: ${result.filePath}`, true);
              }
            })
            .catch((err: unknown) => {
              cmd.finish(
                `Failed to open: ${err instanceof Error ? err.message : String(err)}`,
                false,
              );
            });

          return { submitted: true };
        }

        // Special handling for /mcp command - manage MCP servers
        if (msg.trim().startsWith("/mcp")) {
          const mcpCtx: McpCommandContext = {
            buffersRef,
            refreshDerived,
            setCommandRunning,
          };

          // Check for subcommand by looking at the first word after /mcp
          const afterMcp = msg.trim().slice(4).trim(); // Remove "/mcp" prefix
          const firstWord = afterMcp.split(/\s+/)[0]?.toLowerCase();

          if (
            firstWord !== "help" &&
            !getBackend().capabilities.serverSideToolManagement
          ) {
            const cmd = commandRunner.start(msg, "Checking MCP support...");
            cmd.fail(
              "MCP server management is not supported by the local backend yet.",
            );
            return { submitted: true };
          }

          // /mcp - open MCP server selector
          if (!firstWord) {
            startOverlayCommand(
              "mcp",
              "/mcp",
              "Opening MCP server manager...",
              "MCP dialog dismissed",
            );
            setActiveOverlay("mcp");
            return { submitted: true };
          }

          // /mcp add --transport <type> <name> <url/command> [options]
          if (firstWord === "add") {
            // Pass the full command string after "add" to preserve quotes
            const afterAdd = afterMcp.slice(firstWord.length).trim();
            const cmd = commandRunner.start(msg, "Adding MCP server...");
            setActiveMcpCommandId(cmd.id);
            try {
              await handleMcpAdd(mcpCtx, msg, afterAdd);
            } finally {
              setActiveMcpCommandId(null);
            }
            return { submitted: true };
          }

          // /mcp connect - interactive TUI for connecting with OAuth
          if (firstWord === "connect") {
            startOverlayCommand(
              "mcp-connect",
              "/mcp connect",
              "Opening MCP connect flow...",
              "MCP connect dismissed",
            );
            setActiveOverlay("mcp-connect");
            return { submitted: true };
          }

          // /mcp help - show usage
          if (firstWord === "help") {
            const cmd = commandRunner.start(msg, "Showing MCP help...");
            const output = [
              "/mcp help",
              "",
              "Manage MCP servers.",
              "",
              "USAGE",
              "  /mcp              — open MCP server manager",
              "  /mcp add ...      — add a new server (without OAuth)",
              "  /mcp connect      — interactive wizard with OAuth support",
              "  /mcp help         — show this help",
              "",
              "EXAMPLES",
              "  /mcp add --transport http notion https://mcp.notion.com/mcp",
            ].join("\n");
            cmd.finish(output, true);
            return { submitted: true };
          }

          // Unknown subcommand
          {
            const cmd = commandRunner.start(msg, "Checking MCP usage...");
            cmd.fail(
              `Unknown subcommand: "${firstWord}". Run /mcp help for usage.`,
            );
          }
          return { submitted: true };
        }

        // Special handling for /connect command - opens provider selector
        if (msg.trim() === "/connect") {
          startOverlayCommand(
            "connect",
            "/connect",
            "Opening provider selector...",
            "Connect dialog dismissed",
          );
          setActiveOverlay("connect");
          return { submitted: true };
        }

        // /connect <provider> - direct CLI-style provider flow
        if (msg.trim().startsWith("/connect ")) {
          const cmd = commandRunner.start(msg, "Starting connection...");
          const {
            handleConnect,
            setActiveCommandId: setActiveConnectCommandId,
          } = await import("../commands/connect");
          setActiveConnectCommandId(cmd.id);
          try {
            await handleConnect(
              {
                buffersRef,
                refreshDerived,
                setCommandRunning,
                onCodexConnected: () => {
                  setModelSelectorOptions({
                    filterProvider: "chatgpt-plus-pro",
                    forceRefresh: true,
                  });
                  startOverlayCommand(
                    "model",
                    "/model",
                    "Opening model selector...",
                    "Models dialog dismissed",
                  );
                  setActiveOverlay("model");
                },
              },
              msg,
            );
          } finally {
            setActiveConnectCommandId(null);
          }
          return { submitted: true };
        }

        // Special handling for /disconnect command - remove OAuth connection
        if (msg.trim().startsWith("/disconnect")) {
          const cmd = commandRunner.start(msg, "Disconnecting...");
          const {
            handleDisconnect,
            setActiveCommandId: setActiveConnectCommandId,
          } = await import("../commands/connect");
          setActiveConnectCommandId(cmd.id);
          try {
            await handleDisconnect(
              {
                buffersRef,
                refreshDerived,
                setCommandRunning,
              },
              msg,
            );
          } finally {
            setActiveConnectCommandId(null);
          }
          return { submitted: true };
        }

        // Special handling for /server command (alias: /remote)
        if (
          trimmed === "/server" ||
          trimmed.startsWith("/server ") ||
          trimmed === "/remote" ||
          trimmed.startsWith("/remote ")
        ) {
          // Tokenize with quote support: --name "my laptop"
          const parts = Array.from(
            trimmed.matchAll(
              /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g,
            ),
            (match) => match[1] ?? match[2] ?? match[3],
          );

          let name: string | undefined;
          let _listenAgentId: string | undefined;

          for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            const nextPart = parts[i + 1];
            if (part === "--env-name" && nextPart) {
              name = nextPart;
              i++;
            }
          }

          const cmd = commandRunner.start(msg, "Starting listener...");
          if (!getBackend().capabilities.remoteMemfs) {
            cmd.fail(
              "Remote listener mode is not supported by the local backend.",
            );
            return { submitted: true };
          }

          const { handleListen, setActiveCommandId: setActiveListenCommandId } =
            await import("../commands/listen");
          setActiveListenCommandId(cmd.id);
          try {
            await handleListen(
              {
                buffersRef,
                refreshDerived,
                setCommandRunning,
                agentId,
                conversationId: conversationIdRef.current,
              },
              msg,
              { envName: name },
            );
          } finally {
            setActiveListenCommandId(null);
          }
          return { submitted: true };
        }

        // Special handling for /help command - opens help dialog
        if (trimmed === "/help") {
          startOverlayCommand(
            "help",
            "/help",
            "Opening help...",
            "Help dialog dismissed",
          );
          setActiveOverlay("help");
          return { submitted: true };
        }

        // Special handling for /hooks command - opens hooks manager
        if (trimmed === "/hooks") {
          startOverlayCommand(
            "hooks",
            "/hooks",
            "Opening hooks manager...",
            "Hooks manager dismissed",
          );
          setActiveOverlay("hooks");
          return { submitted: true };
        }

        // Special handling for /statusline command
        if (trimmed === "/statusline" || trimmed.startsWith("/statusline ")) {
          const rawArgs = trimmed.slice("/statusline".length).trim();
          const spaceIdx = rawArgs.indexOf(" ");
          const sub =
            spaceIdx === -1 ? rawArgs || "show" : rawArgs.slice(0, spaceIdx);
          const rest =
            spaceIdx === -1 ? "" : rawArgs.slice(spaceIdx + 1).trim();
          const cmd = commandRunner.start(trimmed, "Managing status line...");

          (async () => {
            try {
              const wd = process.cwd();
              if (sub === "help") {
                cmd.finish(formatStatusLineHelp(), true, true);
              } else if (sub === "show") {
                // Display config from all levels + resolved effective
                const lines: string[] = [];
                try {
                  const global = settingsManager.getSettings().statusLine;
                  lines.push(
                    `Global: ${global?.command ? `command="${global.command}" refreshInterval=${global.refreshIntervalMs ?? "off"} timeout=${global.timeout ?? "default"} debounce=${global.debounceMs ?? "default"} padding=${global.padding ?? 0} disabled=${global.disabled ?? false}` : "(not set)"}`,
                  );
                } catch {
                  lines.push("Global: (unavailable)");
                }
                try {
                  const project =
                    settingsManager.getProjectSettings(wd)?.statusLine;
                  lines.push(
                    `Project: ${project?.command ? `command="${project.command}"` : "(not set)"}`,
                  );
                } catch {
                  lines.push("Project: (not loaded)");
                }
                try {
                  const local =
                    settingsManager.getLocalProjectSettings(wd)?.statusLine;
                  lines.push(
                    `Local: ${local?.command ? `command="${local.command}"` : "(not set)"}`,
                  );
                } catch {
                  lines.push("Local: (not loaded)");
                }
                const effective = resolveStatusLineConfig(wd);
                lines.push(
                  `Effective: ${effective ? `command="${effective.command}" refreshInterval=${effective.refreshIntervalMs ?? "off"} timeout=${effective.timeout}ms debounce=${effective.debounceMs}ms padding=${effective.padding}` : "(inactive)"}`,
                );
                const effectivePrompt = resolvePromptChar(wd);
                lines.push(`Prompt: "${effectivePrompt}"`);
                cmd.finish(lines.join("\n"), true);
              } else if (sub === "set") {
                if (!rest) {
                  cmd.finish("Usage: /statusline set <command> [-l|-p]", false);
                  return;
                }
                const scopeMatch = rest.match(/\s+-(l|p)$/);
                const command = scopeMatch
                  ? rest.slice(0, scopeMatch.index)
                  : rest;
                const isLocal = scopeMatch?.[1] === "l";
                const isProject = scopeMatch?.[1] === "p";
                const config = { command };
                if (isLocal) {
                  settingsManager.updateLocalProjectSettings(
                    { statusLine: config },
                    wd,
                  );
                  cmd.finish(`Status line set (local): ${command}`, true);
                } else if (isProject) {
                  await settingsManager.loadProjectSettings(wd);
                  settingsManager.updateProjectSettings(
                    { statusLine: config },
                    wd,
                  );
                  cmd.finish(`Status line set (project): ${command}`, true);
                } else {
                  settingsManager.updateSettings({ statusLine: config });
                  cmd.finish(`Status line set (global): ${command}`, true);
                }
              } else if (sub === "clear") {
                const isLocal = rest === "-l";
                const isProject = rest === "-p";
                if (isLocal) {
                  settingsManager.updateLocalProjectSettings(
                    { statusLine: undefined },
                    wd,
                  );
                  cmd.finish("Status line cleared (local)", true);
                } else if (isProject) {
                  await settingsManager.loadProjectSettings(wd);
                  settingsManager.updateProjectSettings(
                    { statusLine: undefined },
                    wd,
                  );
                  cmd.finish("Status line cleared (project)", true);
                } else {
                  settingsManager.updateSettings({ statusLine: undefined });
                  cmd.finish("Status line cleared (global)", true);
                }
              } else if (sub === "test") {
                const config = resolveStatusLineConfig(wd);
                if (!config) {
                  cmd.finish("No status line configured", false);
                  return;
                }
                const stats = sessionStatsRef.current.getSnapshot();
                const result = await executeStatusLineCommand(
                  config.command,
                  buildStatusLinePayload({
                    modelId: llmConfigRef.current?.model ?? null,
                    modelDisplayName: currentModelDisplay,
                    reasoningEffort: currentReasoningEffort,
                    systemPromptId: currentSystemPromptId,
                    toolset: currentToolset,
                    currentDirectory: wd,
                    projectDirectory,
                    sessionId: conversationIdRef.current,
                    agentId,
                    agentName,
                    lastRunId: lastRunIdRef.current,
                    totalDurationMs: stats.totalWallMs,
                    totalApiDurationMs: stats.totalApiMs,
                    totalInputTokens: stats.usage.promptTokens,
                    totalOutputTokens: stats.usage.completionTokens,
                    contextWindowSize: effectiveContextWindowSize,
                    usedContextTokens:
                      contextTrackerRef.current.lastContextTokens,
                    stepCount: stats.usage.stepCount,
                    turnCount: sharedReminderStateRef.current.turnCount,
                    reflectionMode: getReflectionSettings(agentId).trigger,
                    reflectionStepCount:
                      getReflectionSettings(agentId).stepCount,
                    memfsEnabled:
                      agentId !== "loading"
                        ? settingsManager.isMemfsEnabled(agentId)
                        : false,
                    memfsDirectory:
                      agentId !== "loading" &&
                      settingsManager.isMemfsEnabled(agentId)
                        ? getScopedMemoryFilesystemRoot(agentId)
                        : null,
                    permissionMode: uiPermissionMode,
                    networkPhase,
                    terminalWidth: chromeColumns,
                  }),
                  { timeout: config.timeout, workingDirectory: wd },
                );
                if (result.ok) {
                  cmd.finish(
                    `Output: ${result.text} (${result.durationMs}ms)`,
                    true,
                  );
                } else {
                  cmd.finish(
                    `Error: ${result.error} (${result.durationMs}ms)`,
                    false,
                  );
                }
              } else if (sub === "disable") {
                settingsManager.updateSettings({
                  statusLine: {
                    ...settingsManager.getSettings().statusLine,
                    command:
                      settingsManager.getSettings().statusLine?.command ?? "",
                    disabled: true,
                  },
                });
                cmd.finish("Status line disabled", true);
              } else if (sub === "enable") {
                const current = settingsManager.getSettings().statusLine;
                if (!current?.command) {
                  cmd.finish(
                    "No status line configured. Use /statusline set <command> first.",
                    false,
                  );
                } else {
                  settingsManager.updateSettings({
                    statusLine: { ...current, disabled: false },
                  });
                  cmd.finish("Status line enabled", true);
                }
              } else {
                cmd.finish(
                  `Unknown subcommand: ${sub}. Use help|show|set|clear|test|enable|disable`,
                  false,
                );
              }
            } catch (error) {
              cmd.finish(
                `Error: ${error instanceof Error ? error.message : String(error)}`,
                false,
              );
            }
          })();

          triggerStatusLineRefresh();
          return { submitted: true };
        }

        // Special handling for /usage command - show session stats
        if (trimmed === "/usage") {
          const cmd = commandRunner.start(
            trimmed,
            "Fetching usage statistics...",
          );

          // Fetch balance and display stats asynchronously
          (async () => {
            try {
              const stats = sessionStatsRef.current.getSnapshot();

              // Try to fetch balance info (only works for Letta Cloud)
              // Silently skip if endpoint not available (not deployed yet or self-hosted)
              let balance:
                | {
                    total_balance: number;
                    monthly_credit_balance: number;
                    purchased_credit_balance: number;
                    billing_tier: string;
                  }
                | undefined;

              try {
                balance = await getBalanceMetadata();
              } catch {
                // Silently skip balance info if endpoint not available
              }

              const output = formatUsageStats({
                stats,
                balance,
              });

              cmd.finish(output, true, true);
            } catch (error) {
              cmd.fail(
                `Error fetching usage: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          })();

          return { submitted: true };
        }

        // Special handling for /context command - show context window usage
        if (trimmed === "/context") {
          const contextWindow = effectiveContextWindowSize ?? 0;
          const model = llmConfigRef.current?.model ?? "unknown";

          // Use most recent total tokens from usage_statistics as context size (after turn)
          const usedTokens = contextTrackerRef.current.lastContextTokens;
          const history = contextTrackerRef.current.contextTokensHistory;

          const cmd = commandRunner.start(
            trimmed,
            "Fetching context breakdown...",
          );

          // Fetch breakdown (5s timeout)
          let breakdown: ContextWindowOverview | undefined;
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            try {
              breakdown = await getAgentContextOverview<ContextWindowOverview>(
                agentIdRef.current,
                { signal: controller.signal },
              );
            } finally {
              clearTimeout(timeoutId);
            }
          } catch {
            // Timeout or network error — proceed without breakdown
          }

          // Render the full chart once, directly into the finished output
          cmd.finish(
            renderContextUsage({
              usedTokens,
              contextWindow,
              model,
              history,
              ...(breakdown && { breakdown }),
            }),
            true,
            false,
            true,
          );

          return { submitted: true };
        }

        // Hidden command for setting/resetting the active scope's max context window.
        if (
          trimmed === "/set-max-context" ||
          trimmed.startsWith("/set-max-context ")
        ) {
          const args = trimmed.slice("/set-max-context".length).trim();
          const cmd = commandRunner.start(
            trimmed,
            "Setting max context window...",
          );
          setCommandRunning(true);

          try {
            const result = await applySetMaxContext({
              agentId: agentIdRef.current,
              conversationId: conversationIdRef.current,
              args,
              currentModelId,
              currentModelHandle,
              currentLlmConfig: llmConfigRef.current,
              currentContextWindow: effectiveContextWindowSize ?? null,
            });

            if (result.updatedAgent) {
              setAgentState(result.updatedAgent);
              setHasConversationModelOverride(false);
              setConversationOverrideModelSettings(null);
              setConversationOverrideContextWindowLimit(null);
            } else {
              setHasConversationModelOverride(true);
              setConversationOverrideContextWindowLimit(result.contextWindow);
            }

            setLlmConfig({
              ...(llmConfigRef.current ?? ({} as LlmConfig)),
              context_window: result.contextWindow,
            } as LlmConfig);
            resetContextHistory(contextTrackerRef.current);
            cmd.finish(formatSetMaxContextResult(result), true);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed to set max context: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return { submitted: true };
        }

        // Special handling for /recompile command - recompile agent + current conversation
        if (trimmed === "/recompile") {
          const cmd = commandRunner.start(
            trimmed,
            "Recompiling agent and conversation...",
          );

          setCommandRunning(true);

          try {
            const currentConversationId = conversationIdRef.current;
            const { recompileAgentSystemPrompt } = await import(
              "../../agent/modify"
            );
            const compiledSystemPrompt = await recompileAgentSystemPrompt(
              currentConversationId,
              agentId,
            );
            setSystemPromptDoctorState(
              agentId,
              estimateSystemTokens(compiledSystemPrompt),
            );

            cmd.finish(
              [
                "Recompiled current agent and conversation.",
                "(warning: this will evict the cache and increase costs)",
              ].join("\n"),
              true,
            );
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return { submitted: true };
        }

        // Special handling for /exit command - exit without stats
        if (trimmed === "/exit") {
          const cmd = commandRunner.start(trimmed, "See ya!");
          cmd.finish("See ya!", true);
          handleExit();
          return { submitted: true };
        }

        // Special handling for /logout command - clear credentials and exit
        if (trimmed === "/logout") {
          const cmd = commandRunner.start(msg.trim(), "Logging out...");

          setCommandRunning(true);

          try {
            const { settingsManager } = await import("../../settings-manager");
            const currentSettings =
              await settingsManager.getSettingsWithSecureTokens();

            // Revoke refresh token on server if we have one
            if (currentSettings.refreshToken) {
              const { revokeToken } = await import("../../auth/oauth");
              await revokeToken(currentSettings.refreshToken);
            }

            // Clear all credentials including secrets
            await settingsManager.logout();

            cmd.finish(
              buildLogoutSuccessMessage(Boolean(process.env.LETTA_API_KEY)),
              true,
            );

            saveLastSessionBeforeExit(conversationIdRef.current);

            // Track session end explicitly (before exit) with stats
            const stats = sessionStatsRef.current.getSnapshot();
            telemetry.trackSessionEnd(stats, "logout");

            // Record session to local history file
            try {
              recordSessionEnd(
                agentId,
                telemetry.getSessionId(),
                stats,
                {
                  project: projectDirectory,
                  model: currentModelLabel ?? "",
                  provider: currentModelProvider ?? "",
                },
                undefined,
                {
                  messageCount: telemetry.getMessageCount(),
                  toolCallCount: telemetry.getToolCallCount(),
                  exitReason: "logout",
                },
              );
            } catch {
              // Non-critical, don't fail the exit
            }

            // Flush telemetry before exit
            await telemetry.flush();

            // Exit after a brief delay to show the message
            setTimeout(() => process.exit(0), 500);
          } catch (error) {
            let errorOutput = formatErrorDetails(error, agentId);

            // Add helpful tip for summarization failures
            if (errorOutput.includes("Summarization failed")) {
              errorOutput +=
                "\n\nTip: Use /clear instead to clear the current message buffer.";
            }

            cmd.fail(`Failed: ${errorOutput}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /ralph and /yolo-ralph commands - Ralph Wiggum mode
        if (trimmed.startsWith("/yolo-ralph") || trimmed.startsWith("/ralph")) {
          const isYolo = trimmed.startsWith("/yolo-ralph");
          const { prompt, completionPromise, maxIterations } =
            parseRalphArgs(trimmed);

          const cmd = commandRunner.start(trimmed, "Activating ralph mode...");

          if (prompt) {
            // Inline prompt - activate immediately and send
            ralphMode.activate(
              prompt,
              completionPromise,
              maxIterations,
              isYolo,
            );
            setUiRalphActive(true);
            if (isYolo) {
              permissionMode.setMode("bypassPermissions");
              setUiPermissionMode("bypassPermissions");
            }

            const ralphState = ralphMode.getState();
            const promiseDisplay = ralphState.completionPromise
              ? `"${ralphState.completionPromise.slice(0, 50)}${ralphState.completionPromise.length > 50 ? "..." : ""}"`
              : "(none)";

            cmd.finish(
              `🔄 ${isYolo ? "yolo-ralph" : "ralph"} mode activated (iter 1/${maxIterations || "∞"})\nPromise: ${promiseDisplay}`,
              true,
            );

            // Send the prompt with ralph reminder prepended
            const systemMsg = buildRalphFirstTurnReminder(ralphState);
            processConversationWithQueuedApprovals([
              {
                type: "message",
                role: "user",
                content: buildTextParts(systemMsg, prompt),
                otid: randomUUID(),
              },
            ]);
          } else {
            // No inline prompt - wait for next message
            setPendingRalphConfig({ completionPromise, maxIterations, isYolo });

            const defaultPromisePreview = DEFAULT_COMPLETION_PROMISE.slice(
              0,
              40,
            );

            cmd.finish(
              `🔄 ${isYolo ? "yolo-ralph" : "ralph"} mode ready (waiting for task)\nMax iterations: ${maxIterations || "unlimited"}\nPromise: ${completionPromise === null ? "(none)" : (completionPromise ?? `"${defaultPromisePreview}..." (default)`)}\n\nType your task to begin the loop.`,
              true,
            );
          }
          return { submitted: true };
        }

        // Special handling for /stream command - toggle and save
        if (msg.trim() === "/stream") {
          const newValue = !tokenStreamingEnabled;

          // Immediately add command to transcript with "running" phase and loading message
          const cmd = commandRunner.start(
            msg.trim(),
            `${newValue ? "Enabling" : "Disabling"} token streaming...`,
          );

          // Lock input during async operation
          setCommandRunning(true);

          try {
            setTokenStreamingEnabled(newValue);

            // Save to settings
            const { settingsManager } = await import("../../settings-manager");
            settingsManager.updateSettings({ tokenStreaming: newValue });

            // Update the same command with final result
            cmd.finish(
              `Token streaming ${newValue ? "enabled" : "disabled"}`,
              true,
            );
          } catch (error) {
            // Mark command as failed
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            // Unlock input
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /reasoning-tab command - opt-in toggle for Tab tier cycling
        if (
          trimmed === "/reasoning-tab" ||
          trimmed.startsWith("/reasoning-tab ")
        ) {
          const resolution = resolveReasoningTabToggleCommand(
            trimmed,
            reasoningTabCycleEnabled,
          );
          if (!resolution) {
            return { submitted: false };
          }
          const cmd = commandRunner.start(
            trimmed,
            "Updating reasoning Tab shortcut...",
          );

          setCommandRunning(true);

          try {
            if (resolution.kind === "status") {
              cmd.finish(resolution.message, true);
              return { submitted: true };
            }

            if (resolution.kind === "invalid") {
              cmd.fail(resolution.message);
              return { submitted: true };
            }

            setReasoningTabCycleEnabled(resolution.enabled);
            settingsManager.updateSettings({
              reasoningTabCycleEnabled: resolution.enabled,
            });

            cmd.finish(resolution.message, true);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return { submitted: true };
        }

        // Special handling for /new command - start new conversation
        const newMatch = msg.trim().match(/^\/new(?:\s+(.+))?$/);
        if (newMatch) {
          const conversationName = newMatch[1]?.trim();
          const cmd = commandRunner.start(
            msg.trim(),
            conversationName
              ? `Starting new conversation: ${conversationName}...`
              : "Starting new conversation...",
          );

          // New conversations should not inherit pending reasoning-tier debounce.
          resetPendingReasoningCycle();
          setCommandRunning(true);

          // Run SessionEnd hooks for current session before starting new one
          await runEndHooks();

          try {
            const backend = getBackend();

            // Create a new conversation for the current agent
            const conversation = await backend.createConversation({
              agent_id: agentId,
              isolated_block_labels: [...ISOLATED_BLOCK_LABELS],
              ...(conversationName && { summary: conversationName }),
            });

            setConversationAutoTitleEligibility(!conversationName);
            await maybeCarryOverActiveConversationModel(conversation.id);

            // Update conversationId state and ref together so the next turn
            // cannot observe a stale conversation handoff.
            setConversationIdAndRef(conversation.id);

            pendingConversationSwitchRef.current = {
              origin: "new",
              conversationId: conversation.id,
              isDefault: false,
            };

            // Save the new session to settings
            settingsManager.persistSession(agentId, conversation.id);

            // Reset context tokens for new conversation
            resetContextHistory(contextTrackerRef.current);

            // Ensure bootstrap reminders are re-injected for the new conversation.
            resetBootstrapReminderState();

            // Re-run SessionStart hooks for new conversation
            sessionHooksRanRef.current = false;
            runSessionStartHooks(
              true, // isNewSession
              agentId,
              agentName ?? undefined,
              conversation.id,
            )
              .then((result) => {
                if (result.feedback.length > 0) {
                  sessionStartFeedbackRef.current = result.feedback;
                }
              })
              .catch(() => {});
            sessionHooksRanRef.current = true;

            // Update command with success
            cmd.finish(
              "Started new conversation (use /resume to change convos)",
              true,
            );
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /fork command - fork the current conversation
        const forkMatch = msg.trim().match(/^\/fork(?:\s+(.+))?$/);
        if (forkMatch) {
          const conversationSummary = forkMatch[1]?.trim();
          const cmd = commandRunner.start(
            msg.trim(),
            conversationSummary
              ? `Forking conversation: ${conversationSummary}...`
              : "Forking conversation...",
          );

          resetPendingReasoningCycle();
          setCommandRunning(true);

          await runEndHooks();

          try {
            // For default conversation, pass agent_id
            const isDefault = conversationIdRef.current === "default";
            const backend = getBackend();
            const forked = await backend.forkConversation(
              conversationIdRef.current,
              {
                ...(isDefault ? { agentId } : {}),
              },
            );

            // If we forked with an explicit summary, update it
            if (conversationSummary) {
              await backend.updateConversation(forked.id, {
                summary: conversationSummary,
              });
            }
            setConversationAutoTitleEligibility(false);

            await maybeCarryOverActiveConversationModel(forked.id);

            setConversationIdAndRef(forked.id);

            pendingConversationSwitchRef.current = {
              origin: "fork",
              conversationId: forked.id,
              isDefault: false,
            };

            settingsManager.setLocalLastSession(
              { agentId, conversationId: forked.id },
              process.cwd(),
            );
            settingsManager.setGlobalLastSession({
              agentId,
              conversationId: forked.id,
            });

            resetContextHistory(contextTrackerRef.current);
            resetBootstrapReminderState();

            sessionHooksRanRef.current = false;
            runSessionStartHooks(
              true,
              agentId,
              agentName ?? undefined,
              forked.id,
            )
              .then((result) => {
                if (result.feedback.length > 0) {
                  sessionStartFeedbackRef.current = result.feedback;
                }
              })
              .catch(() => {});
            sessionHooksRanRef.current = true;

            cmd.finish(
              "Forked conversation (use /resume to switch back)",
              true,
            );
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /btw command - fork in background, stream response to ephemeral pane
        const btwMatch = msg.trim().match(/^\/btw\s+(.+)$/);
        if (btwMatch?.[1]) {
          const question = btwMatch[1].trim();

          // Don't await - run in background, user stays in current conversation
          handleBtwCommand(question).catch((err: unknown) => {
            debugWarn("btw", "unhandled error: %s", err);
          });

          return { submitted: true };
        }

        // Special handling for /clear command - reset all agent messages (destructive)
        if (msg.trim() === "/clear") {
          const cmd = commandRunner.start(
            msg.trim(),
            "Clearing in-context messages...",
          );

          // Clearing conversation state should also clear pending reasoning-tier debounce.
          resetPendingReasoningCycle();
          setCommandRunning(true);

          // Run SessionEnd hooks for current session before clearing
          await runEndHooks();

          try {
            const backend = getBackend();

            // Reset all messages on the agent only when in the default API conversation.
            // Local/headless backends model /clear by switching to a fresh conversation.
            // For named conversations, clearing just means starting a new conversation —
            // there is no reason to wipe the agent's entire message history.
            if (
              conversationIdRef.current === "default" &&
              !backend.capabilities.localModelCatalog
            ) {
              const client = await getClient();
              await client.agents.messages.reset(agentId, {
                add_default_initial_messages: false,
              });
            }

            // Create a new conversation
            const conversation = await backend.createConversation({
              agent_id: agentId,
              isolated_block_labels: [...ISOLATED_BLOCK_LABELS],
            });

            setConversationAutoTitleEligibility(true);
            await maybeCarryOverActiveConversationModel(conversation.id);
            setConversationIdAndRef(conversation.id);

            pendingConversationSwitchRef.current = {
              origin: "clear",
              conversationId: conversation.id,
              isDefault: false,
            };

            settingsManager.persistSession(agentId, conversation.id);

            // Reset context tokens for new conversation
            resetContextHistory(contextTrackerRef.current);

            // Ensure bootstrap reminders are re-injected for the new conversation.
            resetBootstrapReminderState();

            // Re-run SessionStart hooks for new conversation
            sessionHooksRanRef.current = false;
            runSessionStartHooks(
              true, // isNewSession
              agentId,
              agentName ?? undefined,
              conversation.id,
            )
              .then((result) => {
                if (result.feedback.length > 0) {
                  sessionStartFeedbackRef.current = result.feedback;
                }
              })
              .catch(() => {});
            sessionHooksRanRef.current = true;

            // Update command with success
            cmd.finish(
              "Agent's in-context messages cleared & moved to conversation history",
              true,
            );
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /compact command - summarize conversation history
        // Supports: /compact, /compact all, /compact sliding_window, /compact self_compact_all, /compact self_compact_sliding_window
        if (msg.trim().startsWith("/compact")) {
          const parts = msg.trim().split(/\s+/);
          const rawModeArg = parts[1];
          const validModes = [
            "all",
            "sliding_window",
            "self_compact_all",
            "self_compact_sliding_window",
          ];

          if (rawModeArg === "help") {
            const cmd = commandRunner.start(
              msg.trim(),
              "Showing compact help...",
            );
            const output = [
              "/compact help",
              "",
              "Summarize conversation history (compaction).",
              "",
              "USAGE",
              "  /compact                   — compact with default mode",
              "  /compact all               — compact all messages",
              "  /compact sliding_window    — compact with sliding window",
              "  /compact self_compact_all  — compact with self compact all",
              "  /compact self_compact_sliding_window  — compact with self compact sliding window",
              "  /compact help              — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return { submitted: true };
          }

          const modeArg = rawModeArg as
            | "all"
            | "sliding_window"
            | "self_compact_all"
            | "self_compact_sliding_window"
            | undefined;

          // Validate mode if provided
          if (modeArg && !validModes.includes(modeArg)) {
            const cmd = commandRunner.start(
              msg.trim(),
              `Invalid mode "${modeArg}".`,
            );
            cmd.fail(`Invalid mode "${modeArg}". Run /compact help for usage.`);
            return { submitted: true };
          }

          const modeDisplay = modeArg ? ` (mode: ${modeArg})` : "";
          const cmd = commandRunner.start(
            msg.trim(),
            `Compacting conversation history${modeDisplay}...`,
          );

          setCommandRunning(true);

          try {
            // Run PreCompact hooks - can block the compact operation
            const preCompactResult = await runPreCompactHooks(
              undefined, // context_length - not available here
              undefined, // max_context_length - not available here
              agentId,
              conversationIdRef.current,
            );
            if (preCompactResult.blocked) {
              const feedback =
                preCompactResult.feedback.join("\n") || "Blocked by hook";
              cmd.fail(`Compact blocked: ${feedback}`);
              setCommandRunning(false);
              return { submitted: true };
            }

            // Build compaction settings if mode was specified
            // On server side, if mode changed, summarize function will use corresponding default prompt for new mode
            const compactParams = modeArg
              ? {
                  compaction_settings: {
                    mode: modeArg,
                    model:
                      agentStateRef.current?.compaction_settings?.model?.trim() ||
                      DEFAULT_SUMMARIZATION_MODEL,
                  },
                }
              : undefined;

            const compactConversationId = conversationIdRef.current;
            const compactBody =
              compactConversationId === "default"
                ? {
                    agent_id: agentId,
                    ...(compactParams ?? {}),
                  }
                : compactParams;
            const result = await getBackend().compactConversationMessages(
              compactConversationId,
              compactBody,
            );

            // Format success message with before/after counts and summary
            const outputLines = [
              `Compaction completed${modeDisplay}. Message buffer length reduced from ${result.num_messages_before} to ${result.num_messages_after}.`,
              "",
              `Summary: ${result.summary}`,
            ];

            // Update command with success
            cmd.finish(outputLines.join("\n"), true);

            // Manual /compact bypasses stream compaction events, so trigger
            // post-compaction reflection reminder/auto-launch on the next user turn.
            contextTrackerRef.current.pendingReflectionTrigger = true;
          } catch (error) {
            const apiError = error as {
              status?: number;
              error?: { detail?: string };
            };
            const detail = apiError?.error?.detail;
            if (
              apiError?.status === 400 &&
              detail?.includes(
                "Summarization failed to reduce the number of messages",
              )
            ) {
              cmd.finish(
                "Compaction run, but the number of messages is the same",
                true,
              );
              return { submitted: true };
            }

            const errorOutput = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorOutput}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /rename command - rename agent or conversation
        if (msg.trim().startsWith("/rename")) {
          const parts = msg.trim().split(/\s+/);
          const subcommand = parts[1]?.toLowerCase();
          const cmd = commandRunner.start(msg.trim(), "Processing rename...");

          if (subcommand === "help") {
            const output = [
              "/rename help",
              "",
              "Rename the current agent or conversation.",
              "",
              "USAGE",
              "  /rename agent [name]      — rename the agent",
              "  /rename convo [name]      — rename the convo, or auto-generate when omitted",
              "  /rename help              — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return { submitted: true };
          }

          if (
            !subcommand ||
            (subcommand !== "agent" && subcommand !== "convo")
          ) {
            cmd.fail("Usage: /rename agent [name] or /rename convo [name]");
            return { submitted: true };
          }

          const newValue = parts.slice(2).join(" ");
          if (subcommand === "agent" && !newValue) {
            cmd.fail("Please provide a name: /rename agent <name>");
            return { submitted: true };
          }

          if (subcommand === "convo") {
            const shouldAutoGenerate = newValue.trim().length === 0;
            cmd.update({
              output: shouldAutoGenerate
                ? "Generating conversation title..."
                : `Renaming conversation to "${newValue}"...`,
              phase: "running",
            });

            setCommandRunning(true);

            try {
              const backend = getBackend();
              if (shouldAutoGenerate) {
                const conversationTitle = await generateConversationTitle();
                if (!conversationTitle) {
                  cmd.fail(
                    "No conversation content available to generate a title",
                  );
                  return { submitted: true };
                }
                await backend.updateConversation(conversationId, {
                  summary: conversationTitle,
                });
                setConversationAutoTitleEligibility(false);
                cmd.finish(
                  `Conversation title set to "${conversationTitle}"`,
                  true,
                );
              } else {
                await backend.updateConversation(conversationId, {
                  summary: newValue,
                });
                setConversationAutoTitleEligibility(false);
                cmd.finish(`Conversation renamed to "${newValue}"`, true);
              }
            } catch (error) {
              const errorDetails = formatErrorDetails(error, agentId);
              cmd.fail(`Failed: ${errorDetails}`);
            } finally {
              setCommandRunning(false);
            }
            return { submitted: true };
          }

          // Rename agent (default behavior)
          const validationError = validateAgentName(newValue);
          if (validationError) {
            cmd.fail(validationError);
            return { submitted: true };
          }

          cmd.update({
            output: `Renaming agent to "${newValue}"...`,
            phase: "running",
          });

          setCommandRunning(true);

          try {
            await getBackend().updateAgent(agentId, {
              name: newValue,
            });
            updateAgentName(newValue);

            cmd.agentHint = `Your name is now "${newValue}" — acknowledge this and save your new name to memory.`;
            cmd.finish(`Agent renamed to "${newValue}"`, true);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /description command - update agent description
        if (msg.trim().startsWith("/description")) {
          const parts = msg.trim().split(/\s+/);
          const newDescription = parts.slice(1).join(" ");
          const cmd = commandRunner.start(
            msg.trim(),
            "Updating description...",
          );

          if (newDescription === "help") {
            const output = [
              "/description help",
              "",
              "Update the current agent's description.",
              "",
              "USAGE",
              "  /description <text>   — set agent description",
              "  /description help     — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return { submitted: true };
          }

          if (!newDescription) {
            cmd.fail("Usage: /description <text>");
            return { submitted: true };
          }

          cmd.update({ output: "Updating description...", phase: "running" });

          setCommandRunning(true);

          try {
            await getBackend().updateAgent(agentId, {
              description: newDescription,
            });
            setAgentState((prev: AgentState | null | undefined) =>
              prev ? { ...prev, description: newDescription } : prev,
            );
            setAgentDescription(newDescription);

            cmd.finish(`Description updated to "${newDescription}"`, true);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /agents command - show agent browser
        // /pinned, /profiles are hidden aliases
        if (
          msg.trim() === "/agents" ||
          msg.trim() === "/pinned" ||
          msg.trim() === "/profiles"
        ) {
          startOverlayCommand(
            "resume",
            "/agents",
            "Opening agent browser...",
            "Agent browser dismissed",
          );
          setActiveOverlay("resume");
          return { submitted: true };
        }

        // Special handling for /resume command - show conversation selector or switch directly
        if (msg.trim().startsWith("/resume")) {
          const parts = msg.trim().split(/\s+/);
          const targetConvId = parts[1]; // Optional conversation ID

          if (targetConvId === "help") {
            const cmd = commandRunner.start(
              msg.trim(),
              "Showing resume help...",
            );
            const output = [
              "/resume help",
              "",
              "Resume a previous conversation.",
              "",
              "USAGE",
              "  /resume                       — open conversation selector",
              "  /resume <conversation_id>     — switch directly to a conversation",
              "  /resume help                  — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return { submitted: true };
          }

          if (targetConvId) {
            const cmd = commandRunner.start(
              msg.trim(),
              "Switching conversation...",
            );
            // Direct switch to specified conversation
            if (targetConvId === conversationId) {
              cmd.finish("Already on this conversation", true);
              return { submitted: true };
            }

            // Lock input and show loading
            setCommandRunning(true);

            try {
              // Validate conversation exists BEFORE updating state
              // (getResumeData throws 404/422 for non-existent conversations)
              if (agentState) {
                const resumeData = await getResumeDataFromBackend(
                  agentState,
                  targetConvId,
                );

                // Only update state after validation succeeds
                setConversationIdAndRef(targetConvId);
                setConversationAutoTitleEligibility(false);

                pendingConversationSwitchRef.current = {
                  origin: "resume-direct",
                  conversationId: targetConvId,
                  isDefault: targetConvId === "default",
                  messageCount: resumeData.messageHistory.length,
                  messageHistory: resumeData.messageHistory,
                };

                settingsManager.persistSession(agentId, targetConvId);

                // Build success message
                const currentAgentName = agentState.name || "Unnamed Agent";
                const successLines =
                  resumeData.messageHistory.length > 0
                    ? [
                        `Resumed conversation with "${currentAgentName}"`,
                        `⎿  Agent: ${agentId}`,
                        `⎿  Conversation: ${targetConvId}`,
                      ]
                    : [
                        `Switched to conversation with "${currentAgentName}"`,
                        `⎿  Agent: ${agentId}`,
                        `⎿  Conversation: ${targetConvId} (empty)`,
                      ];
                const successOutput = successLines.join("\n");
                cmd.finish(successOutput, true);
                const successItem: StaticItem = {
                  kind: "command",
                  id: cmd.id,
                  input: cmd.input,
                  output: successOutput,
                  phase: "finished",
                  success: true,
                };

                // Clear current transcript and static items
                buffersRef.current.byId.clear();
                buffersRef.current.order = [];
                buffersRef.current.tokenCount = 0;
                resetContextHistory(contextTrackerRef.current);
                resetBootstrapReminderState();
                emittedIdsRef.current.clear();
                resetDeferredToolCallCommits();
                setStaticItems([]);
                setStaticRenderEpoch((e: number) => e + 1);
                resetTrajectoryBases();

                // Backfill message history
                if (resumeData.messageHistory.length > 0) {
                  hasBackfilledRef.current = false;
                  backfillBuffers(
                    buffersRef.current,
                    resumeData.messageHistory,
                  );
                  const backfilledItems: StaticItem[] = [];
                  for (const id of buffersRef.current.order) {
                    const ln = buffersRef.current.byId.get(id);
                    if (!ln) continue;
                    emittedIdsRef.current.add(id);
                    backfilledItems.push({ ...ln } as StaticItem);
                  }
                  const separator = {
                    kind: "separator" as const,
                    id: uid("sep"),
                  };
                  setStaticItems([separator, ...backfilledItems, successItem]);
                  setLines(toLines(buffersRef.current));
                  hasBackfilledRef.current = true;
                } else {
                  const separator = {
                    kind: "separator" as const,
                    id: uid("sep"),
                  };
                  setStaticItems([separator, successItem]);
                  setLines(toLines(buffersRef.current));
                }

                // Restore pending approvals if any (fixes #540 for /resume command)
                if (resumeData.pendingApprovals.length > 0) {
                  await recoverRestoredPendingApprovals(
                    resumeData.pendingApprovals,
                  );
                }
              }
            } catch (error) {
              // Update existing loading message instead of creating new one
              // Format error message to be user-friendly (avoid raw JSON/internal details)
              let errorMsg = "Unknown error";
              if (error instanceof APIError) {
                if (error.status === 404) {
                  errorMsg = "Conversation not found";
                } else if (error.status === 422) {
                  errorMsg = "Invalid conversation ID";
                } else {
                  errorMsg = error.message;
                }
              } else if (error instanceof Error) {
                errorMsg = error.message;
              }
              cmd.fail(`Failed to switch conversation: ${errorMsg}`);
            } finally {
              setCommandRunning(false);
            }
            return { submitted: true };
          }

          // No conversation ID provided - show selector
          startOverlayCommand(
            "conversations",
            "/resume",
            "Opening conversation selector...",
            "Conversation selector dismissed",
          );
          setActiveOverlay("conversations");
          return { submitted: true };
        }

        // Special handling for /search command - show message search
        if (trimmed.startsWith("/search")) {
          // Extract optional query after /search
          const [, ...rest] = trimmed.split(/\s+/);
          const query = rest.join(" ").trim();
          setSearchQuery(query);
          startOverlayCommand(
            "search",
            "/search",
            "Opening message search...",
            "Message search dismissed",
          );
          setActiveOverlay("search");
          return { submitted: true };
        }

        // Special handling for /profile command - manage local profiles
        if (msg.trim().startsWith("/profile")) {
          const parts = msg.trim().split(/\s+/);
          const subcommand = parts[1]?.toLowerCase();
          const profileName = parts.slice(2).join(" ");

          const profileCtx: ProfileCommandContext = {
            buffersRef,
            refreshDerived,
            agentId,
            agentName: agentName || "",
            setCommandRunning,
            updateAgentName,
          };

          // /profile - open agent browser (now points to /agents)
          if (!subcommand) {
            startOverlayCommand(
              "resume",
              "/profile",
              "Opening agent browser...",
              "Agent browser dismissed",
            );
            setActiveOverlay("resume");
            return { submitted: true };
          }

          const cmd = commandRunner.start(
            msg.trim(),
            "Running profile command...",
          );
          setActiveProfileCommandId(cmd.id);
          const clearProfileCommandId = () => setActiveProfileCommandId(null);

          // /profile save <name>
          if (subcommand === "save") {
            await handleProfileSave(profileCtx, msg, profileName);
            clearProfileCommandId();
            return { submitted: true };
          }

          // /profile load <name>
          if (subcommand === "load") {
            const validation = validateProfileLoad(
              profileCtx,
              msg,
              profileName,
            );
            if (validation.errorMessage) {
              clearProfileCommandId();
              return { submitted: true };
            }

            if (validation.needsConfirmation && validation.targetAgentId) {
              // Show warning and wait for confirmation
              const cmdId = addCommandResult(
                buffersRef,
                refreshDerived,
                msg,
                "Warning: Current agent is not saved to any profile.\nPress Enter to continue, or type anything to cancel.",
                false,
                "running",
              );
              setProfileConfirmPending({
                name: profileName,
                agentId: validation.targetAgentId,
                cmdId,
              });
              clearProfileCommandId();
              return { submitted: true };
            }

            // Current agent is saved, proceed with loading
            if (validation.targetAgentId) {
              await handleAgentSelect(validation.targetAgentId, {
                profileName,
                commandId: cmd.id,
              });
            }
            clearProfileCommandId();
            return { submitted: true };
          }

          // /profile delete <name>
          if (subcommand === "delete") {
            handleProfileDelete(profileCtx, msg, profileName);
            clearProfileCommandId();
            return { submitted: true };
          }

          // Unknown subcommand
          handleProfileUsage(profileCtx, msg);
          clearProfileCommandId();
          return { submitted: true };
        }

        // Special handling for /new command - create new agent dialog
        // Special handling for /pin command - pin current agent to project (or globally with -g)
        if (msg.trim() === "/pin" || msg.trim().startsWith("/pin ")) {
          const argsStr = msg.trim().slice(4).trim();

          if (argsStr === "help") {
            const cmd = commandRunner.start(msg.trim(), "Showing pin help...");
            const output = [
              "/pin help",
              "",
              "Pin the current agent.",
              "",
              "USAGE",
              "  /pin        — pin globally (interactive)",
              "  /pin -l     — pin locally to this directory",
              "  /pin help   — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return { submitted: true };
          }

          // Parse args to check if name was provided
          const parts = argsStr.split(/\s+/).filter(Boolean);
          let hasNameArg = false;
          let isLocal = false;

          for (const part of parts) {
            if (part === "-l" || part === "--local") {
              isLocal = true;
            } else {
              hasNameArg = true;
            }
          }

          // If no name provided, show the pin dialog
          if (!hasNameArg) {
            setPinDialogLocal(isLocal);
            startOverlayCommand(
              "pin",
              "/pin",
              "Opening pin dialog...",
              "Pin dialog dismissed",
            );
            setActiveOverlay("pin");
            return { submitted: true };
          }

          // Name was provided, use existing behavior
          const profileCtx: ProfileCommandContext = {
            buffersRef,
            refreshDerived,
            agentId,
            agentName: agentName || "",
            setCommandRunning,
            updateAgentName,
          };
          {
            const cmd = commandRunner.start(msg.trim(), "Pinning agent...");
            setActiveProfileCommandId(cmd.id);
            try {
              await handlePin(profileCtx, msg, argsStr);
            } finally {
              setActiveProfileCommandId(null);
            }
          }
          return { submitted: true };
        }

        // Special handling for /unpin command - unpin current agent from project (or globally with -g)
        if (msg.trim() === "/unpin" || msg.trim().startsWith("/unpin ")) {
          const unpinArgsStr = msg.trim().slice(6).trim();

          if (unpinArgsStr === "help") {
            const cmd = commandRunner.start(
              msg.trim(),
              "Showing unpin help...",
            );
            const output = [
              "/unpin help",
              "",
              "Unpin the current agent.",
              "",
              "USAGE",
              "  /unpin       — unpin globally",
              "  /unpin -l    — unpin locally",
              "  /unpin help  — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return { submitted: true };
          }

          const profileCtx: ProfileCommandContext = {
            buffersRef,
            refreshDerived,
            agentId,
            agentName: agentName || "",
            setCommandRunning,
            updateAgentName,
          };
          const argsStr = msg.trim().slice(6).trim();
          {
            const cmd = commandRunner.start(msg.trim(), "Unpinning agent...");
            setActiveProfileCommandId(cmd.id);
            try {
              handleUnpin(profileCtx, msg, argsStr);
            } finally {
              setActiveProfileCommandId(null);
            }
          }
          return { submitted: true };
        }

        // Special handling for /bg command - show background shell processes
        if (msg.trim() === "/bg") {
          const { backgroundProcesses } = await import(
            "../../tools/impl/process_manager"
          );
          const cmd = commandRunner.start(
            msg.trim(),
            "Checking background processes...",
          );

          let output: string;
          if (backgroundProcesses.size === 0) {
            output = "No background processes running";
          } else {
            const lines = ["Background processes:"];
            for (const [id, proc] of backgroundProcesses) {
              const status =
                proc.status === "running"
                  ? "running"
                  : proc.status === "completed"
                    ? `completed (exit ${proc.exitCode})`
                    : `failed (exit ${proc.exitCode})`;
              lines.push(`  ${id}: ${proc.command} [${status}]`);
            }
            output = lines.join("\n");
          }

          cmd.finish(output, true);
          return { submitted: true };
        }

        // Special handling for /export command (also accepts legacy /download)
        if (msg.trim() === "/export" || msg.trim() === "/download") {
          const cmd = commandRunner.start(
            msg.trim(),
            "Exporting agent file...",
          );

          if (!getBackend().capabilities.agentFileImportExport) {
            cmd.fail(
              "AgentFile export is not supported by the local backend yet.",
            );
            return { submitted: true };
          }

          setCommandRunning(true);

          try {
            const client = await getClient();

            // Build export parameters (include conversation_id if in specific conversation)
            const exportParams: { conversation_id?: string } = {};
            if (conversationId !== "default" && conversationId !== agentId) {
              exportParams.conversation_id = conversationId;
            }

            // Package skills from agent/project/global directories
            const { packageSkills } = await import("../../agent/export");
            const skills = await packageSkills(agentId);

            // Export agent via SDK (GET endpoint), then embed skills client-side
            const baseContent = await client.agents.exportFile(
              agentId,
              exportParams,
            );

            // Parse if returned as a string, otherwise use as-is
            const fileContent: Record<string, unknown> =
              typeof baseContent === "string"
                ? JSON.parse(baseContent)
                : (baseContent as Record<string, unknown>);

            // Embed skills into the .af JSON (client-side, no server support needed)
            if (skills.length > 0) {
              fileContent.skills = skills;
            }

            // Generate filename
            const fileName = exportParams.conversation_id
              ? `${exportParams.conversation_id}.af`
              : `${agentId}.af`;

            writeFileSync(fileName, JSON.stringify(fileContent, null, 2));

            // Build success message
            let summary = `AgentFile exported to ${fileName}`;
            if (skills.length > 0) {
              summary += `\n📦 Included ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`;
            }

            cmd.finish(summary, true);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /memfs command - manage filesystem-backed memory
        if (trimmed.startsWith("/memfs")) {
          const [, subcommand] = trimmed.split(/\s+/);
          const cmd = commandRunner.start(
            msg.trim(),
            "Processing memfs command...",
          );
          const cmdId = cmd.id;

          if (!subcommand || subcommand === "help") {
            const output = [
              "/memfs help",
              "",
              "Manage filesystem-backed memory.",
              "",
              "USAGE",
              "  /memfs status    — show status",
              "  /memfs enable    — enable filesystem-backed memory",
              "  /memfs disable   — disable filesystem-backed memory",
              "  /memfs sync      — sync blocks and files now",
              "  /memfs reset     — move local memfs to /tmp and recreate dirs",
              "  /memfs help      — show this help",
            ].join("\n");
            cmd.finish(output, true);
            return { submitted: true };
          }

          if (subcommand === "status") {
            // Show status
            const enabled = settingsManager.isMemfsEnabled(agentId);
            let output: string;
            if (enabled) {
              const memoryDir = getScopedMemoryFilesystemRoot(agentId);
              output = `Memory filesystem is enabled.\nPath: ${memoryDir}`;
            } else {
              output =
                "Memory filesystem is disabled. Run `/memfs enable` to enable.";
            }
            cmd.finish(output, true);
            return { submitted: true };
          }

          if (subcommand === "enable") {
            updateMemorySyncCommand(
              cmdId,
              "Enabling memory filesystem...",
              true,
              msg,
              true,
            );
            setCommandRunning(true);

            try {
              const { applyMemfsFlags } = await import(
                "../../agent/memoryFilesystem"
              );
              const result = await applyMemfsFlags(agentId, true, false);
              updateMemorySyncCommand(
                cmdId,
                `Memory filesystem enabled (git-backed).\nPath: ${result.memoryDir}`,
                true,
                msg,
              );
            } catch (error) {
              const errorText =
                error instanceof Error ? error.message : String(error);
              updateMemorySyncCommand(
                cmdId,
                `Failed to enable memfs: ${errorText}`,
                false,
                msg,
              );
            } finally {
              setCommandRunning(false);
            }

            return { submitted: true };
          }

          if (subcommand === "sync") {
            // Check if memfs is enabled for this agent
            if (!settingsManager.isMemfsEnabled(agentId)) {
              cmd.fail(
                "Memory filesystem is disabled. Run `/memfs enable` first.",
              );
              return { submitted: true };
            }

            if (getBackend().capabilities.localMemfs) {
              const memoryDir = getScopedMemoryFilesystemRoot(agentId);
              try {
                const { initializeLocalMemoryRepo } = await import(
                  "../../agent/memoryGit"
                );
                await initializeLocalMemoryRepo({
                  memoryDir,
                  agentId,
                  authorName: agentName ?? undefined,
                  files: [],
                });
                cmd.finish(
                  `Local backend MemFS is stored locally; no remote sync is required.\nPath: ${memoryDir}`,
                  true,
                );
              } catch (error) {
                const errorText =
                  error instanceof Error ? error.message : String(error);
                cmd.fail(`Failed: ${errorText}`);
              }
              return { submitted: true };
            }

            updateMemorySyncCommand(
              cmdId,
              "Pulling latest memory from server...",
              true,
              msg,
              true,
            );

            setCommandRunning(true);

            try {
              const { pullMemory } = await import("../../agent/memoryGit");
              const result = await pullMemory(agentId);
              updateMemorySyncCommand(cmdId, result.summary, true, msg);
            } catch (error) {
              const errorText =
                error instanceof Error ? error.message : String(error);
              updateMemorySyncCommand(cmdId, `Failed: ${errorText}`, false);
            } finally {
              setCommandRunning(false);
            }

            return { submitted: true };
          }

          if (subcommand === "reset") {
            updateMemorySyncCommand(
              cmdId,
              "Resetting memory filesystem...",
              true,
              msg,
              true,
            );
            setCommandRunning(true);

            try {
              const memoryDir = getScopedMemoryFilesystemRoot(agentId);
              if (!existsSync(memoryDir)) {
                updateMemorySyncCommand(
                  cmdId,
                  "No local memory filesystem found to reset.",
                  true,
                  msg,
                );
                return { submitted: true };
              }

              const backupDir = join(
                tmpdir(),
                `letta-memfs-reset-${agentId}-${Date.now()}`,
              );
              renameSync(memoryDir, backupDir);

              if (getBackend().capabilities.localMemfs) {
                const { initializeLocalMemoryRepo } = await import(
                  "../../agent/memoryGit"
                );
                await initializeLocalMemoryRepo({
                  memoryDir,
                  agentId,
                  authorName: agentName ?? undefined,
                  files: [],
                });
              } else {
                ensureMemoryFilesystemDirs(agentId);
              }

              updateMemorySyncCommand(
                cmdId,
                getBackend().capabilities.localMemfs
                  ? `Memory filesystem reset.\nBackup moved to ${backupDir}\nInitialized a fresh local MemFS repo.`
                  : `Memory filesystem reset.\nBackup moved to ${backupDir}\nRun \`/memfs sync\` to repopulate from API.`,
                true,
                msg,
              );
            } catch (error) {
              const errorText =
                error instanceof Error ? error.message : String(error);
              updateMemorySyncCommand(
                cmdId,
                `Failed to reset memfs: ${errorText}`,
                false,
                msg,
              );
            } finally {
              setCommandRunning(false);
            }

            return { submitted: true };
          }

          if (subcommand === "disable") {
            if (getBackend().capabilities.localMemfs) {
              cmd.fail(
                "Disabling MemFS is not supported by the local backend.",
              );
              return { submitted: true };
            }

            updateMemorySyncCommand(
              cmdId,
              "Disabling memory filesystem...",
              true,
              msg,
              true,
            );
            setCommandRunning(true);

            try {
              // 1. Re-attach memory tool
              const { reattachMemoryTool } = await import(
                "../../tools/toolset"
              );
              const modelId = currentModelId || "anthropic/claude-sonnet-4";
              await reattachMemoryTool(agentId, modelId);

              // 2. Update system prompt to remove memfs section
              const { updateAgentSystemPromptMemfs } = await import(
                "../../agent/modify"
              );
              await updateAgentSystemPromptMemfs(agentId, false);

              // 3. Update settings
              settingsManager.setMemfsEnabled(agentId, false);

              // 4. Remove git-memory-enabled tag from agent
              const { removeGitMemoryTag } = await import(
                "../../agent/memoryGit"
              );
              await removeGitMemoryTag(agentId);

              // 5. Move local memory dir to /tmp (backup, not delete)
              let backupInfo = "";
              const memoryDir = getScopedMemoryFilesystemRoot(agentId);
              if (existsSync(memoryDir)) {
                const backupDir = join(
                  tmpdir(),
                  `letta-memfs-disable-${agentId}-${Date.now()}`,
                );
                renameSync(memoryDir, backupDir);
                backupInfo = `\nLocal files backed up to ${backupDir}`;
              }

              updateMemorySyncCommand(
                cmdId,
                `Memory filesystem disabled. Memory tool re-attached.${backupInfo}`,
                true,
                msg,
              );
            } catch (error) {
              const errorText =
                error instanceof Error ? error.message : String(error);
              updateMemorySyncCommand(
                cmdId,
                `Failed to disable memfs: ${errorText}`,
                false,
                msg,
              );
            } finally {
              setCommandRunning(false);
            }

            return { submitted: true };
          }

          // Unknown subcommand
          cmd.fail(
            `Unknown subcommand: "${subcommand}". Run /memfs help for usage.`,
          );
          return { submitted: true };
        }

        // /skills - browse available skills overlay
        if (trimmed === "/skills") {
          startOverlayCommand(
            "skills",
            "/skills",
            "Opening skills browser...",
            "Skills browser dismissed",
          );
          setActiveOverlay("skills");
          return { submitted: true };
        }

        // /skill-creator - enter skill creation mode
        if (
          trimmed === "/skill-creator" ||
          trimmed.startsWith("/skill-creator ")
        ) {
          const [, ...rest] = trimmed.split(/\s+/);
          const description = rest.join(" ").trim();

          const initialOutput = description
            ? `Starting skill creation for: ${description}`
            : "Starting skill creation. I’ll load the creating-skills skill and ask a few questions about the skill you want to build...";

          const cmd = commandRunner.start(msg, initialOutput);

          // Check for pending approvals before sending
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /skill-creator.",
            );
            return { submitted: false }; // Keep /skill in input box, user handles approval first
          }

          setCommandRunning(true);

          try {
            // Import the skill-creation prompt
            const { SKILL_CREATOR_PROMPT } = await import(
              "../../agent/promptAssets.js"
            );

            // Build system-reminder content for skill creation
            const userDescriptionLine = description
              ? `\n\nUser-provided skill description:\n${description}`
              : "\n\nThe user did not provide a description with /skill-creator. Ask what kind of skill they want to create before proceeding.";

            const skillMessage = `${SYSTEM_REMINDER_OPEN}\n${SKILL_CREATOR_PROMPT}${userDescriptionLine}\n${SYSTEM_REMINDER_CLOSE}`;

            // Mark command as finished before sending message
            cmd.finish(
              "Entered skill creation mode. Answer the assistant’s questions to design your new skill.",
              true,
            );

            // Process conversation with the skill-creation prompt
            await processConversationWithQueuedApprovals([
              {
                type: "message",
                role: "user",
                content: buildTextParts(skillMessage),
                otid: randomUUID(),
              },
            ]);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return { submitted: true };
        }

        // Special handling for /remember command - remember something from conversation
        if (trimmed.startsWith("/remember")) {
          // Extract optional description after `/remember`
          const [, ...rest] = trimmed.split(/\s+/);
          const userText = rest.join(" ").trim();

          const initialOutput = userText
            ? "Storing to memory..."
            : "Processing memory request...";

          const cmd = commandRunner.start(msg, initialOutput);

          // Check for pending approvals before sending (mirrors regular message flow)
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /remember.",
            );
            return { submitted: false }; // Keep /remember in input box, user handles approval first
          }

          setCommandRunning(true);

          try {
            // Import the remember prompt
            const { REMEMBER_PROMPT } = await import(
              "../../agent/promptAssets.js"
            );

            // Build system-reminder content for memory request
            const rememberReminder = userText
              ? `${SYSTEM_REMINDER_OPEN}\n${REMEMBER_PROMPT}\n${SYSTEM_REMINDER_CLOSE}`
              : `${SYSTEM_REMINDER_OPEN}\n${REMEMBER_PROMPT}\n\nThe user did not specify what to remember. Look at the recent conversation context to identify what they likely want you to remember, or ask them to clarify.\n${SYSTEM_REMINDER_CLOSE}`;
            const rememberParts = userText
              ? buildTextParts(rememberReminder, userText)
              : buildTextParts(rememberReminder);

            // Mark command as finished before sending message
            cmd.finish(
              userText
                ? "Storing to memory..."
                : "Processing memory request from conversation context...",
              true,
            );

            // Process conversation with the remember prompt
            await processConversationWithQueuedApprovals([
              {
                type: "message",
                role: "user",
                content: rememberParts,
                otid: randomUUID(),
              },
            ]);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return { submitted: true };
        }

        // Special handling for /reflect command - manually launch reflection subagent
        if (trimmed === "/reflect") {
          const cmd = commandRunner.start(msg, "Launching reflection agent...");

          if (!settingsManager.isMemfsEnabled(agentId)) {
            cmd.fail(
              "Memory filesystem is not enabled. Use /remember instead.",
            );
            return { submitted: true };
          }

          const reflectConversationId = conversationIdRef.current ?? "default";
          if (hasActiveReflectionSubagent(agentId, reflectConversationId)) {
            cmd.fail(
              "A reflection agent is already running in the background.",
            );
            return { submitted: true };
          }

          try {
            const reflectionConversationId = conversationIdRef.current;

            // Fetch the agent's system prompt so the reflection payload includes
            // the core behavioural instructions (filtered to strip dynamic content).
            let systemPrompt: string | undefined;
            try {
              const agent = await getBackend().retrieveAgent(agentId);
              systemPrompt = agent.system ?? undefined;
            } catch {
              // Non-fatal — the reflection payload will just omit the system prompt.
            }

            const autoPayload = await buildAutoReflectionPayload(
              agentId,
              reflectionConversationId,
              systemPrompt,
            );

            if (!autoPayload) {
              cmd.fail("No new transcript content to reflect on.");
              return { submitted: true };
            }

            const memoryDir = getScopedMemoryFilesystemRoot(agentId);
            const parentMemory = await buildParentMemorySnapshot(memoryDir);
            const reflectionPrompt = buildReflectionSubagentPrompt({
              transcriptPath: autoPayload.payloadPath,
              memoryDir,
              parentMemory,
            });

            const {
              spawnBackgroundSubagentTask,
              waitForBackgroundSubagentAgentId,
            } = await import("../../tools/impl/Task");
            const { subagentId } = spawnBackgroundSubagentTask({
              subagentType: "reflection",
              prompt: reflectionPrompt,
              description: "Reflecting on conversation",
              silentCompletion: true,
              parentScope: {
                agentId,
                conversationId: reflectionConversationId,
              },
              onComplete: async ({
                success,
                error,
                agentId: reflectionAgentId,
              }) => {
                telemetry.trackReflectionEnd("manual", success, {
                  subagentId: reflectionAgentId ?? undefined,
                  conversationId: reflectionConversationId,
                  error,
                });
                await finalizeAutoReflectionPayload(
                  agentId,
                  reflectionConversationId,
                  autoPayload.payloadPath,
                  autoPayload.endSnapshotLine,
                  success,
                );

                const msg = await handleMemorySubagentCompletion(
                  {
                    agentId,
                    conversationId: conversationIdRef.current,
                    subagentType: "reflection",
                    success,
                    error,
                  },
                  {
                    recompileByConversation:
                      systemPromptRecompileByConversationRef.current,
                    recompileQueuedByConversation:
                      queuedSystemPromptRecompileByConversationRef.current,
                    logRecompileFailure: (message) =>
                      debugWarn("memory", message),
                  },
                );
                appendTaskNotificationEvents([msg]);
              },
            });
            const reflectionAgentId = await waitForBackgroundSubagentAgentId(
              subagentId,
              1000,
            );
            telemetry.trackReflectionStart("manual", {
              subagentId: reflectionAgentId ?? undefined,
              conversationId: reflectionConversationId,
              startMessageId: autoPayload.startMessageId,
              endMessageId: autoPayload.endMessageId,
            });

            cmd.finish(
              `Reflecting on the recent conversation. View the transcript here: ${autoPayload.payloadPath}`,
              true,
            );
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed to start reflection agent: ${errorDetails}`);
          }

          return { submitted: true };
        }

        // Special handling for /plan command - enter plan mode
        if (trimmed === "/plan") {
          // Generate plan file path and enter plan mode
          const planPath = generatePlanFilePath();
          permissionMode.setPlanFilePath(planPath);
          cacheLastPlanFilePath(planPath);
          permissionMode.setMode("plan");
          setUiPermissionMode("plan");

          const cmd = commandRunner.start(
            "/plan",
            `Plan mode enabled. Plan file: ${planPath}`,
          );
          cmd.finish(`Plan mode enabled. Plan file: ${planPath}`, true);

          return { submitted: true };
        }

        // Special handling for /init command
        if (trimmed === "/init") {
          const cmd = commandRunner.start(msg, "Gathering project context...");

          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /init.",
            );
            return { submitted: false };
          }

          // Interactive init: the primary agent conducts the flow,
          // asks the user questions, and runs the initializing-memory skill.
          setCommandRunning(true);
          try {
            cmd.finish(
              "Building your memory palace... Start a new conversation with `letta --new` to work in parallel.",
              true,
            );

            const { context: gitContext } = gatherInitGitContext();
            const memoryDir = settingsManager.isMemfsEnabled(agentId)
              ? getScopedMemoryFilesystemRoot(agentId)
              : undefined;

            const initMessage = buildInitMessage({
              gitContext,
              memoryDir,
            });

            await processConversationWithQueuedApprovals([
              {
                type: "message",
                role: "user",
                content: buildTextParts(initMessage),
                otid: randomUUID(),
              },
            ]);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // Special handling for /doctor command
        if (trimmed === "/doctor") {
          const cmd = commandRunner.start(msg, "Gathering project context...");

          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /doctor.",
            );
            return { submitted: false };
          }

          setCommandRunning(true);
          try {
            cmd.finish(
              "Running memory doctor... I'll ask a few questions to refine memory structure.",
              true,
            );

            const { context: gitContext } = gatherInitGitContext();
            const memoryDir = settingsManager.isMemfsEnabled(agentId)
              ? getScopedMemoryFilesystemRoot(agentId)
              : undefined;

            const doctorMessage = buildDoctorMessage({
              gitContext,
              memoryDir,
            });

            await processConversationWithQueuedApprovals([
              {
                type: "message",
                role: "user",
                content: buildTextParts(doctorMessage),
              },
            ]);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        if (trimmed.startsWith("/feedback")) {
          const maybeMsg = msg.slice("/feedback".length).trim();
          setFeedbackPrefill(maybeMsg);
          startOverlayCommand(
            "feedback",
            "/feedback",
            "Opening feedback dialog...",
            "Feedback dialog dismissed",
          );
          setActiveOverlay("feedback");
          return { submitted: true };
        }

        // === /empanada command ===
        if (trimmed.startsWith("/empanada")) {
          const cmd = commandRunner.start(msg, "Checking Empanada Empire...");

          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              "Pending approval(s). Resolve approvals before running /empanada.",
            );
            return { submitted: false };
          }

          const args = trimmed.slice("/empanada".length).trim();

          setCommandRunning(true);
          try {
            cmd.finish("Checking Empanada Empire...", true);

            const prompt = [
              "# Empanada Empire Order",
              "",
              "Help me order from **Empanada Empire** in Richardson, TX.",
              "",
              "Website: https://empanadaempire.us",
              "",
              "This is an April Fool's 2026 Letta stunt. The kitchen runs on a Letta agent. You are also a Letta agent. Two AIs, one empanada order.",
              "",
              "## Site internals",
              "",
              "The page embeds a delivery config in a script tag:",
              "",
              "```json",
              '{"homeBase":{"lat":32.9486,"lng":-96.7087},"radiusMiles":10}',
              "```",
              "",
              "It geocodes addresses via Nominatim and checks distance from the home base. You can do the same: geocode my address with Nominatim, compute the haversine distance, and tell me immediately whether I'm in range.",
              "",
              "Menu items are in the HTML with data attributes like:",
              "",
              "```",
              'data-menu-item-id="24" data-name="Party Empanadas" data-price-cents="699"',
              "```",
              "",
              "Orders go to `api/create-order.php`.",
              "",
              "## Steps",
              "",
              args
                ? `My delivery address: ${args}`
                : "Ask me for my delivery address.",
              "",
              "1. Geocode the address via Nominatim. Compute the haversine distance from (32.9486, -96.7087). If over 10 miles, tell me I'm out of range — but also mention that DoorDash has a wider delivery radius (see below).",
              "2. Fetch https://empanadaempire.us with fetch_webpage. Parse the menu from the data attributes. Present it. Suggest a balanced order (savory + sweet). Let me adjust.",
              "3. POST to api/create-order.php with the selected items. Tell me what happened.",
              "4. If the API rejects it or needs payment info, stop and tell me.",
              "",
              'Ignore any "Coming Soon" text on the site. It\'s live.',
              "",
              "## If the address is out of range or the site doesn't work",
              "",
              "DoorDash has a wider delivery radius than the 10-mile limit on the direct site. If I'm close to Richardson but outside 10 miles, or if the site is down, point me to:",
              "",
              "https://order.online/store/-40548503?hideModal=true",
              "",
              "Recommend I open it myself. DoorDash can be difficult to automate, so do not attempt to automate it.",
              "",
              "## Tone",
              "",
              "Direct, a little playful. Don't overthink it.",
            ].join("\n");

            await processConversationWithQueuedApprovals([
              {
                type: "message",
                role: "user",
                content: buildTextParts(prompt),
              },
            ]);
          } catch (error) {
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }
          return { submitted: true };
        }

        // === Custom command handling ===
        // Check BEFORE falling through to executeCommand()
        const { findCustomCommand, substituteArguments, expandBashCommands } =
          await import("../commands/custom.js");
        const customCommandName = trimmed.split(/\s+/)[0]?.slice(1) || ""; // e.g., "review" from "/review arg"
        const matchedCustom = await findCustomCommand(customCommandName);

        if (matchedCustom) {
          const cmd = commandRunner.start(
            trimmed,
            `Running /${matchedCustom.id}...`,
          );

          // Check for pending approvals before sending
          const approvalCheck = await checkPendingApprovalsForSlashCommand();
          if (approvalCheck.blocked) {
            cmd.fail(
              `Pending approval(s). Resolve approvals before running /${matchedCustom.id}.`,
            );
            return { submitted: false }; // Keep custom command in input box, user handles approval first
          }

          // Extract arguments (everything after command name)
          const args = trimmed.slice(`/${matchedCustom.id}`.length).trim();

          // Build prompt: 1) substitute args, 2) expand bash commands
          let prompt = substituteArguments(matchedCustom.content, args);
          prompt = await expandBashCommands(prompt);

          // Show command in transcript (running phase for visual feedback)
          setCommandRunning(true);

          try {
            // Mark command as finished BEFORE sending to agent
            // (matches /remember pattern - command succeeded in triggering agent)
            cmd.finish("Running custom command...", true);

            // Send prompt to agent
            // NOTE: Unlike /remember, we DON'T append args separately because
            // they're already substituted into the prompt via $ARGUMENTS
            await processConversationWithQueuedApprovals([
              {
                type: "message",
                role: "user",
                content: buildTextParts(
                  `${SYSTEM_REMINDER_OPEN}\n${prompt}\n${SYSTEM_REMINDER_CLOSE}`,
                ),
                otid: randomUUID(),
              },
            ]);
          } catch (error) {
            // Only catch errors from processConversation setup, not agent execution
            const errorDetails = formatErrorDetails(error, agentId);
            cmd.fail(`Failed to run command: ${errorDetails}`);
          } finally {
            setCommandRunning(false);
          }

          return { submitted: true };
        }
        // === END custom command handling ===

        // Check if this is a known command before treating it as a slash command
        const { commands, executeCommand } = await import(
          "../commands/registry"
        );
        const registryCommandName = trimmed.split(/\s+/)[0] ?? "";
        const isRegistryCommand = Boolean(commands[registryCommandName]);
        const registryCmd = isRegistryCommand
          ? commandRunner.start(msg, `Running ${registryCommandName}...`)
          : null;
        const result = await executeCommand(aliasedMsg);

        // If command not found, try user-invocable skills before falling through.
        if (result.notFound) {
          if (registryCmd) {
            registryCmd.fail(`Unknown command: ${registryCommandName}`);
          }

          const skillCommandName = registryCommandName.slice(1);
          const { discoverClientSideSkills } = await import(
            "../../agent/clientSkills"
          );
          const { getSkillSources } = await import("../../agent/context");
          const { isUserInvocableSkill } = await import("../../agent/skills");
          const skillDiscovery = await discoverClientSideSkills({
            agentId,
            skillSources: getSkillSources(),
          });
          const matchedSkill = skillDiscovery.skills.find(
            (skill) =>
              skill.id === skillCommandName && isUserInvocableSkill(skill),
          );

          if (matchedSkill) {
            const cmd = commandRunner.start(
              trimmed,
              `Running /${matchedSkill.id}...`,
            );

            const approvalCheck = await checkPendingApprovalsForSlashCommand();
            if (approvalCheck.blocked) {
              cmd.fail(
                `Pending approval(s). Resolve approvals before running /${matchedSkill.id}.`,
              );
              return { submitted: false };
            }

            const args = trimmed.slice(`/${matchedSkill.id}`.length).trim();
            setCommandRunning(true);
            try {
              const { loadRenderedSkillContent, wrapSkillContent } =
                await import("../../tools/impl/Skill");
              const skillContent = await loadRenderedSkillContent(
                matchedSkill.id,
                {
                  agentId,
                  args,
                  allowDisabledModelInvocation: true,
                },
              );
              cmd.finish("Running skill...", true);
              await processConversationWithQueuedApprovals([
                {
                  type: "message",
                  role: "user",
                  content: buildTextParts(
                    wrapSkillContent(matchedSkill.id, skillContent),
                  ),
                  otid: randomUUID(),
                },
              ]);
            } catch (error) {
              const errorDetails = formatErrorDetails(error, agentId);
              cmd.fail(`Failed to run skill: ${errorDetails}`);
            } finally {
              setCommandRunning(false);
            }

            return { submitted: true };
          }
          // Don't treat as command - continue to regular message handling below
        } else {
          // Known command - show in transcript and handle result
          if (registryCmd) {
            registryCmd.finish(result.output, result.success);
          }
          return { submitted: true }; // Don't send commands to Letta agent
        }
      }

      // Build message content from display value (handles placeholders for text/images)
      const contentParts =
        overrideContentParts ?? buildMessageContentFromDisplay(msg);

      // Prepend ralph mode reminder if in ralph mode
      let ralphModeReminder = "";
      if (ralphMode.getState().isActive) {
        if (justActivatedRalph) {
          // First turn - use full first turn reminder, don't increment (already at 1)
          const ralphState = ralphMode.getState();
          ralphModeReminder = `${buildRalphFirstTurnReminder(ralphState)}\n\n`;
        } else {
          // Continuation after ESC - increment iteration and use shorter reminder
          ralphMode.incrementIteration();
          const ralphState = ralphMode.getState();
          ralphModeReminder = `${buildRalphContinuationReminder(ralphState)}\n\n`;
        }
      }

      // Inject SessionStart hook feedback (stdout on exit 2) into first message only
      let sessionStartHookFeedback = "";
      if (sessionStartFeedbackRef.current.length > 0) {
        sessionStartHookFeedback = `${SYSTEM_REMINDER_OPEN}\n[SessionStart hook context]:\n${sessionStartFeedbackRef.current.join("\n")}\n${SYSTEM_REMINDER_CLOSE}\n\n`;
        // Clear after injecting so it only happens once
        sessionStartFeedbackRef.current = [];
      }

      // Build bash command prefix if there are cached commands
      let bashCommandPrefix = "";
      if (bashCommandCacheRef.current.length > 0) {
        bashCommandPrefix = `${SYSTEM_REMINDER_OPEN}
The messages below were generated by the user while running local commands using "bash mode" in the Letta Code CLI tool.
DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.
${SYSTEM_REMINDER_CLOSE}
`;
        for (const cmd of bashCommandCacheRef.current) {
          bashCommandPrefix += `<bash-input>${cmd.input}</bash-input>\n<bash-output>${cmd.output}</bash-output>\n`;
        }
        // Clear the cache after building the prefix
        bashCommandCacheRef.current = [];
      }

      const reflectionSettings = getReflectionSettings(agentId);
      const memfsEnabledForAgent = settingsManager.isMemfsEnabled(agentId);

      // Build git memory sync reminder if uncommitted changes or unpushed commits
      let memoryGitReminder = "";
      const gitStatus = pendingGitReminderRef.current;
      if (gitStatus) {
        memoryGitReminder = `${SYSTEM_REMINDER_OPEN}
MEMORY SYNC: Your memory directory has uncommitted changes or is ahead of the remote.

${gitStatus.summary}

Sync when convenient by running these commands:
\`\`\`bash
cd ~/.letta/agents/${agentId}/memory
git add system/
git commit -m "<type>: <what changed>"
git push
\`\`\`

You should do this soon to avoid losing memory updates. It only takes a few seconds.
${SYSTEM_REMINDER_CLOSE}
`;
        // Clear after injecting so it doesn't repeat
        pendingGitReminderRef.current = null;
      }

      // Combine reminders with content as separate text parts.
      // This preserves each reminder boundary in the API payload.
      // Note: Task notifications now come through queueDisplay directly (added by messageQueueBridge)
      const reminderParts: Array<{ type: "text"; text: string }> = [];
      const pushReminder = (text: string) => {
        if (!text) return;
        reminderParts.push({ type: "text", text });
      };
      const maybeLaunchReflectionSubagent = async (
        triggerSource: "step-count" | "compaction-event",
      ) => {
        if (!memfsEnabledForAgent) {
          return false;
        }
        const autoReflectConversationId =
          conversationIdRef.current ?? "default";
        if (hasActiveReflectionSubagent(agentId, autoReflectConversationId)) {
          debugLog(
            "memory",
            `Skipping auto reflection launch (${triggerSource}) because one is already active`,
          );
          return false;
        }
        try {
          const reflectionConversationId = conversationIdRef.current;

          // Fetch the agent's system prompt so the reflection payload includes
          // the core behavioural instructions (filtered to strip dynamic content).
          let systemPrompt: string | undefined;
          try {
            const agent = await getBackend().retrieveAgent(agentId);
            systemPrompt = agent.system ?? undefined;
          } catch {
            // Non-fatal — the reflection payload will just omit the system prompt.
          }

          const autoPayload = await buildAutoReflectionPayload(
            agentId,
            reflectionConversationId,
            systemPrompt,
          );
          if (!autoPayload) {
            debugLog(
              "memory",
              `Skipping auto reflection launch (${triggerSource}) because transcript has no new content`,
            );
            return false;
          }

          const memoryDir = getScopedMemoryFilesystemRoot(agentId);
          const parentMemory = await buildParentMemorySnapshot(memoryDir);
          const reflectionPrompt = buildReflectionSubagentPrompt({
            transcriptPath: autoPayload.payloadPath,
            memoryDir,
            parentMemory,
          });

          const {
            spawnBackgroundSubagentTask,
            waitForBackgroundSubagentAgentId,
          } = await import("../../tools/impl/Task");
          const { subagentId } = spawnBackgroundSubagentTask({
            subagentType: "reflection",
            prompt: reflectionPrompt,
            description: AUTO_REFLECTION_DESCRIPTION,
            silentCompletion: true,
            parentScope: {
              agentId,
              conversationId: reflectionConversationId,
            },
            onComplete: async ({
              success,
              error,
              agentId: reflectionAgentId,
            }) => {
              telemetry.trackReflectionEnd(triggerSource, success, {
                subagentId: reflectionAgentId ?? undefined,
                conversationId: reflectionConversationId,
                error,
              });
              await finalizeAutoReflectionPayload(
                agentId,
                reflectionConversationId,
                autoPayload.payloadPath,
                autoPayload.endSnapshotLine,
                success,
              );

              const msg = await handleMemorySubagentCompletion(
                {
                  agentId,
                  conversationId: conversationIdRef.current,
                  subagentType: "reflection",
                  success,
                  error,
                },
                {
                  recompileByConversation:
                    systemPromptRecompileByConversationRef.current,
                  recompileQueuedByConversation:
                    queuedSystemPromptRecompileByConversationRef.current,
                  logRecompileFailure: (message) =>
                    debugWarn("memory", message),
                },
              );
              appendTaskNotificationEvents([msg]);
            },
          });
          const reflectionAgentId = await waitForBackgroundSubagentAgentId(
            subagentId,
            1000,
          );
          telemetry.trackReflectionStart(triggerSource, {
            subagentId: reflectionAgentId ?? undefined,
            conversationId: reflectionConversationId,
            startMessageId: autoPayload.startMessageId,
            endMessageId: autoPayload.endMessageId,
          });
          debugLog(
            "memory",
            `Auto-launched reflection subagent (${triggerSource})`,
          );
          return true;
        } catch (error) {
          debugWarn(
            "memory",
            `Failed to auto-launch reflection subagent (${triggerSource}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
      };
      syncReminderStateFromContextTracker(
        sharedReminderStateRef.current,
        contextTrackerRef.current,
      );
      const { getSkillSources } = await import("../../agent/context");
      const { parts: sharedReminderParts } = await buildSharedReminderParts({
        mode: "interactive",
        agent: {
          id: agentId,
          name: agentName,
          description: agentDescription,
          lastRunAt: agentLastRunAt,
          conversationId: conversationIdRef.current,
        },
        state: sharedReminderStateRef.current,
        systemInfoReminderEnabled,
        reflectionSettings,
        skillSources: getSkillSources(),
        resolvePlanModeReminder: getPlanModeReminder,
        maybeLaunchReflectionSubagent,
      });
      for (const part of sharedReminderParts) {
        reminderParts.push(part);
      }
      // Build conversation switch alert if a switch is pending (behind feature flag)
      let conversationSwitchAlert = "";
      if (
        pendingConversationSwitchRef.current &&
        settingsManager.getSetting("conversationSwitchAlertEnabled")
      ) {
        const { buildConversationSwitchAlert } = await import(
          "../helpers/conversationSwitchAlert"
        );
        conversationSwitchAlert = buildConversationSwitchAlert(
          pendingConversationSwitchRef.current,
        );
      }
      pendingConversationSwitchRef.current = null;

      pushReminder(sessionStartHookFeedback);
      pushReminder(conversationSwitchAlert);
      pushReminder(ralphModeReminder);
      pushReminder(bashCommandPrefix);
      pushReminder(userPromptSubmitHookFeedback);
      pushReminder(memoryGitReminder);
      const messageContent =
        reminderParts.length > 0
          ? [...reminderParts, ...contentParts]
          : contentParts;

      // Append task notifications (if any) as event lines before the user message
      appendTaskNotificationEvents(taskNotifications);

      // Append an optimistic user row now, then reconcile it with the echoed
      // user_message chunk once the server returns the canonical message.id.
      const userOtid = createClientOtid();
      const optimisticUserLineId = appendOptimisticUserLine(
        buffersRef.current,
        userTextForInput,
        userOtid,
      );
      const transcriptStartLineIndex = userTextForInput
        ? Math.max(0, toLines(buffersRef.current).length - 1)
        : null;

      // Reset token counter for this turn (only count the agent's response)
      buffersRef.current.tokenCount = 0;
      // If the previous trajectory ended, ensure the live token display resets.
      if (!sessionStatsRef.current.getTrajectorySnapshot()) {
        trajectoryTokenDisplayRef.current = 0;
        setTrajectoryTokenBase(0);
        trajectoryRunTokenStartRef.current = 0;
      }
      // Clear interrupted flag from previous turn
      buffersRef.current.interrupted = false;
      // Rotate to a new thinking message for this turn
      setThinkingMessage(getRandomThinkingVerb());
      // Show streaming state immediately for responsiveness (pending approval check takes ~100ms)
      setStreaming(true);
      openTrajectorySegment();
      refreshDerived();

      // Check for pending approvals before sending message (skip if we already have
      // a queued approval response to send first).
      // Only do eager check when resuming a session (LET-7101) - otherwise lazy recovery handles it
      let eagerRecoveryDenials: ApprovalResult[] | null = null;
      if (needsEagerApprovalCheck && !queuedApprovalResults) {
        // Log for debugging
        const eagerStatusId = uid("status");
        buffersRef.current.byId.set(eagerStatusId, {
          kind: "status",
          id: eagerStatusId,
          lines: [
            "[EAGER CHECK] Checking for pending approvals (resume mode)...",
          ],
        });
        buffersRef.current.order.push(eagerStatusId);
        refreshDerived();

        try {
          // Fetch fresh agent state to check for pending approvals with accurate in-context messages
          const agent = await getBackend().retrieveAgent(agentId);
          const { pendingApprovals: existingApprovals } =
            await getResumeDataFromBackend(agent, conversationIdRef.current);

          // Remove eager check status
          buffersRef.current.byId.delete(eagerStatusId);
          buffersRef.current.order = buffersRef.current.order.filter(
            (id: string) => id !== eagerStatusId,
          );

          // Check if user cancelled while we were fetching approval state
          if (
            userCancelledRef.current ||
            abortControllerRef.current?.signal.aborted
          ) {
            // User hit ESC during the check - abort and clean up
            if (optimisticUserLineId) {
              buffersRef.current.byId.delete(optimisticUserLineId);
              const orderIndex =
                buffersRef.current.order.indexOf(optimisticUserLineId);
              if (orderIndex !== -1) {
                buffersRef.current.order.splice(orderIndex, 1);
              }
            }
            setStreaming(false);
            refreshDerived();
            return { submitted: false };
          }

          if (existingApprovals && existingApprovals.length > 0) {
            eagerRecoveryDenials = buildFreshDenialApprovals(
              existingApprovals,
              STALE_APPROVAL_RECOVERY_DENIAL_REASON,
            ) as ApprovalResult[];
          }
          setNeedsEagerApprovalCheck(false);
        } catch (_error) {
          // If check fails, proceed anyway (don't block user)
        }
      }

      // Start the conversation loop. If we have queued approval results from an interrupted
      // client-side execution, send them first before the new user message.
      const initialInput: Array<MessageCreate | ApprovalCreate> = [];

      if (eagerRecoveryDenials && eagerRecoveryDenials.length > 0) {
        initialInput.push({
          type: "approval",
          approvals: eagerRecoveryDenials,
          otid: randomUUID(),
        });
      }

      const queuedApprovalInput =
        consumeQueuedApprovalInputForCurrentConversation();
      if (queuedApprovalInput) {
        initialInput.push(queuedApprovalInput);
      }

      initialInput.push({
        type: "message",
        role: "user",
        content: messageContent as unknown as MessageCreate["content"],
        otid: userOtid,
      });

      await processConversation(initialInput, {
        submissionGeneration,
        transcriptStartLineIndex,
      });

      // Clean up placeholders after submission
      clearPlaceholdersInText(msg);

      return { submitted: true };
    },
    [
      streaming,
      commandRunning,
      processConversation,
      refreshDerived,
      agentId,
      agentName,
      agentDescription,
      agentLastRunAt,
      conversationId,
      currentModelHandle,
      currentModelId,
      effectiveContextWindowSize,
      commandRunner,
      handleExit,
      isExecutingTool,
      queuedApprovalResults,
      consumeQueuedApprovalInputForCurrentConversation,
      pendingApprovals,
      profileConfirmPending,
      handleAgentSelect,
      startOverlayCommand,
      tokenStreamingEnabled,
      isAgentBusy,
      setStreaming,
      setCommandRunning,
      pendingRalphConfig,
      openTrajectorySegment,
      resetTrajectoryBases,
      systemInfoReminderEnabled,
      appendTaskNotificationEvents,
      maybeCarryOverActiveConversationModel,
      setConversationAutoTitleEligibility,
      setConversationIdAndRef,
    ],
  );

  return onSubmit;
}
