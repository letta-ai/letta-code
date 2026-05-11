import { APIError } from "@letta-ai/letta-client/core/error";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { getResumeDataFromBackend } from "../../agent/check-approval";
import { settingsManager } from "../../settings-manager";
import { type Buffers, type Line, toLines } from "../helpers/accumulator";
import { backfillBuffers } from "../helpers/backfill";
import type { ContextTracker } from "../helpers/contextTracker";
import { resetContextHistory } from "../helpers/contextTracker";
import type { ConversationSwitchContext } from "../helpers/conversationSwitchAlert";
import type { ApprovalRequest } from "../helpers/stream";
import { uid } from "./ids";
import type { ActiveOverlay, AppCommandRunner, StaticItem } from "./types";

type SubmitCommandResult = { submitted: boolean };

type NavigationCommandContext = {
  agentId: string;
  agentState: AgentState | null | undefined;
  buffersRef: MutableRefObject<Buffers>;
  commandRunner: AppCommandRunner;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  conversationId: string;
  emittedIdsRef: MutableRefObject<Set<string>>;
  hasBackfilledRef: MutableRefObject<boolean>;
  pendingConversationSwitchRef: MutableRefObject<ConversationSwitchContext | null>;
  recoverRestoredPendingApprovals: (
    approvals: ApprovalRequest[],
    options?: { notifyOnManualApproval?: boolean },
  ) => Promise<void>;
  resetBootstrapReminderState: () => void;
  resetDeferredToolCallCommits: () => void;
  resetTrajectoryBases: () => void;
  setActiveOverlay: Dispatch<SetStateAction<ActiveOverlay>>;
  setCommandRunning: (value: boolean) => void;
  setConversationAutoTitleEligibility: (enabled: boolean) => void;
  setConversationIdAndRef: (nextConversationId: string) => void;
  setLines: Dispatch<SetStateAction<Line[]>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setStaticItems: Dispatch<SetStateAction<StaticItem[]>>;
  setStaticRenderEpoch: Dispatch<SetStateAction<number>>;
  startOverlayCommand: (
    overlay: ActiveOverlay,
    input: string,
    openingOutput: string,
    dismissOutput: string,
  ) => void;
};

export async function handleNavigationCommand(
  trimmed: string,
  ctx: NavigationCommandContext,
): Promise<SubmitCommandResult | null> {
  const {
    agentId,
    agentState,
    buffersRef,
    commandRunner,
    contextTrackerRef,
    conversationId,
    emittedIdsRef,
    hasBackfilledRef,
    pendingConversationSwitchRef,
    recoverRestoredPendingApprovals,
    resetBootstrapReminderState,
    resetDeferredToolCallCommits,
    resetTrajectoryBases,
    setActiveOverlay,
    setCommandRunning,
    setConversationAutoTitleEligibility,
    setConversationIdAndRef,
    setLines,
    setSearchQuery,
    setStaticItems,
    setStaticRenderEpoch,
    startOverlayCommand,
  } = ctx;

  // Special handling for /agents command - show agent browser
  if (
    trimmed === "/agents" ||
    trimmed === "/pinned" ||
    trimmed === "/profiles"
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
  if (trimmed.startsWith("/resume")) {
    const parts = trimmed.split(/\s+/);
    const targetConvId = parts[1];

    if (targetConvId === "help") {
      const cmd = commandRunner.start(trimmed, "Showing resume help...");
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
      const cmd = commandRunner.start(trimmed, "Switching conversation...");
      if (targetConvId === conversationId) {
        cmd.finish("Already on this conversation", true);
        return { submitted: true };
      }

      setCommandRunning(true);

      // Pause any active goal for the current conversation before switching
      const resumePrevGoal = conversationId
        ? settingsManager.getConversationGoal(conversationId)
        : null;
      if (resumePrevGoal?.status === "active") {
        settingsManager.updateConversationGoalStatus(conversationId, "paused");
      }

      try {
        if (agentState) {
          const resumeData = await getResumeDataFromBackend(
            agentState,
            targetConvId,
          );

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

          buffersRef.current.byId.clear();
          buffersRef.current.order = [];
          buffersRef.current.tokenCount = 0;
          resetContextHistory(contextTrackerRef.current);
          resetBootstrapReminderState();
          emittedIdsRef.current.clear();
          resetDeferredToolCallCommits();
          setStaticItems([]);
          setStaticRenderEpoch((e) => e + 1);
          resetTrajectoryBases();

          if (resumeData.messageHistory.length > 0) {
            hasBackfilledRef.current = false;
            backfillBuffers(buffersRef.current, resumeData.messageHistory);
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

          if (resumeData.pendingApprovals.length > 0) {
            await recoverRestoredPendingApprovals(resumeData.pendingApprovals);
          }
        }
      } catch (error) {
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

  return null;
}
