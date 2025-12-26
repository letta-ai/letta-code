// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import type React from "react";
import { memo, useEffect, useMemo, useState } from "react";
import type { ApprovalContext } from "../../permissions/analyzer";
import {
  type AdvancedDiffSuccess,
  computeAdvancedDiff,
  parsePatchToAdvancedDiff,
} from "../helpers/diff";
import { parsePatchOperations } from "../helpers/formatArgsDisplay";
import { resolvePlaceholders } from "../helpers/pasteRegistry";
import type { ApprovalRequest } from "../helpers/stream";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

type Props = {
  approvals: ApprovalRequest[];
  approvalContexts: ApprovalContext[];
  progress?: { current: number; total: number };
  totalTools?: number;
  isExecuting?: boolean;
  onApproveAll: (diffs?: Map<string, AdvancedDiffSuccess>) => void;
  onApproveAlways: (
    scope?: "project" | "session",
    diffs?: Map<string, AdvancedDiffSuccess>,
  ) => void;
  onDenyAll: (reason: string) => void;
  onCancel?: () => void; // Cancel all approvals without sending to server
};

type DynamicPreviewProps = {
  toolName: string;
  toolArgs: string;
  parsedArgs: Record<string, unknown> | null;
  precomputedDiff: AdvancedDiffSuccess | null;
  allDiffs: Map<string, AdvancedDiffSuccess>;
  toolCallId: string | undefined;
};

