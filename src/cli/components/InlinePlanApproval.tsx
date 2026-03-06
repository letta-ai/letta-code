import { Box, useInput } from "ink";
import { memo, useMemo, useState } from "react";
import { permissionMode } from "../../permissions/mode";
import {
  getPlanExitChoices,
  type PlanExitChoice,
} from "../helpers/planExitApproval";
import { useProgressIndicator } from "../hooks/useProgressIndicator";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { useTextInputCursor } from "../hooks/useTextInputCursor";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";
import { Text } from "./Text";

type Props = {
  plan: string;
  onApproveRestore: () => void;
  onApproveManual: () => void;
  onApproveAndAcceptEdits: () => void;
  onKeepPlanning: (reason: string) => void;
  isFocused?: boolean;
};

// Horizontal line characters for Claude Code style
const SOLID_LINE = "─";
const DOTTED_LINE = "╌";

/**
 * InlinePlanApproval - Renders plan approval UI inline (Claude Code style)
 *
 * Uses horizontal lines instead of boxes for visual styling:
 * - ──── solid line at top
 * - ╌╌╌╌ dotted line around plan content
 * - Approval options below
 */
export const InlinePlanApproval = memo(
  ({
    plan,
    onApproveRestore,
    onApproveManual,
    onApproveAndAcceptEdits,
    onKeepPlanning,
    isFocused = true,
  }: Props) => {
    const [selectedOption, setSelectedOption] = useState(0);
    const {
      text: customReason,
      cursorPos,
      handleKey,
      clear,
    } = useTextInputCursor();
    const columns = useTerminalWidth();
    useProgressIndicator();

    const modeBeforePlan = permissionMode.getModeBeforePlan() ?? "default";
    const options: PlanExitChoice[] = getPlanExitChoices(modeBeforePlan);
    const customOptionIndex = options.findIndex((o) => o.decision === "custom");
    const maxOptionIndex = Math.max(0, options.length - 1);
    const isOnCustomOption = selectedOption === customOptionIndex;
    const customOptionPlaceholder =
      "Type here to tell Letta Code what to change";

    useInput(
      (input, key) => {
        if (!isFocused) return;

        // CTRL-C: keep planning with cancel message
        if (key.ctrl && input === "c") {
          onKeepPlanning("User pressed CTRL-C to cancel");
          return;
        }

        // Arrow navigation always works
        if (key.upArrow) {
          setSelectedOption((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedOption((prev) => Math.min(maxOptionIndex, prev + 1));
          return;
        }

        // When on custom input option
        if (isOnCustomOption) {
          if (key.return) {
            if (customReason.trim()) {
              onKeepPlanning(customReason.trim());
            }
            return;
          }
          if (key.escape) {
            if (customReason) {
              clear();
            } else {
              onKeepPlanning("User cancelled");
            }
            return;
          }
          // Handle text input (arrows, backspace, typing)
          if (handleKey(input, key)) return;
        }

        // When on regular options
        if (key.return) {
          const choice = options[selectedOption];
          if (!choice) return;
          if (choice.decision === "restore") onApproveRestore();
          if (choice.decision === "manual") onApproveManual();
          if (choice.decision === "autoAccept") onApproveAndAcceptEdits();
          return;
        }
        if (key.escape) {
          onKeepPlanning("User cancelled");
          return;
        }

        if (/^[1-9]$/.test(input)) {
          const idx = Number(input) - 1;
          const choice = options[idx];
          if (!choice) return;
          if (choice.decision === "custom") {
            setSelectedOption(idx);
            return;
          }
          if (choice.decision === "restore") onApproveRestore();
          if (choice.decision === "manual") onApproveManual();
          if (choice.decision === "autoAccept") onApproveAndAcceptEdits();
        }
      },
      { isActive: isFocused },
    );

    // Generate horizontal lines
    const solidLine = SOLID_LINE.repeat(Math.max(columns, 10));
    const dottedLine = DOTTED_LINE.repeat(Math.max(columns, 10));

    // Memoize the static plan content so it doesn't re-render on keystroke
    // This prevents flicker when typing feedback in the custom input field
    const memoizedPlanContent = useMemo(
      () => (
        <>
          {/* Top solid line */}
          <Text dimColor>{solidLine}</Text>

          {/* Header */}
          <Text bold color={colors.approval.header}>
            Ready to code? Here is your plan:
          </Text>

          {/* Dotted separator before plan content */}
          <Text dimColor>{dottedLine}</Text>

          {/* Plan content - no indentation, just like Claude Code */}
          {/* Box with explicit width enables proper word-level wrapping */}
          <Box width={columns}>
            <MarkdownDisplay text={plan} />
          </Box>

          {/* Dotted separator after plan content */}
          <Text dimColor>{dottedLine}</Text>
        </>
      ),
      [plan, solidLine, dottedLine, columns],
    );

    // Hint text based on state
    const hintText = isOnCustomOption
      ? customReason
        ? "Enter to submit · Esc to clear"
        : "Type feedback · Esc to cancel"
      : "Enter to select · Esc to cancel";

    return (
      <Box flexDirection="column" marginTop={1}>
        {/* Static plan content - memoized to prevent re-render on keystroke */}
        {memoizedPlanContent}

        {/* Question */}
        <Box marginTop={1}>
          <Text>Would you like to proceed?</Text>
        </Box>

        {/* Options */}
        <Box marginTop={1} flexDirection="column">
          {options.map((opt, idx) => {
            const isSelected = selectedOption === idx;
            const color = isSelected ? colors.approval.header : undefined;
            const isCustom = opt.decision === "custom";

            return (
              <Box key={`${opt.decision}-${idx}`} flexDirection="row">
                <Box width={5} flexShrink={0}>
                  <Text color={color}>
                    {isSelected ? "❯" : " "} {idx + 1}.
                  </Text>
                </Box>
                <Box flexGrow={1} width={Math.max(0, columns - 5)}>
                  {isCustom ? (
                    customReason ? (
                      <Text wrap="wrap">
                        {customReason.slice(0, cursorPos)}
                        {isSelected && "█"}
                        {customReason.slice(cursorPos)}
                      </Text>
                    ) : (
                      <Text wrap="wrap" dimColor>
                        {customOptionPlaceholder}
                        {isSelected && "█"}
                      </Text>
                    )
                  ) : (
                    <Text wrap="wrap" color={color}>
                      {opt.label}
                    </Text>
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* Hint */}
        <Box marginTop={1}>
          <Text dimColor>{hintText}</Text>
        </Box>
      </Box>
    );
  },
);

InlinePlanApproval.displayName = "InlinePlanApproval";
