// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { memo, useMemo, useState } from "react";
import type { ApprovalContext } from "../../permissions/analyzer";
import { type AdvancedDiffSuccess, computeAdvancedDiff } from "../helpers/diff";
import { resolvePlaceholders } from "../helpers/pasteRegistry";
import type { ApprovalRequest } from "../helpers/stream";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

type Props = {
  approvalRequest: ApprovalRequest;
  approvalContext: ApprovalContext | null;
  onApprove: () => void;
  onApproveAlways: (scope?: "project" | "session") => void;
  onDeny: (reason: string) => void;
};

type DynamicPreviewProps = {
  toolName: string;
  toolArgs: string;
  parsedArgs: Record<string, unknown> | null;
  precomputedDiff: AdvancedDiffSuccess | null;
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
}) => {
  const t = toolName.toLowerCase();

  if (t === "bash") {
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

  // File edit previews: write/edit/multi_edit
  if ((t === "write" || t === "edit" || t === "multiedit") && parsedArgs) {
    try {
      const filePath = String(parsedArgs.file_path || "");
      if (!filePath) throw new Error("no file_path");

      if (precomputedDiff) {
        return (
          <Box flexDirection="column" paddingLeft={2}>
            {t === "write" ? (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="write"
                filePath={filePath}
                content={String(parsedArgs.content ?? "")}
                showHeader={false}
              />
            ) : t === "edit" ? (
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
      if (t === "write") {
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
      if (t === "edit") {
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
  if (t === "write" || t === "edit" || t === "multiedit") {
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
  approvalRequest,
  approvalContext,
  onApprove,
  onApproveAlways,
  onDeny,
}: Props) {
  const [selectedOption, setSelectedOption] = useState(0);
  const [isEnteringReason, setIsEnteringReason] = useState(false);
  const [denyReason, setDenyReason] = useState("");

  // Build options based on approval context
  const options = useMemo(() => {
    const opts = [{ label: "Yes, just this once", action: onApprove }];

    // Add context-aware approval option if available
    // Claude Code style: max 3 options total (Yes once, Yes always, No)
    // If context is missing, we just don't show "approve always" (2 options only)
    if (approvalContext?.allowPersistence) {
      opts.push({
        label: approvalContext.approveAlwaysText,
        action: () =>
          onApproveAlways(
            approvalContext.defaultScope === "user"
              ? "session"
              : approvalContext.defaultScope,
          ),
      });
    }

    // Add deny option
    opts.push({
      label: "No, and tell Letta what to do differently (esc)",
      action: () => {}, // Handled separately via setIsEnteringReason
    });

    return opts;
  }, [approvalContext, onApprove, onApproveAlways]);

  useInput((_input, key) => {
    if (isEnteringReason) {
      // When entering reason, only handle enter/escape
      if (key.return) {
        // Resolve placeholders before sending denial reason
        const resolvedReason = resolvePlaceholders(denyReason);
        onDeny(resolvedReason);
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
    parsedArgs = JSON.parse(approvalRequest.toolArgs);
  } catch {
    // Keep as-is if not valid JSON
  }

  // Compute diff for file-editing tools
  const precomputedDiff = useMemo((): AdvancedDiffSuccess | null => {
    if (!parsedArgs) return null;

    const toolName = approvalRequest.toolName.toLowerCase();
    if (toolName === "write") {
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

  // Get the human-readable header label
  const headerLabel = getHeaderLabel(approvalRequest.toolName);

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
          <Text bold>Enter reason for denial (ESC to cancel):</Text>
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
          {headerLabel}
        </Text>
        <Box height={1} />

        {/* Dynamic per-tool renderer (indented) */}
        <DynamicPreview
          toolName={approvalRequest.toolName}
          toolArgs={approvalRequest.toolArgs}
          parsedArgs={parsedArgs}
          precomputedDiff={precomputedDiff}
        />
        <Box height={1} />

        {/* Prompt */}
        <Text bold>Do you want to proceed?</Text>
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
  if (t === "bash") return "Bash command";
  if (t === "ls") return "List Files";
  if (t === "read") return "Read File";
  if (t === "write") return "Write File";
  if (t === "edit") return "Edit File";
  if (t === "multi_edit" || t === "multiedit") return "Edit Files";
  if (t === "grep") return "Search in Files";
  if (t === "glob") return "Find Files";
  if (t === "todo_write" || t === "todowrite") return "Update Todos";
  return toolName;
}
