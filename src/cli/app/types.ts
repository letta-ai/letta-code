import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  Message,
} from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ApprovalDecision,
  ApprovalResult,
} from "@/agent/approval-execution";
import type { AgentProvenance } from "@/agent/create";
import type { PersonalityId } from "@/agent/personality-presets";
import type { CommandHandle, createCommandRunner } from "@/cli/commands/runner";
import type { ModelSelectorSelection } from "@/cli/components/ModelSelector";
import type { Line } from "@/cli/helpers/accumulator";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { ExperimentId } from "@/experiments/types";
import type { ToolExecutionResult } from "@/tools/manager";
import type { ToolsetPreference } from "@/tools/toolset";

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
  conversationSummary?: string | null;
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
  startupHasCloudCredentials?: boolean;
  startupHasAvailableLocalModels?: boolean;
  fileAutocompleteFdPath?: string | null;
  releaseNotes?: string | null; // Markdown release notes to display above header
  updateNotification?: string | null; // Latest version when a significant auto-update was applied
  systemInfoReminderEnabled?: boolean;
  modsDisabled?: boolean;
};

export type ActiveOverlay =
  | "model"
  | "experiment"
  | "worktree-diff"
  | "sleeptime"
  | "compaction"
  | "toolset"
  | "system"
  | "personality"
  | "agent"
  | "resume"
  | "conversations"
  | "search"
  | "subagent"
  | "feedback"
  | "memory"
  | "memfs-sync"
  | "pin"
  | "mcp"
  | "mcp-connect"
  | "install-github-app"
  | "help"
  | "hooks"
  | "connect"
  | "skills"
  | "window-title"
  | "login"
  | null;

export type QueuedOverlayAction =
  | {
      type: "switch_agent";
      agentId: string;
      commandId?: string;
      backendMode?: "local" | "api";
    }
  | {
      type: "switch_model";
      modelId: string;
      modelSelection?: ModelSelectorSelection;
      commandId?: string;
    }
  | {
      type: "set_experiment";
      experimentId: ExperimentId;
      enabled: boolean;
      commandId?: string;
    }
  | {
      type: "set_sleeptime";
      settings: ReflectionSettings;
      commandId?: string;
    }
  | {
      type: "set_compaction";
      mode: string;
      commandId?: string;
    }
  | {
      type: "switch_conversation";
      conversationId: string;
      commandId?: string;
    }
  | {
      type: "switch_toolset";
      toolsetId: ToolsetPreference;
      commandId?: string;
    }
  | { type: "switch_system"; promptId: string; commandId?: string }
  | {
      type: "switch_personality";
      personalityId: PersonalityId;
      commandId?: string;
    }
  | null;

export type AppCommandRunner = Pick<
  ReturnType<typeof createCommandRunner>,
  "start" | "getHandle"
>;

export type CommandStarter = Pick<
  ReturnType<typeof createCommandRunner>,
  "start"
>;

export type QueuedApprovalMetadata = {
  conversationId: string;
  generation: number;
};

export type QueueApprovalResults = (
  results: ApprovalResult[] | null,
  metadata?: QueuedApprovalMetadata,
) => void;

export type ProcessConversationOptions = {
  allowReentry?: boolean;
  submissionGeneration?: number;
  transcriptStartLineIndex?: number | null;
};

export type ProcessConversation = (
  input: Array<MessageCreate | ApprovalCreate>,
  options?: ProcessConversationOptions,
) => Promise<void>;

export type AutoHandledToolResult = {
  toolCallId: string;
  result: ToolExecutionResult;
};

export type AutoDeniedApproval = {
  approval: ApprovalRequest;
  reason: string;
};

export type AutoAllowedExecution = {
  toolCallIds: string[];
  results: ApprovalResult[] | null;
  conversationId: string;
  generation: number;
};

export type AppendErrorOptions =
  | boolean
  | {
      skip?: boolean;
      errorType?: string;
      errorMessage?: string;
      context?: string;
      httpStatus?: number;
      runId?: string;
    };

export type AppendError = (
  message: string,
  options?: AppendErrorOptions,
) => void;

export type OverlayCommandConsumer = (
  overlay: ActiveOverlay,
) => CommandHandle | null;

export type { ApprovalDecision };

// Items that have finished rendering and no longer change
export type StaticItem =
  | {
      kind: "welcome";
      id: string;
      snapshot: {
        continueSession: boolean;
        agentState?: AgentState | null;
        startupHasAvailableLocalModels?: boolean;
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
    }
  | Line;
