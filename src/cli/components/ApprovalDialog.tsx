// Import useInput from vendored Ink for bracketed paste support
import { Box, useInput } from "ink";
import RawTextInput from "ink-text-input";
import { type ComponentType, useMemo, useState } from "react";
import { type AdvancedDiffSuccess, computeAdvancedDiff } from "../helpers/diff";
import type { ApprovalRequest } from "../helpers/stream";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { Text } from "./Text";

type Props = {
  approvalRequest: ApprovalRequest;
  onApprove: () => void;
  onApproveAlways: () => void;
  onDeny: (reason: string) => void;
};

export function ApprovalDialog({
  approvalRequest,
  onApprove,
  onApproveAlways,
  onDeny,
}: Props) {
  const [selectedOption, setSelectedOption] = useState(0);
  const [isEnteringReason, setIsEnteringReason] = useState(false);
  const [denyReason, setDenyReason] = useState("");

  const options = [
    "Approve (once)",
    "Approve and don't ask again",
    "Deny and provide feedback",
  ];

  useInput((_input, key) => {
    if (isEnteringReason) {
      // When entering reason, only handle enter/escape
      if (key.return) {
        onDeny(denyReason);
      } else if (key.escape) {
        setIsEnteringReason(false);
        setDenyReason("");
      }
      return;
    }

    // Navigate with arrow keys
    if (key.upArrow) {
      setSelectedOption((prev) => (prev > 0 ? prev - 1 : options.length - 1));
    } else if (key.downArrow) {
      setSelectedOption((prev) => (prev < options.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      // Handle selection
      if (selectedOption === 0) {
        onApprove();
      } else if (selectedOption === 1) {
        onApproveAlways();
      } else if (selectedOption === 2) {
        setIsEnteringReason(true);
      }
    }
  });

  // Pretty print JSON args
  let formattedArgs = approvalRequest.toolArgs;
  let parsedArgs: Record<string, unknown> | null = null;
  try {
    parsedArgs = JSON.parse(approvalRequest.toolArgs);
    formattedArgs = JSON.stringify(parsedArgs, null, 2);
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

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Tool Approval Required</Text>

      <Box flexDirection="column">
        <Text>
          Tool: <Text bold>{approvalRequest.toolName}</Text>
        </Text>

        {/* Show diff for file-editing tools */}
        {precomputedDiff && parsedArgs && (
          <Box paddingLeft={2} flexDirection="column">
            {approvalRequest.toolName.toLowerCase() === "write" ? (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="write"
                filePath={parsedArgs.file_path as string}
                content={(parsedArgs.content as string) || ""}
                showHeader={false}
              />
            ) : approvalRequest.toolName.toLowerCase() === "edit" ? (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="edit"
                filePath={parsedArgs.file_path as string}
                oldString={(parsedArgs.old_string as string) || ""}
                newString={(parsedArgs.new_string as string) || ""}
                replaceAll={parsedArgs.replace_all as boolean | undefined}
                showHeader={false}
              />
            ) : approvalRequest.toolName.toLowerCase() === "multiedit" ? (
              <AdvancedDiffRenderer
                precomputed={precomputedDiff}
                kind="multi_edit"
                filePath={parsedArgs.file_path as string}
                edits={
                  (parsedArgs.edits as Array<{
                    old_string: string;
                    new_string: string;
                    replace_all?: boolean;
                  }>) || []
                }
                showHeader={false}
              />
            ) : null}
          </Box>
        )}

        {/* Fallback: Show raw args if no diff */}
        {!precomputedDiff && (
          <>
            <Text dimColor>Arguments:</Text>
            <Box paddingLeft={2}>
              <Text dimColor>{formattedArgs}</Text>
            </Box>
          </>
        )}
      </Box>

      <Box flexDirection="column">
        {isEnteringReason ? (
          <Box flexDirection="column">
            <Text>Enter reason for denial (ESC to cancel):</Text>
            <Box>
              <Text dimColor>{"> "}</Text>
              {(() => {
                const TextInputAny = RawTextInput as unknown as ComponentType<{
                  value: string;
                  onChange: (s: string) => void;
                }>;
                return (
                  <TextInputAny value={denyReason} onChange={setDenyReason} />
                );
              })()}
            </Box>
          </Box>
        ) : (
          <>
            <Text dimColor>Use ↑/↓ to select, Enter to confirm:</Text>
            {options.map((option) => (
              <Text key={option}>
                {selectedOption === options.indexOf(option) ? "→ " : "  "}
                {option}
              </Text>
            ))}
          </>
        )}
      </Box>
    </Box>
  );
}
