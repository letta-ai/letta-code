import { Box, Text } from "ink";
import { memo, useEffect, useState } from "react";
import { clipToolReturn } from "../../tools/manager.js";
import { formatArgsDisplay } from "../helpers/formatArgsDisplay.js";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors.js";
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

// BlinkDot component copied verbatim from old codebase
const BlinkDot: React.FC<{ color?: string }> = ({
  color = colors.tool.pending,
}) => {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), 400);
    return () => clearInterval(t);
  }, []);
  // Visible = colored dot; Off = space (keeps width/alignment)
  return <Text color={color}>{on ? "●" : " "}</Text>;
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

  // Apply tool name remapping from old codebase
  let displayName = rawName;
  // Anthropic toolset
  if (displayName === "write") displayName = "Write";
  else if (displayName === "edit" || displayName === "multi_edit")
    displayName = "Edit";
  else if (displayName === "read") displayName = "Read";
  else if (displayName === "bash") displayName = "Bash";
  else if (displayName === "grep") displayName = "Grep";
  else if (displayName === "glob") displayName = "Glob";
  else if (displayName === "ls") displayName = "LS";
  else if (displayName === "todo_write") displayName = "TODO";
  else if (displayName === "TodoWrite") displayName = "TODO";
  else if (displayName === "EnterPlanMode") displayName = "Planning";
  else if (displayName === "ExitPlanMode") displayName = "Planning";
  else if (displayName === "AskUserQuestion") displayName = "Question";
  // Codex toolset (snake_case)
  else if (displayName === "update_plan") displayName = "Plan";
  else if (displayName === "shell_command") displayName = "Shell";
  else if (displayName === "shell") displayName = "Shell";
  else if (displayName === "read_file") displayName = "Read";
  else if (displayName === "list_dir") displayName = "LS";
  else if (displayName === "grep_files") displayName = "Grep";
  else if (displayName === "apply_patch") displayName = "Patch";
  // Codex toolset (PascalCase)
  else if (displayName === "UpdatePlan") displayName = "Plan";
  else if (displayName === "ShellCommand") displayName = "Shell";
  else if (displayName === "Shell") displayName = "Shell";
  else if (displayName === "ReadFile") displayName = "Read";
  else if (displayName === "ListDir") displayName = "LS";
  else if (displayName === "GrepFiles") displayName = "Grep";
  else if (displayName === "ApplyPatch") displayName = "Patch";
  // Gemini toolset (snake_case)
  else if (displayName === "run_shell_command") displayName = "Shell";
  else if (displayName === "list_directory") displayName = "LS";
  else if (displayName === "search_file_content") displayName = "Grep";
  else if (displayName === "write_todos") displayName = "TODO";
  else if (displayName === "read_many_files") displayName = "Read Multiple";
  // Gemini toolset (PascalCase)
  else if (displayName === "RunShellCommand") displayName = "Shell";
  else if (displayName === "ListDirectory") displayName = "LS";
  else if (displayName === "SearchFileContent") displayName = "Grep";
  else if (displayName === "WriteTodos") displayName = "TODO";
  else if (displayName === "ReadManyFiles") displayName = "Read Multiple";

  // Format arguments for display using the old formatting logic
  const formatted = formatArgsDisplay(argsText);
  const args = `(${formatted.display})`;

  const rightWidth = Math.max(0, columns - 2); // gutter is 2 cols

  // If name exceeds available width, fall back to simple wrapped rendering
  const fallback = displayName.length >= rightWidth;

  // Determine dot state based on phase
  const getDotElement = () => {
    switch (line.phase) {
      case "streaming":
        return <Text color={colors.tool.streaming}>●</Text>;
      case "ready":
        return <BlinkDot color={colors.tool.pending} />;
      case "running":
        return <BlinkDot color={colors.tool.running} />;
      case "finished":
        if (line.resultOk === false) {
          return <Text color={colors.tool.error}>●</Text>;
        }
        return <Text color={colors.tool.completed}>●</Text>;
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
    const isTodoTool =
      rawName === "todo_write" ||
      rawName === "TodoWrite" ||
      displayName === "TODO";

    if (isTodoTool && line.resultOk !== false && line.argsText) {
      try {
        const parsedArgs = JSON.parse(line.argsText);
        if (parsedArgs.todos && Array.isArray(parsedArgs.todos)) {
          // Convert todos to safe format for TodoRenderer
          const safeTodos = parsedArgs.todos.map((t: unknown, i: number) => {
            const rec = isRecord(t) ? t : {};
            const status: "pending" | "in_progress" | "completed" =
              rec.status === "completed"
                ? "completed"
                : rec.status === "in_progress"
                  ? "in_progress"
                  : "pending";
            const id = typeof rec.id === "string" ? rec.id : String(i);
            const content =
              typeof rec.content === "string" ? rec.content : JSON.stringify(t);
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
    const isPlanTool = rawName === "update_plan" || displayName === "Plan";

    if (isPlanTool && line.resultOk !== false && line.argsText) {
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
      const match = displayText.match(/User reason: (.+)$/);
      const reason = match ? match[1] : "(empty)";
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
            <Text wrap="wrap">{`${displayName}${args}`}</Text>
          ) : (
            <Box flexDirection="row">
              <Text>{displayName}</Text>
              {args ? (
                <Box
                  flexGrow={1}
                  width={Math.max(0, rightWidth - displayName.length)}
                >
                  <Text wrap="wrap">{args}</Text>
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
