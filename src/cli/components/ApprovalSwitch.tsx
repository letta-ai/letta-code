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
  // Draft text from input buffer when approval appeared
  initialDraft?: string;
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

// Parse memory info from approval args (handles both `memory` and `memory_apply_patch`)
function getMemoryInfo(approval: ApprovalRequest): MemoryInfo | null {
  try {
    const args = JSON.parse(approval.toolArgs || "{}");
    const toolName = approval.toolName;

    // memory_apply_patch has { reason, input } — no command field
    if (toolName === "memory_apply_patch") {
      return {
        command: "patch",
        reason: typeof args.reason === "string" ? args.reason : undefined,
        patchInput: typeof args.input === "string" ? args.input : undefined,
      };
    }

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

/** Strip .md extension for display */
function memoryDisplayPath(p: string): string {
  return p.replace(/\.md$/, "");
}

/**
 * For memory commands that are fundamentally file edits (str_replace, create, insert),
 * build a FileEditInfo so we can reuse InlineFileEditApproval's diff rendering.
 * Returns null for commands that don't map to file edits (delete, rename, update_description).
 */
function getMemoryFileEditInfo(
  approval: ApprovalRequest,
): { fileEdit: FileEditInfo; header: string } | null {
  try {
    const args = JSON.parse(approval.toolArgs || "{}");
    const toolName = approval.toolName;
    const memoryDir = process.env.MEMORY_DIR || process.env.LETTA_MEMORY_DIR;

    // memory_apply_patch → pipe through as patch
    if (toolName === "memory_apply_patch") {
      const input = typeof args.input === "string" ? args.input : "";
      return {
        fileEdit: {
          toolName: "memory_apply_patch",
          filePath: "",
          patchInput: input,
          toolCallId: approval.toolCallId,
        },
        header: "Patch memory?",
      };
    }

    const command = typeof args.command === "string" ? args.command : "";
    const relPath = typeof args.path === "string" ? args.path : "";
    const absPath = memoryDir && relPath ? `${memoryDir}/${relPath}` : relPath;
    const display = memoryDisplayPath(relPath);

    if (command === "str_replace") {
      return {
        fileEdit: {
          toolName: "Edit",
          filePath: absPath,
          oldString: typeof args.old_string === "string" ? args.old_string : "",
          newString: typeof args.new_string === "string" ? args.new_string : "",
          replaceAll: args.replace_all === true,
          toolCallId: approval.toolCallId,
        },
        header: `Edit memory ${display}?`,
      };
    }

    if (command === "create") {
      const content = typeof args.file_text === "string" ? args.file_text : "";
      return {
        fileEdit: {
          toolName: "Write",
          filePath: absPath,
          content,
          toolCallId: approval.toolCallId,
        },
        header: `Create memory ${display}?`,
      };
    }

    if (command === "insert") {
      // Insert maps to an edit-style operation; AdvancedDiffRenderer
      // will read the file and show the insertion in context
      const insertText =
        typeof args.insert_text === "string" ? args.insert_text : "";
      return {
        fileEdit: {
          toolName: "Write",
          filePath: absPath,
          content: insertText,
          toolCallId: approval.toolCallId,
        },
        header: `Insert into memory ${display}?`,
      };
    }

    return null;
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
    initialDraft,
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
          initialDraft={initialDraft}
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
            initialDraft={initialDraft}
          />
        );
      }
    }

    // 6. Memory tool → InlineFileEditApproval (for str_replace/create/insert/patch)
    //    or InlineMemoryApproval (for delete/rename/update_description)
    if (isMemoryTool(toolName)) {
      // Try file-edit path first (str_replace, create, insert, memory_apply_patch)
      const memoryEdit = getMemoryFileEditInfo(approval);
      if (memoryEdit) {
        return (
          <InlineFileEditApproval
            fileEdit={memoryEdit.fileEdit}
            precomputedDiff={precomputedDiff}
            allDiffs={allDiffs}
            onApprove={(diffs) => onApprove(diffs)}
            onApproveAlways={(scope, diffs) => onApproveAlways(scope, diffs)}
            onDeny={onDeny}
            onCancel={onCancel}
            isFocused={isFocused}
            approveAlwaysText={
              approveAlwaysText ||
              "Yes, allow memory operations during this session"
            }
            allowPersistence={allowPersistence}
            defaultScope={defaultScope}
            showPreview={showPreview}
            headerOverride={memoryEdit.header}
          />
        );
      }

      // Fallback for delete/rename/update_description
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
