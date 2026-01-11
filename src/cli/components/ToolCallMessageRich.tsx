// existsSync, readFileSync removed - no longer needed since plan content
// is shown via StaticPlanApproval during approval, not in tool result
import { Box, Text } from "ink";
import { memo } from "react";
import { INTERRUPTED_BY_USER } from "../../constants";
import { clipToolReturn } from "../../tools/manager.js";
import type { AdvancedDiffSuccess } from "../helpers/diff";
import {
  formatArgsDisplay,
  parsePatchInput,
  parsePatchOperations,
} from "../helpers/formatArgsDisplay.js";
import {
  getDisplayToolName,
  isFileEditTool,
  isFileReadTool,
  isFileWriteTool,
  isMemoryTool,
  isPatchTool,
  isPlanTool,
  isTaskTool,
  isTodoTool,
} from "../helpers/toolNameMapping.js";

/**
 * Check if tool is AskUserQuestion
 */
function isQuestionTool(name: string): boolean {
  return name === "AskUserQuestion";
}

import type { StreamingState } from "../helpers/accumulator";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { BlinkDot } from "./BlinkDot.js";
import { CollapsedOutputDisplay } from "./CollapsedOutputDisplay";
import { colors } from "./colors.js";
import {
  EditRenderer,
  MultiEditRenderer,
  WriteRenderer,
} from "./DiffRenderer.js";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { MemoryDiffRenderer } from "./MemoryDiffRenderer.js";
import { PlanRenderer } from "./PlanRenderer.js";
import { StreamingOutputDisplay } from "./StreamingOutputDisplay";
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
  streaming?: StreamingState;
};

/**
 * Check if tool is a shell/bash tool that supports streaming output
 */
