import { memo } from "react";
import { permissionMode } from "../../permissions/mode";
import type { AdvancedDiffSuccess } from "../helpers/diff";
import type { ApprovalRequest } from "../helpers/stream";
import {
  isFileEditTool,
  isFileWriteTool,
  isMemoryTool,
  isPatchTool,
  isShellTool,
  isTaskTool,
} from "../helpers/toolNameMapping.js";
import { InlineBashApproval } from "./InlineBashApproval";
import { InlineEnterPlanModeApproval } from "./InlineEnterPlanModeApproval";
import { InlineFileEditApproval } from "./InlineFileEditApproval";
import { InlineGenericApproval } from "./InlineGenericApproval";
import type { MemoryInfo } from "./InlineMemoryApproval";
import { InlineMemoryApproval } from "./InlineMemoryApproval";
import { InlineQuestionApproval } from "./InlineQuestionApproval";
import { InlineTaskApproval } from "./InlineTaskApproval";
import { StaticPlanApproval } from "./StaticPlanApproval";

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
  edits?: Array<{
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }>;
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

type Question = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
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

  // Special handlers for ExitPlanMode
  onPlanApprove?: (acceptEdits: boolean) => void;
  onPlanKeepPlanning?: (reason: string) => void;

  // Special handlers for AskUserQuestion
  onQuestionSubmit?: (answers: Record<string, string>) => void;

  // Special handlers for EnterPlanMode
  onEnterPlanModeApprove?: () => void;
  onEnterPlanModeReject?: () => void;

  // External data for FileEdit approvals
  precomputedDiff?: AdvancedDiffSuccess;
  allDiffs?: Map<string, AdvancedDiffSuccess>;

  // Plan viewer data (for ExitPlanMode 'o' key)
  planContent?: string;
  planFilePath?: string;
  agentName?: string;
};

// Parse bash info from approval args
function getBashInfo(approval: ApprovalRequest): BashInfo | null {
  try {
    const args = JSON.parse(approval.toolArgs || "{}");
    const t = approval.toolName.toLowerCase();

    let command = "";
    let description = "";

    if (t === "shell") {
      // Shell tool uses command array and justification
      const cmdVal = args.command;
      command = Array.isArray(cmdVal)
        ? cmdVal.join(" ")
        : typeof cmdVal === "string"
          ? cmdVal
          : "(no command)";
      description =
        typeof args.justification === "string" ? args.justification : "";
    } else {
      // Bash/shell_command uses command string and description
      command =
        typeof args.command === "string" ? args.command : "(no command)";
      description =
        typeof args.description === "string"
          ? args.description
          : typeof args.justification === "string"
            ? args.justification
            : "";
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
      edits: args.edits as FileEditInfo["edits"],
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
      isBackground: args.run_in_background === true,
    };
  } catch {
    return {
      subagentType: "unknown",
      description: "(parse error)",
      prompt: "(parse error)",
    };
  }
}

// Parse memory info from approval args
function getMemoryInfo(approval: ApprovalRequest): MemoryInfo | null {
  try {
    const args = JSON.parse(approval.toolArgs || "{}");
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) return null;
    return {
      command,
      reason: typeof args.reason === "string" ? args.reason : undefined,
      path: typeof args.path === "string" ? args.path : undefined,
      oldPath: typeof args.old_path === "string" ? args.old_path : undefined,
      newPath: typeof args.new_path === "string" ? args.new_path : undefined,
      oldString:
        typeof args.old_string === "string" ? args.old_string : undefined,
      newString:
        typeof args.new_string === "string" ? args.new_string : undefined,
      insertLine:
        typeof args.insert_line === "number" ? args.insert_line : undefined,
      insertText:
        typeof args.insert_text === "string" ? args.insert_text : undefined,
      description:
        typeof args.description === "string" ? args.description : undefined,
      fileText: typeof args.file_text === "string" ? args.file_text : undefined,
    };
  } catch {
    return null;
  }
}

// Parse questions from AskUserQuestion args
function getQuestions(approval: ApprovalRequest): Question[] {
  try {
    const args = JSON.parse(approval.toolArgs || "{}");
    return (args.questions as Question[]) || [];
  } catch {
    return [];
  }
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
    onPlanApprove,
    onPlanKeepPlanning,
    onQuestionSubmit,
    onEnterPlanModeApprove,
    onEnterPlanModeReject,
    precomputedDiff,
    allDiffs,
    showPreview = true,
    defaultScope = "project",
    planContent,
    planFilePath,
    agentName,
  }: Props) => {
    const toolName = approval.toolName;

    // 1. ExitPlanMode → StaticPlanApproval
    if (toolName === "ExitPlanMode" && onPlanApprove && onPlanKeepPlanning) {
      const showAcceptEditsOption =
        permissionMode.getMode() === "plan" &&
        permissionMode.getModeBeforePlan() !== "bypassPermissions";
      return (
        <StaticPlanApproval
          onApprove={() => onPlanApprove(false)}
          onApproveAndAcceptEdits={() => onPlanApprove(true)}
          onKeepPlanning={onPlanKeepPlanning}
          onCancel={onCancel ?? (() => {})}
          showAcceptEditsOption={showAcceptEditsOption}
          isFocused={isFocused}
          planContent={planContent}
          planFilePath={planFilePath}
          agentName={agentName}
        />
      );
    }

    // 2. File edit/write/patch tools → InlineFileEditApproval
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

    // 3. Shell/Bash tools → InlineBashApproval
    if (isShellTool(toolName)) {
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

    // 4. EnterPlanMode → InlineEnterPlanModeApproval
    if (
      toolName === "EnterPlanMode" &&
      onEnterPlanModeApprove &&
      onEnterPlanModeReject
    ) {
      return (
        <InlineEnterPlanModeApproval
          onApprove={onEnterPlanModeApprove}
          onReject={onEnterPlanModeReject}
          isFocused={isFocused}
        />
      );
    }

    // 5. AskUserQuestion → InlineQuestionApproval
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

    // 6. Memory tool → InlineMemoryApproval
    if (isMemoryTool(toolName)) {
      const memoryInfo = getMemoryInfo(approval);
      if (memoryInfo) {
        return (
          <InlineMemoryApproval
            memoryInfo={memoryInfo}
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

    // 7. Task tool → InlineTaskApproval
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

    // 8. Fallback → InlineGenericApproval
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
