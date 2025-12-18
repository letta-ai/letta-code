import { Box, Text } from "ink";
import { memo } from "react";
import { clipToolReturn } from "../../tools/manager.js";
import { formatArgsDisplay } from "../helpers/formatArgsDisplay.js";
import {
  getDisplayToolName,
  isPlanTool,
  isTaskTool,
  isTodoTool,
} from "../helpers/toolNameMapping.js";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { BlinkDot } from "./BlinkDot.js";
import { brandColors, colors } from "./colors.js";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { PlanRenderer } from "./PlanRenderer.js";
import { TodoRenderer } from "./TodoRenderer.js";

type ToolCallLine = {
  kind: "tool_call";
  id: string;
  toolCallId?: string;
  name?: string;
  argsText?: string;
  resultText?: string;
  resultOk?: boolean;
  phase: "streaming" | "ready" | "running" | "finished";
};

/**
 * ToolCallMessageRich - Rich formatting version with old layout logic
 * This preserves the exact wrapping and spacing logic from the old codebase
 *
 * Features:
 * - Two-column layout for tool calls (2 chars for dot)
 * - Smart wrapping that keeps function name and args together when possible
 * - Blinking dots for pending/running states
 * - Result shown with ⎿ prefix underneath
 */
export const ToolCallMessage = memo(({ line }: { line: ToolCallLine }) => {
  const columns = useTerminalWidth();

  // Parse and format the tool call
  const rawName = line.name ?? "?";
  const argsText = line.argsText ?? "...";

  // Task tool - handled by SubagentGroupDisplay, don't render here
  if (isTaskTool(rawName)) {
    return null;
  }

  // Apply tool name remapping
  const displayName = getDisplayToolName(rawName);

  // Format arguments for display using the old formatting logic
  const formatted = formatArgsDisplay(argsText);
  const args = `(${formatted.display})`;

  const rightWidth = Math.max(0, columns - 2); // gutter is 2 cols

  // If name exceeds available width, fall back to simple wrapped rendering
  const fallback = displayName.length >= rightWidth;

  // Special handling for memory tool - use orange
  const isMemoryTool = rawName === "memory";

  // Determine dot state based on phase
  const getDotElement = () => {
    switch (line.phase) {
      case "streaming":
        return <Text color={isMemoryTool ? brandColors.orange : colors.tool.streaming}>●</Text>;
      case "ready":
        return <BlinkDot color={isMemoryTool ? brandColors.orange : colors.tool.pending} />;
      case "running":
        return <BlinkDot color={isMemoryTool ? brandColors.orange : colors.tool.running} />;
      case "finished":
        if (line.resultOk === false) {
          return <Text color={colors.tool.error}>●</Text>;
        }
        return <Text color={isMemoryTool ? brandColors.orange : colors.tool.completed}>●</Text>;
      default:
        return <Text>●</Text>;
    }
  };

  // Format result for display
  const getResultElement = () => {
    if (!line.resultText) return null;

    const prefix = `  ⎿  `; // Match old format: 2 spaces, glyph, 2 spaces
    const prefixWidth = 5; // Total width of prefix
    const contentWidth = Math.max(0, columns - prefixWidth);

    // Special cases from old ToolReturnBlock (check before truncation)
    if (line.resultText === "Running...") {
      return (
        <Box flexDirection="row">
          <Box width={prefixWidth} flexShrink={0}>
            <Text>{prefix}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <Text dimColor>Running...</Text>
          </Box>
        </Box>
      );
    }

    if (line.resultText === "Interrupted by user") {
      return (
        <Box flexDirection="row">
          <Box width={prefixWidth} flexShrink={0}>
            <Text>{prefix}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <Text color={colors.status.interrupt}>Interrupted by user</Text>
          </Box>
        </Box>
      );
    }

    // Truncate the result text for display (UI only, API gets full response)
    // Strip trailing newlines to avoid extra visual spacing (e.g., from bash echo)
    const displayResultText = clipToolReturn(line.resultText).replace(
      /\n+$/,
      "",
    );

    // Helper to check if a value is a record
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null;

    // Check if this is a todo_write tool with successful result
    if (
      isTodoTool(rawName, displayName) &&
      line.resultOk !== false &&
      line.argsText
    ) {
      try {
        const parsedArgs = JSON.parse(line.argsText);
        if (parsedArgs.todos && Array.isArray(parsedArgs.todos)) {
          // Convert todos to safe format for TodoRenderer
          // Note: Anthropic/Codex use "content", Gemini uses "description"
          const safeTodos = parsedArgs.todos.map((t: unknown, i: number) => {
            const rec = isRecord(t) ? t : {};
            const status: "pending" | "in_progress" | "completed" =
              rec.status === "completed"
                ? "completed"
                : rec.status === "in_progress"
                  ? "in_progress"
                  : "pending";
            const id = typeof rec.id === "string" ? rec.id : String(i);
            // Handle both "content" (Anthropic/Codex) and "description" (Gemini) fields
            const content =
              typeof rec.content === "string"
                ? rec.content
                : typeof rec.description === "string"
                  ? rec.description
                  : JSON.stringify(t);
            const priority: "high" | "medium" | "low" | undefined =
              rec.priority === "high"
                ? "high"
                : rec.priority === "medium"
                  ? "medium"
                  : rec.priority === "low"
                    ? "low"
                    : undefined;
            return { content, status, id, priority };
          });

          // Return TodoRenderer directly - it has its own prefix
          return <TodoRenderer todos={safeTodos} />;
        }
      } catch {
        // If parsing fails, fall through to regular handling
      }
    }

    // Check if this is an update_plan tool with successful result
    if (
      isPlanTool(rawName, displayName) &&
      line.resultOk !== false &&
      line.argsText
    ) {
      try {
        const parsedArgs = JSON.parse(line.argsText);
        if (parsedArgs.plan && Array.isArray(parsedArgs.plan)) {
          // Convert plan items to safe format for PlanRenderer
          const safePlan = parsedArgs.plan.map((item: unknown) => {
            const rec = isRecord(item) ? item : {};
            const status: "pending" | "in_progress" | "completed" =
              rec.status === "completed"
                ? "completed"
                : rec.status === "in_progress"
                  ? "in_progress"
                  : "pending";
            const step =
              typeof rec.step === "string" ? rec.step : JSON.stringify(item);
            return { step, status };
          });

          const explanation =
            typeof parsedArgs.explanation === "string"
              ? parsedArgs.explanation
              : undefined;

          // Return PlanRenderer directly - it has its own prefix
          return <PlanRenderer plan={safePlan} explanation={explanation} />;
        }
      } catch {
        // If parsing fails, fall through to regular handling
      }
    }

    // Regular result handling
    const isError = line.resultOk === false;

    // Try to parse JSON for cleaner error display
    let displayText = displayResultText;
    try {
      const parsed = JSON.parse(displayResultText);
      if (parsed.error && typeof parsed.error === "string") {
        displayText = parsed.error;
      }
    } catch {
      // Not JSON, use raw text
    }

    // Format tool denial errors more user-friendly
    if (isError && displayText.includes("request to call tool denied")) {
      // Use [\s\S]+ to match multiline reasons
      const match = displayText.match(/User reason: ([\s\S]+)$/);
      const reason = match?.[1]?.trim() || "(empty)";
      displayText = `User rejected the tool call with reason: ${reason}`;
    }

    return (
      <Box flexDirection="row">
        <Box width={prefixWidth} flexShrink={0}>
          <Text>{prefix}</Text>
        </Box>
        <Box flexGrow={1} width={contentWidth}>
          {isError ? (
            <Text color={colors.status.error}>{displayText}</Text>
          ) : (
            <MarkdownDisplay text={displayText} />
          )}
        </Box>
      </Box>
    );
  };

  // Apply orange text color for memory tool
  const textColor = isMemoryTool ? brandColors.orange : undefined;

  return (
    <Box flexDirection="column">
      {/* Tool call with exact wrapping logic from old codebase */}
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          {getDotElement()}
          <Text></Text>
        </Box>
        <Box flexGrow={1} width={rightWidth}>
          {fallback ? (
            <Text wrap="wrap" color={textColor}>{`${displayName}${args}`}</Text>
          ) : (
            <Box flexDirection="row">
              <Text color={textColor}>{displayName}</Text>
              {args ? (
                <Box
                  flexGrow={1}
                  width={Math.max(0, rightWidth - displayName.length)}
                >
                  <Text wrap="wrap" color={textColor}>{args}</Text>
                </Box>
              ) : null}
            </Box>
          )}
        </Box>
      </Box>

      {/* Tool result (if present) */}
      {getResultElement()}
    </Box>
  );
});

ToolCallMessage.displayName = "ToolCallMessage";
