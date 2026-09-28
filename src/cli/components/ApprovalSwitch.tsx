import { memo } from "react";
import {
  type AskUserQuestion,
  parseAskUserQuestions,
} from "@/cli/helpers/ask-user-questions";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
  isTaskTool,
} from "@/cli/helpers/tool-name-mapping.js";
import { InlineBashApproval } from "./InlineBashApproval";
import { InlineFileEditApproval } from "./InlineFileEditApproval";
import { InlineGenericApproval } from "./InlineGenericApproval";
import { InlineQuestionApproval } from "./InlineQuestionApproval";
import { InlineTaskApproval } from "./InlineTaskApproval";

// Types for parsed tool data
type BashInfo = {
  toolName: string;
  command: string;
  description?: string;
};

type FileEditInfo = {
  toolName: string;
  filePath: string;
  content?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  patchInput?: string;
  toolCallId?: string;
};

type TaskInfo = {
  subagentType: string;
  description: string;
  prompt: string;
  model?: string;
  isBackground?: boolean;
};

type Props = {
  approval: ApprovalRequest;

  // Common handlers
  onApprove: (diffs?: Map<string, AdvancedDiffSuccess>) => void;
  onApproveAlways: (
    scope: "project" | "session",
    diffs?: Map<string, AdvancedDiffSuccess>,
  ) => void;
  onDeny: (reason: string) => void;
  onCancel?: () => void;
  isFocused?: boolean;
  approveAlwaysText?: string;
  allowPersistence?: boolean;
  showPreview?: boolean;
  defaultScope?: "project" | "session";

  // Special handlers for AskUserQuestion
  onQuestionSubmit?: (answers: Record<string, string>) => void;

  // External data for FileEdit approvals
  precomputedDiff?: AdvancedDiffSuccess;
  allDiffs?: Map<string, AdvancedDiffSuccess>;
};

// Parse bash info from approval args
function getBashInfo(approval: ApprovalRequest): BashInfo | null {
  try {
    const args = JSON.parse(approval.toolArgs || "{}");
    const t = approval.toolName.toLowerCase();

    let command = "";
    let description = "";

    if (t === "exec_command") {
      command = typeof args.cmd === "string" ? args.cmd : "(no command)";
      description =
        typeof args.description === "string" ? args.description : "";
    } else if (t === "write_stdin") {
      const sessionId =
        typeof args.session_id === "string" ||
        typeof args.session_id === "number"
          ? String(args.session_id)
          : "unknown";
      command = `write_stdin ${sessionId}`;
      description =
        typeof args.chars === "string" && args.chars.length > 0
          ? "Write input to running shell session"
          : "Poll running shell session";
    } else {
      // Bash uses command string and description
      command =
        typeof args.command === "string" ? args.command : "(no command)";
      description =
        typeof args.description === "string" ? args.description : "";
    }

    return {
      toolName: approval.toolName,
      command,
      description,
    };
  } catch {
    return null;
  }
}

function isCommandMonitorApproval(approval: ApprovalRequest): boolean {
  if (approval.toolName !== "Monitor") return false;
  try {
    const args = JSON.parse(approval.toolArgs || "{}");
    return typeof args.command === "string";
  } catch {
    return false;
  }
}

// Parse file edit info from approval args
function getFileEditInfo(approval: ApprovalRequest): FileEditInfo | null {
  try {
    const args = JSON.parse(approval.toolArgs || "{}");

    // For patch tools, use the input field
    if (isPatchTool(approval.toolName)) {
      return {
        toolName: approval.toolName,
        filePath: "", // Patch can have multiple files
        patchInput: args.input as string | undefined,
        toolCallId: approval.toolCallId,
      };
    }

    // For regular file edit/write tools
    return {
      toolName: approval.toolName,
      filePath: String(args.file_path || ""),
      content: args.content as string | undefined,
      oldString: args.old_string as string | undefined,
      newString: args.new_string as string | undefined,
      replaceAll: args.replace_all as boolean | undefined,
      toolCallId: approval.toolCallId,
    };
  } catch {
    return null;
  }
}

// Parse task info from approval args
function getTaskInfo(approval: ApprovalRequest): TaskInfo | null {
  try {
    const args = JSON.parse(approval.toolArgs || "{}");
    return {
      subagentType:
        typeof args.subagent_type === "string" ? args.subagent_type : "unknown",
      description:
        typeof args.description === "string"
          ? args.description
          : "(no description)",
      prompt: typeof args.prompt === "string" ? args.prompt : "(no prompt)",
      model: typeof args.model === "string" ? args.model : undefined,
      isBackground: true,
    };
  } catch {
    return {
      subagentType: "unknown",
      description: "(parse error)",
      prompt: "(parse error)",
    };
  }
}

