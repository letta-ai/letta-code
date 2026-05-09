import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  applySetMaxContext,
  formatSetMaxContextResult,
} from "../../agent/maxContext";
import { getScopedMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import type { ModelReasoningEffort } from "../../agent/model";
import type { SessionStats } from "../../agent/stats";
import { getAgentContextOverview } from "../../backend/api/agents";
import { getBalanceMetadata } from "../../backend/api/metadata";
import type { PermissionMode } from "../../permissions/mode";
import type { SharedReminderState } from "../../reminders/state";
import { settingsManager } from "../../settings-manager";
import type { ToolsetName } from "../../tools/toolset";
import { formatUsageStats } from "../components/SessionStats";
import {
  type ContextWindowOverview,
  renderContextUsage,
} from "../helpers/contextChart";
import type { ContextTracker } from "../helpers/contextTracker";
import { resetContextHistory } from "../helpers/contextTracker";
import { formatErrorDetails } from "../helpers/errorFormatter";
import { getReflectionSettings } from "../helpers/memoryReminder";
import {
  resolvePromptChar,
  resolveStatusLineConfig,
} from "../helpers/statusLineConfig";
import { formatStatusLineHelp } from "../helpers/statusLineHelp";
import { buildStatusLinePayload } from "../helpers/statusLinePayload";
import { executeStatusLineCommand } from "../helpers/statusLineRuntime";
import type { AppCommandRunner } from "./types";

type SubmitCommandResult = { submitted: boolean };

type DiagnosticsCommandContext = {
  agentId: string;
  agentIdRef: MutableRefObject<string>;
  agentName: string | null;
  chromeColumns: number;
  commandRunner: AppCommandRunner;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  conversationIdRef: MutableRefObject<string>;
  currentModelDisplay: string | null;
  currentModelHandle: string | null;
  currentModelId: string | null;
  currentReasoningEffort: ModelReasoningEffort | null;
  currentSystemPromptId: string | null;
  currentToolset: ToolsetName | null;
  effectiveContextWindowSize: number | undefined;
  lastRunIdRef: MutableRefObject<string | null>;
  llmConfigRef: MutableRefObject<LlmConfig | null>;
  networkPhase: "error" | "upload" | "download" | null;
  projectDirectory: string;
  sessionStatsRef: MutableRefObject<SessionStats>;
  setAgentState: Dispatch<SetStateAction<AgentState | null | undefined>>;
  setCommandRunning: (value: boolean) => void;
  setConversationOverrideContextWindowLimit: Dispatch<
    SetStateAction<number | null>
  >;
  setConversationOverrideModelSettings: Dispatch<
    SetStateAction<AgentState["model_settings"] | null>
  >;
  setHasConversationModelOverride: (value: boolean) => void;
  setLlmConfig: Dispatch<SetStateAction<LlmConfig | null>>;
  sharedReminderStateRef: MutableRefObject<SharedReminderState>;
  triggerStatusLineRefresh: () => void;
  uiPermissionMode: PermissionMode;
};

export async function handleDiagnosticsCommand(
  trimmed: string,
  ctx: DiagnosticsCommandContext,
): Promise<SubmitCommandResult | null> {
  const {
    agentId,
    agentIdRef,
    agentName,
    chromeColumns,
    commandRunner,
    contextTrackerRef,
    conversationIdRef,
    currentModelDisplay,
    currentModelHandle,
    currentModelId,
    currentReasoningEffort,
    currentSystemPromptId,
    currentToolset,
    effectiveContextWindowSize,
    lastRunIdRef,
    llmConfigRef,
    networkPhase,
    projectDirectory,
    sessionStatsRef,
    setAgentState,
    setCommandRunning,
    setConversationOverrideContextWindowLimit,
    setConversationOverrideModelSettings,
    setHasConversationModelOverride,
    setLlmConfig,
    sharedReminderStateRef,
    triggerStatusLineRefresh,
    uiPermissionMode,
  } = ctx;

  if (trimmed === "/statusline" || trimmed.startsWith("/statusline ")) {
    const rawArgs = trimmed.slice("/statusline".length).trim();
    const spaceIdx = rawArgs.indexOf(" ");
    const sub =
      spaceIdx === -1 ? rawArgs || "show" : rawArgs.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? "" : rawArgs.slice(spaceIdx + 1).trim();
    const cmd = commandRunner.start(trimmed, "Managing status line...");

    (async () => {
      try {
        const wd = process.cwd();
        if (sub === "help") {
          cmd.finish(formatStatusLineHelp(), true, true);
        } else if (sub === "show") {
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
            const project = settingsManager.getProjectSettings(wd)?.statusLine;
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
          const command = scopeMatch ? rest.slice(0, scopeMatch.index) : rest;
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
            settingsManager.updateProjectSettings({ statusLine: config }, wd);
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
              usedContextTokens: contextTrackerRef.current.lastContextTokens,
              stepCount: stats.usage.stepCount,
              turnCount: sharedReminderStateRef.current.turnCount,
              reflectionMode: getReflectionSettings(agentId).trigger,
              reflectionStepCount: getReflectionSettings(agentId).stepCount,
              memfsEnabled:
                agentId !== "loading"
                  ? settingsManager.isMemfsEnabled(agentId)
                  : false,
              memfsDirectory:
                agentId !== "loading" && settingsManager.isMemfsEnabled(agentId)
                  ? getScopedMemoryFilesystemRoot(agentId)
                  : null,
              permissionMode: uiPermissionMode,
              networkPhase,
              terminalWidth: chromeColumns,
            }),
            { timeout: config.timeout, workingDirectory: wd },
          );
          if (result.ok) {
            cmd.finish(`Output: ${result.text} (${result.durationMs}ms)`, true);
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
              command: settingsManager.getSettings().statusLine?.command ?? "",
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

  if (trimmed === "/usage") {
    const cmd = commandRunner.start(trimmed, "Fetching usage statistics...");

    (async () => {
      try {
        const stats = sessionStatsRef.current.getSnapshot();
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
          // Silently skip balance info if endpoint is not available.
        }

        cmd.finish(formatUsageStats({ stats, balance }), true, true);
      } catch (error) {
        cmd.fail(
          `Error fetching usage: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();

    return { submitted: true };
  }

  if (trimmed === "/context") {
    const contextWindow = effectiveContextWindowSize ?? 0;
    const model = llmConfigRef.current?.model ?? "unknown";
    const usedTokens = contextTrackerRef.current.lastContextTokens;
    const history = contextTrackerRef.current.contextTokensHistory;

    const cmd = commandRunner.start(trimmed, "Fetching context breakdown...");

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
      // Timeout or network error: proceed without breakdown.
    }

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

  if (
    trimmed === "/set-max-context" ||
    trimmed.startsWith("/set-max-context ")
  ) {
    const args = trimmed.slice("/set-max-context".length).trim();
    const cmd = commandRunner.start(trimmed, "Setting max context window...");
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

  return null;
}
