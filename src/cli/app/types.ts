import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { AgentProvenance } from "../../agent/create";
import type { Line } from "../helpers/accumulator";
import type { AdvancedDiffSuccess } from "../helpers/diff";
import type { ApprovalRequest } from "../helpers/stream";

export type AppLoadingState =
  | "assembling"
  | "importing"
  | "initializing"
  | "checking"
  | "ready";

export type AppProps = {
  agentId: string;
  agentState?: AgentState | null;
  conversationId: string; // Required: created at startup
  loadingState?: AppLoadingState;
  continueSession?: boolean;
  startupApproval?: ApprovalRequest | null; // Deprecated: use startupApprovals
  startupApprovals?: ApprovalRequest[];
  messageHistory?: Message[];
  resumedExistingConversation?: boolean; // True if we explicitly resumed via --resume
  tokenStreaming?: boolean;
  reasoningTabCycleEnabled?: boolean;
  showCompactions?: boolean;
  agentProvenance?: AgentProvenance | null;
  releaseNotes?: string | null; // Markdown release notes to display above header
  updateNotification?: string | null; // Latest version when a significant auto-update was applied
  systemInfoReminderEnabled?: boolean;
};

// Items that have finished rendering and no longer change
export type StaticItem =
  | {
      kind: "welcome";
      id: string;
      snapshot: {
        continueSession: boolean;
        agentState?: AgentState | null;
        agentProvenance?: AgentProvenance | null;
        terminalWidth: number;
      };
    }
  | {
      kind: "subagent_group";
      id: string;
      agents: Array<{
        id: string;
        type: string;
        description: string;
        status: "completed" | "error" | "running";
        toolCount: number;
        totalTokens: number;
        agentURL: string | null;
        error?: string;
      }>;
    }
  | {
      // Preview content committed early during approval to enable flicker-free UI
      // When an approval's content is tall enough to overflow the viewport,
      // we commit the preview to static and only show small approval options in dynamic
      kind: "approval_preview";
      id: string;
      toolCallId: string;
      toolName: string;
      toolArgs: string;
      // Optional precomputed/cached data for rendering
      precomputedDiff?: AdvancedDiffSuccess;
      planContent?: string; // For ExitPlanMode
      planFilePath?: string; // For ExitPlanMode
    }
  | Line;