// Parse questions from AskUserQuestion args. Delegates to the shared
// parseAskUserQuestions validator (single source of truth shared with the
// use-approval-flow submit path) so malformed shapes — e.g. `questions` as a
// JSON string, a non-string `question`/`header`/`description`, or a
// non-array/empty `options` — are rejected here and ApprovalSwitch falls
// through to InlineGenericApproval, matching how malformed Bash/Task args are
// handled. InlineQuestionApproval also coerces/filters `options` as
// defense-in-depth, but this gate keeps malformed payloads out of the
// specialized renderer.
export function getQuestions(approval: ApprovalRequest): AskUserQuestion[] {
  return parseAskUserQuestions(approval);
}

/**
 * ApprovalSwitch - Unified approval component that renders the appropriate
 * specialized approval UI based on tool type.
 *
 * This consolidates the approval rendering logic that was previously duplicated
 * in the transcript rendering and fallback UI paths.
 */
export const ApprovalSwitch = memo(
  ({
    approval,
    onApprove,
    onApproveAlways,
    onDeny,
    onCancel,
    isFocused = true,
    approveAlwaysText,
    allowPersistence = true,
    onQuestionSubmit,
    precomputedDiff,
    allDiffs,
    showPreview = true,
    defaultScope = "project",
  }: Props) => {
    const toolName = approval.toolName;

    // File edit/write/patch tools → InlineFileEditApproval
    if (
      isFileEditTool(toolName) ||
      isFileWriteTool(toolName) ||
      isPatchTool(toolName)
    ) {
      const fileEditInfo = getFileEditInfo(approval);
      if (fileEditInfo) {
        return (
          <InlineFileEditApproval
            fileEdit={fileEditInfo}
            precomputedDiff={precomputedDiff}
            allDiffs={allDiffs}
            onApprove={(diffs) => onApprove(diffs)}
            onApproveAlways={(scope, diffs) => onApproveAlways(scope, diffs)}
            onDeny={onDeny}
            onCancel={onCancel}
            isFocused={isFocused}
            approveAlwaysText={approveAlwaysText}
            allowPersistence={allowPersistence}
            defaultScope={defaultScope}
            showPreview={showPreview}
          />
        );
      }
    }

    // Shell/Bash tools → InlineBashApproval
    if (isShellTool(toolName) || isCommandMonitorApproval(approval)) {
      const bashInfo = getBashInfo(approval);
      if (bashInfo) {
        return (
          <InlineBashApproval
            bashInfo={bashInfo}
            onApprove={() => onApprove()}
            onApproveAlways={(scope) => onApproveAlways(scope)}
            onDeny={onDeny}
            onCancel={onCancel}
            isFocused={isFocused}
            approveAlwaysText={approveAlwaysText}
            allowPersistence={allowPersistence}
            defaultScope={defaultScope}
            showPreview={showPreview}
          />
        );
      }
    }

    // AskUserQuestion → InlineQuestionApproval
    // Guard: only render specialized UI if questions are valid, otherwise fall through
    // to InlineGenericApproval (matches pattern for Bash/Task with malformed args)
    if (toolName === "AskUserQuestion" && onQuestionSubmit) {
      const questions = getQuestions(approval);
      if (questions.length > 0) {
        return (
          <InlineQuestionApproval
            questions={questions}
            onSubmit={onQuestionSubmit}
            onCancel={onCancel}
            isFocused={isFocused}
          />
        );
      }
    }

    // Task tool → InlineTaskApproval
    if (isTaskTool(toolName)) {
      const taskInfo = getTaskInfo(approval);
      if (taskInfo) {
        return (
          <InlineTaskApproval
            taskInfo={taskInfo}
            onApprove={() => onApprove()}
            onApproveAlways={(scope) => onApproveAlways(scope)}
            onDeny={onDeny}
            onCancel={onCancel}
            isFocused={isFocused}
            approveAlwaysText={approveAlwaysText}
            allowPersistence={allowPersistence}
          />
        );
      }
    }

    // Fallback → InlineGenericApproval
    return (
      <InlineGenericApproval
        toolName={toolName}
        toolArgs={approval.toolArgs}
        onApprove={() => onApprove()}
        onApproveAlways={(scope) => onApproveAlways(scope)}
        onDeny={onDeny}
        onCancel={onCancel}
        isFocused={isFocused}
        approveAlwaysText={approveAlwaysText}
        allowPersistence={allowPersistence}
        defaultScope={defaultScope}
        showPreview={showPreview}
      />
    );
  },
);

ApprovalSwitch.displayName = "ApprovalSwitch";