// Options renderer - memoized to prevent unnecessary re-renders
const OptionsRenderer = memo(
  ({
    options,
    selectedOption,
  }: {
    options: Array<{ label: string; action: () => void }>;
    selectedOption: number;
  }) => {
    return (
      <Box flexDirection="column">
        {options.map((option, index) => {
          const isSelected = index === selectedOption;
          const color = isSelected ? colors.approval.header : undefined;
          return (
            <Box key={option.label} flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text color={color}>{isSelected ? ">" : " "}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text color={color}>
                  {index + 1}. {option.label}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    );
  },
);

OptionsRenderer.displayName = "OptionsRenderer";

// Dynamic preview component - defined outside to avoid recreation on every render
const DynamicPreview: React.FC<DynamicPreviewProps> = ({
  toolName,
  toolArgs,
  parsedArgs,
  precomputedDiff,
  allDiffs,
  toolCallId,
}) => {
  const t = toolName.toLowerCase();

  if (
    t === "bash" ||
    t === "shell_command" ||
    t === "shellcommand" ||
    t === "run_shell_command" ||
    t === "runshellcommand"
  ) {
    const cmdVal = parsedArgs?.command;
    const cmd =
      typeof cmdVal === "string" ? cmdVal : toolArgs || "(no arguments)";
    const descVal = parsedArgs?.description;
    const desc = typeof descVal === "string" ? descVal : "";

    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>{cmd}</Text>
        {desc ? <Text dimColor>{desc}</Text> : null}
      </Box>
    );
  }

  if (t === "shell") {
    const cmdVal = parsedArgs?.command;
    const cmd = Array.isArray(cmdVal)
      ? cmdVal.join(" ")
      : typeof cmdVal === "string"
        ? cmdVal
        : "(no command)";
    const justificationVal = parsedArgs?.justification;
    const justification =
      typeof justificationVal === "string" ? justificationVal : "";

    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>{cmd}</Text>
        {justification ? <Text dimColor>{justification}</Text> : null}
      </Box>
    );
  }

  if (
    t === "ls" ||
    t === "list_dir" ||
    t === "listdir" ||
    t === "list_directory" ||
    t === "listdirectory"
  ) {
    const pathVal =
      parsedArgs?.path || parsedArgs?.target_directory || parsedArgs?.dir_path;
    const path = typeof pathVal === "string" ? pathVal : "(current directory)";
    const ignoreVal = parsedArgs?.ignore || parsedArgs?.ignore_globs;
    const ignore =
      Array.isArray(ignoreVal) && ignoreVal.length > 0
        ? ` (ignoring: ${ignoreVal.join(", ")})`
        : "";

    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>List files in: {path}</Text>
        {ignore ? <Text dimColor>{ignore}</Text> : null}
      </Box>
    );
  }

  if (t === "read" || t === "read_file" || t === "readfile") {
    const pathVal = parsedArgs?.file_path || parsedArgs?.target_file;
    const path = typeof pathVal === "string" ? pathVal : "(no file specified)";
    const offsetVal = parsedArgs?.offset;
    const limitVal = parsedArgs?.limit;
    const rangeInfo =
      typeof offsetVal === "number" || typeof limitVal === "number"
        ? ` (lines ${offsetVal ?? 1}–${typeof offsetVal === "number" && typeof limitVal === "number" ? offsetVal + limitVal : "end"})`
        : "";

    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          Read file: {path}
          {rangeInfo}
        </Text>
      </Box>
    );
  }

  if (
    t === "grep" ||
    t === "grep_files" ||
    t === "grepfiles" ||
    t === "search_file_content" ||
    t === "searchfilecontent"
  ) {
    const patternVal = parsedArgs?.pattern;
    const pattern =
      typeof patternVal === "string" ? patternVal : "(no pattern)";
    const pathVal = parsedArgs?.path;
    const path = typeof pathVal === "string" ? ` in ${pathVal}` : "";
    const includeVal = parsedArgs?.include || parsedArgs?.glob;
    const includeInfo =
      typeof includeVal === "string" ? ` (${includeVal})` : "";

    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          Search for: {pattern}
          {path}
          {includeInfo}
        </Text>
      </Box>
    );
  }

  if (t === "apply_patch" || t === "applypatch") {
    const inputVal = parsedArgs?.input;
    if (typeof inputVal === "string") {
      const operations = parsePatchOperations(inputVal);
      if (operations.length > 0) {
        const { relative } = require("node:path");
        const cwd = process.cwd();
        return (
          <Box flexDirection="column" paddingLeft={2}>
            {operations.map((op, idx) => {
              const relPath = relative(cwd, op.path);
              const displayPath = relPath.startsWith("..") ? op.path : relPath;
              // Look up precomputed diff from allDiffs using toolCallId:path key
              const diffKey = toolCallId
                ? `${toolCallId}:${op.path}`
                : undefined;
              const opDiff = diffKey ? allDiffs.get(diffKey) : undefined;
              if (op.kind === "add") {
                return (
                  <Box key={`patch-add-${op.path}`} flexDirection="column">
                    {idx > 0 && <Box height={1} />}
                    <Text dimColor>{displayPath}</Text>
                    <AdvancedDiffRenderer
                      precomputed={opDiff}
                      kind="write"
                      filePath={op.path}
                      content={op.content}
                      showHeader={false}
                    />
                  </Box>
                );
              }
              if (op.kind === "update") {
                return (
                  <Box key={`patch-update-${op.path}`} flexDirection="column">
                    {idx > 0 && <Box height={1} />}
                    <Text dimColor>{displayPath}</Text>
                    <AdvancedDiffRenderer
                      precomputed={opDiff}
                      kind="edit"
                      filePath={op.path}
                      oldString={op.oldString}
                      newString={op.newString}
                      showHeader={false}
                    />
                  </Box>
                );
              }
              if (op.kind === "delete") {
                return (
                  <Box key={`patch-delete-${op.path}`} flexDirection="column">
                    {idx > 0 && <Box height={1} />}
                    <Text dimColor>{displayPath}</Text>
                    <Text color="red">File will be deleted</Text>
                  </Box>
                );
              }
              return null;
            })}
          </Box>
        );
      }
    }

    // Fallback for unparseable patches
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>
          {typeof inputVal === "string" && inputVal.length > 100
            ? `${inputVal.slice(0, 100)}...`
            : typeof inputVal === "string"
              ? inputVal
              : "(no patch content)"}
        </Text>
      </Box>
    );
  }

  if (t === "update_plan" || t === "updateplan") {
    const planVal = parsedArgs?.plan;
    const explanationVal = parsedArgs?.explanation;

    if (Array.isArray(planVal)) {
      const explanation =
        typeof explanationVal === "string" ? explanationVal : undefined;

      return (
        <Box flexDirection="column" paddingLeft={2}>
          {explanation && (
            <Text italic dimColor>
              {explanation}
            </Text>
          )}
          {planVal
            .map((item: unknown, idx: number) => {
              if (typeof item === "object" && item !== null) {
                const stepItem = item as { step?: string; status?: string };
                const step = stepItem.step || "(no description)";
                const status = stepItem.status || "pending";
                const checkbox = status === "completed" ? "☒" : "☐";
                return (
                  <Text key={`${idx}-${step.slice(0, 20)}`}>
                    {checkbox} {step}
                  </Text>
                );
              }
              return null;
            })
            .filter((el): el is React.ReactElement => el !== null)}
        </Box>
      );
    }
  }

  if (t === "glob") {
    const patternVal = parsedArgs?.pattern;
    const pattern =
      typeof patternVal === "string" ? patternVal : "(no pattern)";
    const dirPathVal = parsedArgs?.dir_path;
    const dirInfo = typeof dirPathVal === "string" ? ` in ${dirPathVal}` : "";

    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          Find files matching: {pattern}
          {dirInfo}
        </Text>
      </Box>
    );
  }

  // Task tool (subagent) - show nicely formatted preview
  if (t === "task") {
    const subagentType =
      typeof parsedArgs?.subagent_type === "string"
        ? parsedArgs.subagent_type
        : "unknown";
    const description =
      typeof parsedArgs?.description === "string"
        ? parsedArgs.description
        : "(no description)";
    const prompt =
      typeof parsedArgs?.prompt === "string"
        ? parsedArgs.prompt
        : "(no prompt)";
    const model =
      typeof parsedArgs?.model === "string" ? parsedArgs.model : undefined;

    // Truncate long prompts for preview (show first ~200 chars)
    const maxPromptLength = 200;
    const promptPreview =
      prompt.length > maxPromptLength
        ? `${prompt.slice(0, maxPromptLength)}...`
        : prompt;

    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="row">
          <Text bold>{subagentType}</Text>
          <Text dimColor> · </Text>
          <Text>{description}</Text>
        </Box>
        {model && <Text dimColor>Model: {model}</Text>}
        <Box marginTop={1}>
          <Text dimColor>{promptPreview}</Text>
        </Box>
      </Box>
    );
  }

  // File edit previews: write/edit/multi_edit/replace/write_file/write_file_gemini
  if (
    (t === "write" ||
      t === "edit" ||
      t === "multiedit" ||
      t === "replace" ||
      t === "write_file" ||
      t === "writefile" ||
      t === "write_file_gemini" ||
      t === "writefilegemini") &&
    parsedArgs
  ) {
    try {
      const filePath = String(parsedArgs.file_path || "");
      if (!filePath) throw new Error("no file_path");

      if (precomputedDiff) {
        return (
          <Box flexDirection="column" paddingLeft={2}>
            {t === "write" ||
            t === "write_file" ||
            t === "writefile" ||
            t === "write_file_gemini" ||
            t === "writefilegemini" ? (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="write"
                filePath={filePath}
                content={String(parsedArgs.content ?? "")}
                showHeader={false}
              />
            ) : t === "edit" || t === "replace" ? (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="edit"
                filePath={filePath}
                oldString={String(parsedArgs.old_string ?? "")}
                newString={String(parsedArgs.new_string ?? "")}
                replaceAll={Boolean(parsedArgs.replace_all)}
                showHeader={false}
              />
            ) : (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="multi_edit"
                filePath={filePath}
                edits={
                  (parsedArgs.edits as Array<{
                    old_string: string;
                    new_string: string;
                    replace_all?: boolean;
                  }>) || []
                }
                showHeader={false}
              />
            )}
          </Box>
        );
      }

      // Fallback to non-precomputed rendering
      if (
        t === "write" ||
        t === "write_file" ||
        t === "writefile" ||
        t === "write_file_gemini" ||
        t === "writefilegemini"
      ) {
        return (
          <Box flexDirection="column" paddingLeft={2}>
            <AdvancedDiffRenderer
              kind="write"
              filePath={filePath}
              content={String(parsedArgs.content ?? "")}
              showHeader={false}
            />
          </Box>
        );
      }
      if (t === "edit" || t === "replace") {
        return (
          <Box flexDirection="column" paddingLeft={2}>
            <AdvancedDiffRenderer
              kind="edit"
              filePath={filePath}
              oldString={String(parsedArgs.old_string ?? "")}
              newString={String(parsedArgs.new_string ?? "")}
              replaceAll={Boolean(parsedArgs.replace_all)}
              showHeader={false}
            />
          </Box>
        );
      }
      if (t === "multiedit") {
        const edits =
          (parsedArgs.edits as Array<{
            old_string: string;
            new_string: string;
            replace_all?: boolean;
          }>) || [];
        return (
          <Box flexDirection="column" paddingLeft={2}>
            <AdvancedDiffRenderer
              kind="multi_edit"
              filePath={filePath}
              edits={edits}
              showHeader={false}
            />
          </Box>
        );
      }
    } catch {
      // Fall through to default
    }
  }

  // Default for file-edit tools when args not parseable yet
  if (
    t === "write" ||
    t === "edit" ||
    t === "multiedit" ||
    t === "replace" ||
    t === "write_file" ||
    t === "write_file_gemini" ||
    t === "writefilegemini"
  ) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor>Preparing preview…</Text>
      </Box>
    );
  }

  // For non-edit tools, pretty-print JSON if available
  let pretty: string;
  if (parsedArgs && typeof parsedArgs === "object") {
    const clone = { ...parsedArgs };
    // Remove noisy fields
    if ("request_heartbeat" in clone) delete clone.request_heartbeat;
    pretty = JSON.stringify(clone, null, 2);
  } else {
    pretty = toolArgs || "(no arguments)";
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{pretty}</Text>
    </Box>
  );
};