function isShellTool(name: string): boolean {
  const shellTools = [
    "Bash",
    "Shell",
    "shell",
    "shell_command",
    "run_shell_command",
    "RunShellCommand",
    "ShellCommand",
  ];
  return shellTools.includes(name);
}

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
export const ToolCallMessage = memo(
  ({
    line,
    precomputedDiffs,
    lastPlanFilePath,
    isStreaming,
  }: {
    line: ToolCallLine;
    precomputedDiffs?: Map<string, AdvancedDiffSuccess>;
    lastPlanFilePath?: string | null;
    isStreaming?: boolean;
  }) => {
    const columns = useTerminalWidth();

    // Parse and format the tool call
    const rawName = line.name ?? "?";
    const argsText = line.argsText ?? "...";

    // Task tool rendering decision:
    // - Cancelled/rejected: render as error tool call (won't appear in SubagentGroupDisplay)
    // - Finished with success: render as normal tool call (for backfilled tools without subagent data)
    // - In progress: don't render here (SubagentGroupDisplay handles running subagents,
    //   and liveItems handles pending approvals via InlineGenericApproval)
    if (isTaskTool(rawName)) {
      const isFinished = line.phase === "finished";
      if (!isFinished) {
        // Not finished - SubagentGroupDisplay or approval UI handles this
        return null;
      }
      // Finished Task tools render here (both success and error)
    }

    // Apply tool name remapping
    let displayName = getDisplayToolName(rawName);

    // For Patch tools, override display name based on patch content
    // (Add → Write, Update → Update, Delete → Delete)
    if (isPatchTool(rawName)) {
      try {
        const parsedArgs = JSON.parse(argsText);
        if (parsedArgs.input) {
          const patchInfo = parsePatchInput(parsedArgs.input);
          if (patchInfo) {
            if (patchInfo.kind === "add") displayName = "Write";
            else if (patchInfo.kind === "update") displayName = "Update";
            else if (patchInfo.kind === "delete") displayName = "Delete";
          }
        }
      } catch {
        // Keep default "Patch" name if parsing fails
      }
    }

    // For AskUserQuestion, show friendly header only after completion
    if (isQuestionTool(rawName)) {
      if (line.phase === "finished" && line.resultOk !== false) {
        displayName = "User answered Letta Code's questions:";
      } else {
        displayName = "Asking user questions...";
      }
    }

    const rightWidth = Math.max(0, columns - 2); // gutter is 2 cols

    // Determine args display:
    // - Question tool: hide args (shown in result instead)
    // - Still streaming + phase "ready": args may be incomplete, show ellipsis
    // - Phase "running"/"finished" or stream done: args complete, show formatted
    let args = "";
    if (!isQuestionTool(rawName)) {
      // Args are complete once running, finished, or stream is done
      const argsComplete =
        line.phase === "running" || line.phase === "finished" || !isStreaming;

      if (!argsComplete) {
        args = "(…)";
      } else {
        const formatted = formatArgsDisplay(argsText, rawName);
        // Normalize newlines to spaces to prevent forced line breaks
        const normalizedDisplay = formatted.display.replace(/\n/g, " ");
        // For max 2 lines: boxWidth * 2, minus parens (2) and margin (2)
        const argsBoxWidth = rightWidth - displayName.length;
        const maxArgsChars = Math.max(0, argsBoxWidth * 2 - 4);

        const needsTruncation = normalizedDisplay.length > maxArgsChars;
        const truncatedDisplay = needsTruncation
          ? `${normalizedDisplay.slice(0, maxArgsChars - 1)}…`
          : normalizedDisplay;
        args = `(${truncatedDisplay})`;
      }
    }

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

      if (line.resultText === INTERRUPTED_BY_USER) {
        return (
          <Box flexDirection="row">
            <Box width={prefixWidth} flexShrink={0}>
              <Text>{prefix}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text color={colors.status.interrupt}>{INTERRUPTED_BY_USER}</Text>
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

      // Check if this is a memory tool - show diff instead of raw result
      if (isMemoryTool(rawName) && line.resultOk !== false && line.argsText) {
        const memoryDiff = (
          <MemoryDiffRenderer argsText={line.argsText} toolName={rawName} />
        );
        if (memoryDiff) {
          return memoryDiff;
        }
        // If MemoryDiffRenderer returns null, fall through to regular handling
      }

      // Check if this is AskUserQuestion - show pretty Q&A format
      if (isQuestionTool(rawName) && line.resultOk !== false) {
        // Parse the result to extract questions and answers
        // Format: "Question"="Answer", "Question2"="Answer2"
        const qaPairs: Array<{ question: string; answer: string }> = [];
        const qaRegex = /"([^"]+)"="([^"]*)"/g;
        const resultText = line.resultText || "";
        const matches = resultText.matchAll(qaRegex);
        for (const match of matches) {
          if (match[1] && match[2] !== undefined) {
            qaPairs.push({ question: match[1], answer: match[2] });
          }
        }

        if (qaPairs.length > 0) {
          return (
            <Box flexDirection="column">
              {qaPairs.map((qa) => (
                <Box key={qa.question} flexDirection="row">
                  <Box width={prefixWidth} flexShrink={0}>
                    <Text>{prefix}</Text>
                  </Box>
                  <Box flexGrow={1} width={contentWidth}>
                    <Text wrap="wrap">
                      <Text dimColor>·</Text> {qa.question}{" "}
                      <Text dimColor>→</Text> {qa.answer}
                    </Text>
                  </Box>
                </Box>
              ))}
            </Box>
          );
        }
        // Fall through to regular handling if parsing fails
      }

      // Check if this is ExitPlanMode - just show path, not plan content
      // The plan content was already shown during approval via StaticPlanApproval
      // (rendered via Ink's <Static> and is visible in terminal scrollback)
      if (rawName === "ExitPlanMode" && line.resultOk !== false) {
        const planFilePath = lastPlanFilePath;

        if (planFilePath) {
          return (
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>{prefix}</Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text dimColor>Plan saved to: {planFilePath}</Text>
              </Box>
            </Box>
          );
        }
        // Fall through to default if no plan path
      }

      // Check if this is a file edit tool - show diff instead of success message
      if (isFileEditTool(rawName) && line.resultOk !== false && line.argsText) {
        const diff = line.toolCallId
          ? precomputedDiffs?.get(line.toolCallId)
          : undefined;

        try {
          const parsedArgs = JSON.parse(line.argsText);
          const filePath = parsedArgs.file_path || "";

          // Use AdvancedDiffRenderer if we have a precomputed diff
          if (diff) {
            // Multi-edit: has edits array
            if (parsedArgs.edits && Array.isArray(parsedArgs.edits)) {
              const edits = parsedArgs.edits.map(
                (e: {
                  old_string?: string;
                  new_string?: string;
                  replace_all?: boolean;
                }) => ({
                  old_string: e.old_string || "",
                  new_string: e.new_string || "",
                  replace_all: e.replace_all,
                }),
              );
              return (
                <AdvancedDiffRenderer
                  precomputed={diff}
                  kind="multi_edit"
                  filePath={filePath}
                  edits={edits}
                />
              );
            }
            // Single edit
            return (
              <AdvancedDiffRenderer
                precomputed={diff}
                kind="edit"
                filePath={filePath}
                oldString={parsedArgs.old_string || ""}
                newString={parsedArgs.new_string || ""}
                replaceAll={parsedArgs.replace_all}
              />
            );
          }

          // Fallback to simple renderers when no precomputed diff
          // Multi-edit: has edits array
          if (parsedArgs.edits && Array.isArray(parsedArgs.edits)) {
            const edits = parsedArgs.edits.map(
              (e: { old_string?: string; new_string?: string }) => ({
                old_string: e.old_string || "",
                new_string: e.new_string || "",
              }),
            );
            return (
              <MultiEditRenderer
                filePath={filePath}
                edits={edits}
                showLineNumbers={false}
              />
            );
          }

          // Single edit: has old_string/new_string
          if (parsedArgs.old_string !== undefined) {
            return (
              <EditRenderer
                filePath={filePath}
                oldString={parsedArgs.old_string || ""}
                newString={parsedArgs.new_string || ""}
                showLineNumbers={false}
              />
            );
          }
        } catch {
          // If parsing fails, fall through to regular handling
        }
      }

      // Check if this is a file write tool - show written content
      if (
        isFileWriteTool(rawName) &&
        line.resultOk !== false &&
        line.argsText
      ) {
        const diff = line.toolCallId
          ? precomputedDiffs?.get(line.toolCallId)
          : undefined;

        try {
          const parsedArgs = JSON.parse(line.argsText);
          const filePath = parsedArgs.file_path || "";
          const content = parsedArgs.content || "";

          if (filePath && content) {
            if (diff) {
              return (
                <AdvancedDiffRenderer
                  precomputed={diff}
                  kind="write"
                  filePath={filePath}
                  content={content}
                />
              );
            }
            return <WriteRenderer filePath={filePath} content={content} />;
          }
        } catch {
          // If parsing fails, fall through to regular handling
        }
      }

      // Check if this is a patch tool - show diff/content based on operation type
      if (isPatchTool(rawName) && line.resultOk !== false && line.argsText) {
        try {
          const parsedArgs = JSON.parse(line.argsText);
          if (parsedArgs.input) {
            const operations = parsePatchOperations(parsedArgs.input);

            if (operations.length > 0) {
              return (
                <Box flexDirection="column">
                  {operations.map((op) => {
                    // Look up precomputed diff using compound key
                    const key = `${line.toolCallId}:${op.path}`;
                    const diff = precomputedDiffs?.get(key);

                    if (op.kind === "add") {
                      return diff ? (
                        <AdvancedDiffRenderer
                          key={`patch-add-${op.path}`}
                          precomputed={diff}
                          kind="write"
                          filePath={op.path}
                          content={op.content}
                        />
                      ) : (
                        <WriteRenderer
                          key={`patch-add-${op.path}`}
                          filePath={op.path}
                          content={op.content}
                        />
                      );
                    }
                    if (op.kind === "update") {
                      return diff ? (
                        <AdvancedDiffRenderer
                          key={`patch-update-${op.path}`}
                          precomputed={diff}
                          kind="edit"
                          filePath={op.path}
                          oldString={op.oldString}
                          newString={op.newString}
                        />
                      ) : (
                        <EditRenderer
                          key={`patch-update-${op.path}`}
                          filePath={op.path}
                          oldString={op.oldString}
                          newString={op.newString}
                          showLineNumbers={false}
                        />
                      );
                    }
                    if (op.kind === "delete") {
                      const gutterWidth = 4;
                      return (
                        <Box
                          key={`patch-delete-${op.path}`}
                          flexDirection="row"
                        >
                          <Box width={gutterWidth} flexShrink={0}>
                            <Text>
                              {"  "}
                              <Text dimColor>⎿</Text>
                            </Text>
                          </Box>
                          <Box flexGrow={1}>
                            <Text wrap="wrap">
                              Deleted <Text bold>{op.path}</Text>
                            </Text>
                          </Box>
                        </Box>
                      );
                    }
                    return null;
                  })}
                </Box>
              );
            }
          }
        } catch {
          // If parsing fails, fall through to regular handling
        }
      }

      // Check if this is a file read tool - show line count summary
      if (
        isFileReadTool(rawName) &&
        line.resultOk !== false &&
        line.resultText
      ) {
        // Count lines in the result (the content returned by Read tool)
        const lineCount = line.resultText.split("\n").length;
        return (
          <Box flexDirection="row">
            <Box width={prefixWidth} flexShrink={0}>
              <Text>{prefix}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text>
                Read <Text bold>{lineCount}</Text> lines
              </Text>
            </Box>
          </Box>
        );
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
              <Text wrap="wrap">
                {isMemoryTool(rawName) ? (
                  <>
                    <Text bold color={colors.tool.memoryName}>
                      {displayName}
                    </Text>
                    {args}
                  </>
                ) : (
                  <>
                    <Text bold>{displayName}</Text>
                    {args}
                  </>
                )}
              </Text>
            ) : (
              <Box flexDirection="row">
                <Text
                  bold
                  color={
                    isMemoryTool(rawName) ? colors.tool.memoryName : undefined
                  }
                >
                  {displayName}
                </Text>
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

        {/* Streaming output for shell tools during execution */}
        {isShellTool(rawName) && line.phase === "running" && line.streaming && (
          <StreamingOutputDisplay streaming={line.streaming} />
        )}

        {/* Collapsed output for shell tools after completion */}
        {isShellTool(rawName) &&
          line.phase === "finished" &&
          line.resultText &&
          line.resultOk !== false && (
            <CollapsedOutputDisplay output={line.resultText} />
          )}

        {/* Tool result for non-shell tools or shell tool errors */}
        {(() => {
          // Show default result element when:
          // - Not a shell tool (always show result)
          // - Shell tool with error (show error message)
          // - Shell tool in streaming/ready phase (show default "Running..." etc)
          const showDefaultResult =
            !isShellTool(rawName) ||
            (line.phase === "finished" && line.resultOk === false) ||
            (line.phase !== "running" && line.phase !== "finished");
          return showDefaultResult ? getResultElement() : null;
        })()}
      </Box>
    );
  },
);

ToolCallMessage.displayName = "ToolCallMessage";