export const ApprovalDialog = memo(function ApprovalDialog({
  approvals,
  approvalContexts,
  progress,
  totalTools,
  isExecuting,
  onApproveAll,
  onApproveAlways,
  onDenyAll,
  onCancel,
}: Props) {
  const [selectedOption, setSelectedOption] = useState(0);
  const [isEnteringReason, setIsEnteringReason] = useState(false);
  const [denyReason, setDenyReason] = useState("");

  // Use first approval/context for now (backward compat)
  // TODO: Support individual approval decisions for multiple approvals
  // Note: Parent ensures approvals.length > 0 before rendering this component
  const approvalRequest = approvals[0];
  const approvalContext = approvalContexts[0] || null;

  // Reset state when approval changes (e.g., moving from tool 2 to tool 3)
  // biome-ignore lint/correctness/useExhaustiveDependencies: need to trigger on progress change
  useEffect(() => {
    setSelectedOption(0);
    setIsEnteringReason(false);
    setDenyReason("");
  }, [progress?.current]);

  useInput((_input, key) => {
    if (isExecuting) return;

    // Handle CTRL-C to cancel all approvals
    if (key.ctrl && _input === "c") {
      if (onCancel) {
        onCancel();
      }
      return;
    }

    if (isEnteringReason) {
      // When entering reason, only handle enter/escape
      if (key.return) {
        // Resolve placeholders before sending denial reason
        const resolvedReason = resolvePlaceholders(denyReason);
        onDenyAll(resolvedReason);
      } else if (key.escape) {
        setIsEnteringReason(false);
        setDenyReason("");
      }
      return;
    }

    if (key.escape) {
      // Shortcut: ESC immediately opens the deny reason prompt
      setSelectedOption(options.length - 1);
      setIsEnteringReason(true);
      return;
    }

    // Navigate with arrow keys
    if (key.upArrow) {
      setSelectedOption((prev) => (prev > 0 ? prev - 1 : options.length - 1));
    } else if (key.downArrow) {
      setSelectedOption((prev) => (prev < options.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      // Handle selection
      const selected = options[selectedOption];
      if (selected) {
        // Check if this is the deny option (last option)
        if (selectedOption === options.length - 1) {
          setIsEnteringReason(true);
        } else {
          selected.action();
        }
      }
    }

    // Number key shortcuts
    const num = parseInt(_input, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= options.length) {
      const selected = options[num - 1];
      if (selected) {
        // Check if this is the deny option (last option)
        if (num === options.length) {
          setIsEnteringReason(true);
        } else {
          selected.action();
        }
      }
    }
  });

  // Parse JSON args
  let parsedArgs: Record<string, unknown> | null = null;
  try {
    parsedArgs = approvalRequest?.toolArgs
      ? JSON.parse(approvalRequest.toolArgs)
      : null;
  } catch {
    // Keep as-is if not valid JSON
  }

  // Compute diff for file-editing tools
  const precomputedDiff = useMemo((): AdvancedDiffSuccess | null => {
    if (!parsedArgs || !approvalRequest) return null;

    const toolName = approvalRequest.toolName.toLowerCase();
    if (
      toolName === "write" ||
      toolName === "write_file" ||
      toolName === "writefile" ||
      toolName === "write_file_gemini" ||
      toolName === "writefilegemini"
    ) {
      const result = computeAdvancedDiff({
        kind: "write",
        filePath: parsedArgs.file_path as string,
        content: (parsedArgs.content as string) || "",
      });
      return result.mode === "advanced" ? result : null;
    } else if (toolName === "edit") {
      const result = computeAdvancedDiff({
        kind: "edit",
        filePath: parsedArgs.file_path as string,
        oldString: (parsedArgs.old_string as string) || "",
        newString: (parsedArgs.new_string as string) || "",
        replaceAll: parsedArgs.replace_all as boolean | undefined,
      });
      return result.mode === "advanced" ? result : null;
    } else if (toolName === "multiedit") {
      const result = computeAdvancedDiff({
        kind: "multi_edit",
        filePath: parsedArgs.file_path as string,
        edits:
          (parsedArgs.edits as Array<{
            old_string: string;
            new_string: string;
            replace_all?: boolean;
          }>) || [],
      });
      return result.mode === "advanced" ? result : null;
    }

    return null;
  }, [approvalRequest, parsedArgs]);

  // Build map of all diffs (for Edit/Write AND Patch operations)
  const allDiffs = useMemo((): Map<string, AdvancedDiffSuccess> => {
    const diffs = new Map<string, AdvancedDiffSuccess>();
    const toolCallId = approvalRequest?.toolCallId;
    if (!toolCallId) return diffs;

    // For Edit/Write/MultiEdit - single file diff
    if (precomputedDiff) {
      diffs.set(toolCallId, precomputedDiff);
      return diffs;
    }

    // For Patch tools - parse hunks directly (patches ARE diffs, no need to recompute)
    const t = approvalRequest.toolName.toLowerCase();
    if ((t === "apply_patch" || t === "applypatch") && parsedArgs?.input) {
      const operations = parsePatchOperations(parsedArgs.input as string);
      for (const op of operations) {
        const key = `${toolCallId}:${op.path}`;

        if (op.kind === "add" || op.kind === "update") {
          // Parse patch hunks directly instead of trying to find oldString in file
          const result = parsePatchToAdvancedDiff(op.patchLines, op.path);
          if (result) {
            diffs.set(key, result);
          }
        }
        // Delete operations don't need diffs
      }
    }

    return diffs;
  }, [approvalRequest, parsedArgs, precomputedDiff]);

  // Build options based on approval context
  const options = useMemo(() => {
    const approvalLabel =
      progress && progress.total > 1
        ? "Yes, approve this tool"
        : "Yes, just this once";
    const opts = [
      {
        label: approvalLabel,
        action: () => onApproveAll(allDiffs.size > 0 ? allDiffs : undefined),
      },
    ];

    // Add context-aware approval option if available (only for single approvals)
    if (approvalContext?.allowPersistence) {
      opts.push({
        label: approvalContext.approveAlwaysText,
        action: () =>
          onApproveAlways(
            approvalContext.defaultScope === "user"
              ? "session"
              : approvalContext.defaultScope,
            allDiffs.size > 0 ? allDiffs : undefined,
          ),
      });
    }

    // Add deny option
    const denyLabel =
      progress && progress.total > 1
        ? "No, deny this tool (esc)"
        : "No, and tell Letta Code what to do differently (esc)";
    opts.push({
      label: denyLabel,
      action: () => {}, // Handled separately via setIsEnteringReason
    });

    return opts;
  }, [progress, approvalContext, onApproveAll, onApproveAlways, allDiffs]);

  // Get the human-readable header label
  const headerLabel = useMemo(() => {
    if (!approvalRequest) return "";
    const t = approvalRequest.toolName.toLowerCase();
    // For patch tools, determine header from operation type
    if (t === "apply_patch" || t === "applypatch") {
      if (parsedArgs?.input && typeof parsedArgs.input === "string") {
        const operations = parsePatchOperations(parsedArgs.input);
        if (operations.length > 0) {
          const isMulti = operations.length > 1;
          const firstOp = operations[0];
          if (firstOp?.kind === "add")
            return isMulti ? "Write Files" : "Write File";
          if (firstOp?.kind === "update")
            return isMulti ? "Edit Files" : "Edit File";
          if (firstOp?.kind === "delete")
            return isMulti ? "Delete Files" : "Delete File";
        }
      }
      return "Apply Patch"; // Fallback
    }
    // For write tools, check if file exists to show "Overwrite File" vs "Write File"
    if (
      t === "write" ||
      t === "write_file" ||
      t === "writefile" ||
      t === "write_file_gemini" ||
      t === "writefilegemini"
    ) {
      const filePath = parsedArgs?.file_path as string | undefined;
      if (filePath) {
        try {
          const { existsSync } = require("node:fs");
          if (existsSync(filePath)) {
            return "Overwrite File";
          }
        } catch {
          // Ignore errors, fall through to default
        }
      }
      return "Write File";
    }
    return getHeaderLabel(approvalRequest.toolName);
  }, [approvalRequest, parsedArgs]);

  // Compute the question text (customized for write tools to show filepath)
  const questionText = useMemo((): { text: string; boldPath?: string } => {
    if (!approvalRequest || !parsedArgs) {
      return { text: "Do you want to proceed?" };
    }
    const t = approvalRequest.toolName.toLowerCase();
    // For write tools, show "Write to {path}?" or "Overwrite {path}?"
    if (
      t === "write" ||
      t === "write_file" ||
      t === "writefile" ||
      t === "write_file_gemini" ||
      t === "writefilegemini"
    ) {
      const filePath = parsedArgs.file_path as string | undefined;
      if (filePath) {
        const { existsSync } = require("node:fs");
        const { relative } = require("node:path");
        const cwd = process.cwd();
        const relPath = relative(cwd, filePath);
        const displayPath = relPath.startsWith("..") ? filePath : relPath;
        try {
          if (existsSync(filePath)) {
            return { text: "Overwrite", boldPath: `${displayPath}?` };
          }
        } catch {
          // Ignore errors
        }
        return { text: "Write to", boldPath: `${displayPath}?` };
      }
    }
    // For patch tools, show file path(s) being modified
    if ((t === "apply_patch" || t === "applypatch") && parsedArgs.input) {
      const operations = parsePatchOperations(parsedArgs.input as string);
      if (operations.length > 0) {
        const { relative } = require("node:path");
        const cwd = process.cwd();
        const paths = operations.map((op) => {
          const relPath = relative(cwd, op.path);
          return relPath.startsWith("..") ? op.path : relPath;
        });
        if (paths.length === 1) {
          const op = operations[0];
          if (op?.kind === "add") {
            return { text: "Write to", boldPath: `${paths[0]}?` };
          } else if (op?.kind === "update") {
            return { text: "Update", boldPath: `${paths[0]}?` };
          } else if (op?.kind === "delete") {
            return { text: "Delete", boldPath: `${paths[0]}?` };
          }
        } else {
          return { text: "Apply patch to", boldPath: `${paths.length} files?` };
        }
      }
    }
    return { text: "Do you want to proceed?" };
  }, [approvalRequest, parsedArgs]);

  // Guard: should never happen as parent checks length, but satisfies TypeScript
  if (!approvalRequest) {
    return null;
  }

  if (isEnteringReason) {
    return (
      <Box flexDirection="column">
        <Box
          borderStyle="round"
          borderColor={colors.approval.border}
          width="100%"
          flexDirection="column"
          paddingX={1}
        >
          <Text bold>What should Letta do differently? (esc to cancel):</Text>
          <Box height={1} />
          <Box>
            <Text dimColor>{"> "}</Text>
            <PasteAwareTextInput value={denyReason} onChange={setDenyReason} />
          </Box>
        </Box>
        <Box height={1} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={colors.approval.border}
        width="100%"
        flexDirection="column"
        paddingX={1}
      >
        {/* Human-readable header (same color as border) */}
        <Text bold color={colors.approval.header}>
          {progress && progress.total > 1
            ? `${progress.total} tools require approval${totalTools && totalTools > progress.total ? ` (${totalTools} total)` : ""}`
            : headerLabel}
        </Text>
        {progress && progress.total > 1 && (
          <Text dimColor>
            ({progress.current - 1} reviewed,{" "}
            {progress.total - (progress.current - 1)} remaining)
          </Text>
        )}
        {isExecuting && progress && progress.total > 1 && (
          <Text dimColor>Executing tool...</Text>
        )}
        <Box height={1} />

        {/* Dynamic per-tool renderer (indented) */}
        <DynamicPreview
          toolName={approvalRequest.toolName}
          toolArgs={approvalRequest.toolArgs}
          parsedArgs={parsedArgs}
          precomputedDiff={precomputedDiff}
          allDiffs={allDiffs}
          toolCallId={approvalRequest.toolCallId}
        />
        <Box height={1} />

        {/* Prompt */}
        <Text bold>
          {questionText.text}
          {questionText.boldPath ? (
            <>
              {" "}
              <Text bold>{questionText.boldPath}</Text>
            </>
          ) : null}
        </Text>
        <Box height={1} />

        {/* Options selector (single line per option) */}
        <OptionsRenderer options={options} selectedOption={selectedOption} />
      </Box>
      <Box height={1} />
    </Box>
  );
});

ApprovalDialog.displayName = "ApprovalDialog";

// Helper functions for tool name mapping
function getHeaderLabel(toolName: string): string {
  const t = toolName.toLowerCase();
  // Anthropic toolset
  if (t === "bash") return "Bash command";
  if (t === "ls") return "List Files";
  if (t === "read") return "Read File";
  if (t === "write") return "Write File";
  if (t === "edit") return "Edit File";
  if (t === "multi_edit" || t === "multiedit") return "Edit Files";
  if (t === "grep") return "Search in Files";
  if (t === "glob") return "Find Files";
  if (t === "todo_write" || t === "todowrite") return "Update Todos";
  // Codex toolset (snake_case)
  if (t === "shell_command") return "Shell command";
  if (t === "shell") return "Shell script";
  if (t === "read_file") return "Read File";
  if (t === "list_dir") return "List Files";
  if (t === "grep_files") return "Search in Files";
  if (t === "apply_patch") return "Apply Patch";
  if (t === "update_plan") return "Plan update";
  // Codex toolset (PascalCase → lowercased)
  if (t === "shellcommand") return "Shell command";
  if (t === "readfile") return "Read File";
  if (t === "listdir") return "List Files";
  if (t === "grepfiles") return "Search in Files";
  if (t === "applypatch") return "Apply Patch";
  if (t === "updateplan") return "Plan update";
  // Gemini toolset (snake_case)
  if (t === "run_shell_command") return "Shell command";
  if (t === "read_file_gemini") return "Read File";
  if (t === "list_directory") return "List Directory";
  if (t === "glob_gemini") return "Find Files";
  if (t === "search_file_content") return "Search in Files";
  if (t === "write_file_gemini") return "Write File";
  if (t === "write_todos") return "Update Todos";
  if (t === "read_many_files") return "Read Multiple Files";
  // Gemini toolset (PascalCase → lowercased)
  if (t === "runshellcommand") return "Shell command";
  if (t === "readfilegemini") return "Read File";
  if (t === "listdirectory") return "List Directory";
  if (t === "globgemini") return "Find Files";
  if (t === "searchfilecontent") return "Search in Files";
  if (t === "writefilegemini") return "Write File";
  if (t === "writetodos") return "Update Todos";
  if (t === "readmanyfiles") return "Read Multiple Files";
  // Shared/additional tools
  if (t === "replace") return "Edit File";
  if (t === "write_file" || t === "writefile") return "Write File";
  if (t === "killbash") return "Kill Shell";
  if (t === "bashoutput") return "Shell Output";
  if (t === "task") return "Task";
  return toolName;
}
