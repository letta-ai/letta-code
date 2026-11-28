import { Box } from "ink";
import { memo, type ReactNode } from "react";
import { getSubagentByToolCallId } from "@/agent/subagent-state.js";
import { parseAskUserQuestionReceipt } from "@/ask-user-question";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import {
  formatArgsDisplay,
  parsePatchInput,
  parsePatchOperations,
} from "@/cli/helpers/format-args-display.js";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import {
  getDisplayToolName,
  isFileEditTool,
  isFileReadTool,
  isFileWriteTool,
  isGlobTool,
  isMemoryTool,
  isPatchTool,
  isPlanTool,
  isSearchTool,
  isShellOutputTool,
  isShellTool,
  isTaskCrudTool,
  isTaskTool,
  isTodoTool,
  isWorkflowTool,
} from "@/cli/helpers/tool-name-mapping.js";
import { formatUnifiedExecOutputForTui } from "@/cli/helpers/unified-exec-output.js";
import { formatWorkflowLaunchLine } from "@/cli/helpers/workflow-display";
import { INTERRUPTED_BY_USER } from "@/constants";
import { listTasks } from "@/tools/impl/tasks/store.js";
import { clipToolReturn } from "@/tools/manager.js";
import { isRecord } from "@/utils/type-guards";
import { Text } from "./Text";

function isQuestionTool(name: string): boolean {
  return name === "AskUserQuestion";
}

import type { StreamingState } from "@/cli/helpers/accumulator";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";
import { CollapsedOutputDisplay } from "./CollapsedOutputDisplay";
import { colors } from "./colors.js";
import {
  EditRenderer,
  MultiEditRenderer,
  WriteRenderer,
} from "./DiffRenderer.js";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { PlanRenderer } from "./PlanRenderer.js";
import {
  parseSendAgentMessageDisplay,
  SendAgentMessageRenderer,
} from "./SendAgentMessageRenderer";
import { StreamingOutputDisplay } from "./StreamingOutputDisplay";
import {
  clipStyledSpans,
  highlightCommand,
  type StyledSpan,
} from "./SyntaxHighlightedCommand";
import { TodoRenderer } from "./TodoRenderer.js";
import { colorizeArgs, ToolCallHeader } from "./ToolCallHeader";
import {
  hasWorktreeResultRenderer,
  WorktreeToolResult,
} from "./WorktreeResultRenderer.js";

const LIVE_SHELL_ARGS_MAX_LINES = 2;

function renderSpans(spans: StyledSpan[]): ReactNode {
  return spans.map((span, i) => (
    <Text key={`${i}:${span.color}`} color={span.color}>
      {span.text}
    </Text>
  ));
}

type ToolCallLine = {
  kind: "tool_call";
  id: string;
  toolCallId?: string;
  name?: string;
  argsText?: string;
  unifiedExecCommandDisplay?: string;
  resultText?: string;
  resultOk?: boolean;
  phase: "streaming" | "ready" | "running" | "finished";
  streaming?: StreamingState;
};

export const ToolCallMessage = memo(
  ({
    line,
    remote = false,
    groupedTask = false,
    precomputedDiffs,
    isStreaming,
    expandedToolCallId,
    lastShellToolCallId,
  }: {
    line: ToolCallLine;
    remote?: boolean;
    groupedTask?: boolean;
    precomputedDiffs?: Map<string, AdvancedDiffSuccess>;
    isStreaming?: boolean;
    expandedToolCallId?: string | null;
    lastShellToolCallId?: string | null;
  }) => {
    const columns = useTerminalWidth();
    try {
      const rawName = line.name ?? "?";
      const argsText =
        typeof line.argsText === "string"
          ? line.argsText
          : line.argsText == null
            ? ""
            : JSON.stringify(line.argsText);

      if (isTaskTool(rawName)) {
        const isFinished = line.phase === "finished";
        const subagent =
          !remote && line.toolCallId
            ? getSubagentByToolCallId(line.toolCallId)
            : undefined;
        if (subagent || groupedTask) {
          return null;
        }
        if (!isFinished) {
          return null;
        }
      }

      if (rawName === "SendAgentMessage") {
        const display = parseSendAgentMessageDisplay(line);
        if (display) {
          return (
            <SendAgentMessageRenderer
              display={display}
              phase={line.phase}
              isStreaming={isStreaming}
            />
          );
        }
      }

      let displayName = getDisplayToolName(rawName);

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
        } catch {}
      }

      if (isQuestionTool(rawName)) {
        if (line.phase === "finished" && line.resultOk !== false) {
          displayName = parseAskUserQuestionReceipt(line.resultText)
            ? "Questions posted"
            : "User answered Letta Code's questions:";
        } else {
          displayName = "Asking user questions...";
        }
      }

      const rightWidth = Math.max(0, columns - 2);

      let args: ReactNode = null;
      let shellCommand: string | null = null;
      let shellSemanticKind: "read" | "list" | "search" | "run" | null = null;
      let hasShellDescription = false;
      if (!isQuestionTool(rawName)) {
        const parseArgs = (): {
          formatted: ReturnType<typeof formatArgsDisplay> | null;
          parseable: boolean;
        } => {
          if (!argsText.trim()) {
            return { formatted: null, parseable: true };
          }
          try {
            const formatted = formatArgsDisplay(argsText, rawName, {
              unifiedExecCommandDisplay: line.unifiedExecCommandDisplay,
              suppressUnifiedExecInteractionLabel:
                rawName === "write_stdin" &&
                line.phase === "finished" &&
                line.resultOk === false,
            });
            return { formatted, parseable: true };
          } catch {
            return { formatted: null, parseable: false };
          }
        };

        const { formatted, parseable } = parseArgs();
        const argsComplete =
          parseable ||
          line.phase === "running" ||
          line.phase === "finished" ||
          !isStreaming;

        if (!argsComplete) {
          args = "(…)";
        } else {
          const formattedArgs =
            formatted ??
            formatArgsDisplay(argsText, rawName, {
              unifiedExecCommandDisplay: line.unifiedExecCommandDisplay,
              suppressUnifiedExecInteractionLabel:
                rawName === "write_stdin" &&
                line.phase === "finished" &&
                line.resultOk === false,
            });
          if (formattedArgs.shellSemantic) {
            shellSemanticKind = formattedArgs.shellSemantic.kind;
            displayName = formattedArgs.shellSemantic.label;
            hasShellDescription =
              typeof formattedArgs.parsed.description === "string" &&
              formattedArgs.parsed.description.trim().length > 0;
            if (
              formattedArgs.shellSemantic.kind === "run" &&
              !hasShellDescription
            ) {
              shellCommand = formattedArgs.shellSemantic.rawCommand;
            }
          } else if (formattedArgs.displayName) {
            displayName = formattedArgs.displayName;
          }
          const normalizedDisplay = formattedArgs.display.replace(/\n/g, " ");
          const argsBoxWidth = rightWidth - displayName.length;
          const maxArgsChars = Math.max(0, argsBoxWidth * 2 - 4);

          const needsTruncation = normalizedDisplay.length > maxArgsChars;
          const truncatedDisplay = needsTruncation
            ? `${normalizedDisplay.slice(0, maxArgsChars - 1)}…`
            : normalizedDisplay;
          args = colorizeArgs(truncatedDisplay);
        }
      }

      if (
        !shellCommand &&
        isShellTool(rawName) &&
        argsText.trim() &&
        !hasShellDescription &&
        (shellSemanticKind === null || shellSemanticKind === "run")
      ) {
        try {
          const parsedArgs = JSON.parse(argsText);
          if (typeof parsedArgs.cmd === "string") {
            shellCommand = parsedArgs.cmd;
          } else if (typeof parsedArgs.command === "string") {
            shellCommand = parsedArgs.command;
          } else if (Array.isArray(parsedArgs.command)) {
            shellCommand = parsedArgs.command.join(" ");
          }
        } catch {}
      }

      let shellFirstLineSpans: StyledSpan[] | null = null;
      let shellContinuationLines: StyledSpan[][] = [];
      if (shellCommand) {
        const highlightedLines = highlightCommand(shellCommand);
        const nameWidth = displayName.length + 1;
        const commandMaxColumns = Math.max(10, rightWidth - nameWidth);
        const nonEmptyLines = highlightedLines.filter((spans) =>
          spans.some((s) => s.text.length > 0),
        );
        const visibleLines = nonEmptyLines.slice(0, LIVE_SHELL_ARGS_MAX_LINES);
        const clippedFirstLine = clipStyledSpans(
          visibleLines[0] ?? [],
          commandMaxColumns,
        );
        shellFirstLineSpans = clippedFirstLine.spans;
        shellContinuationLines = visibleLines.slice(1);
      }

      const extractMessageFromResult = (text: string): string => {
        try {
          const parsed = JSON.parse(text);
          if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.message === "string"
          ) {
            return parsed.message;
          }
        } catch {}
        return text;
      };

      const getResultElement = () => {
        if (!line.resultText) return null;

        const extractedText = extractMessageFromResult(line.resultText);
        const prefix = `  ${CLI_GLYPHS.result}  `;
        const prefixWidth = 5;
        const contentWidth = Math.max(0, columns - prefixWidth);

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
                <Text color={colors.status.interrupt}>
                  {INTERRUPTED_BY_USER}
                </Text>
              </Box>
            </Box>
          );
        }

        const displayResultText =
          (isWorkflowTool(rawName) &&
            formatWorkflowLaunchLine(extractedText)) ||
          clipToolReturn(extractedText).replace(/\n+$/, "");

        if (
          isTodoTool(rawName, displayName) &&
          line.resultOk !== false &&
          line.argsText
        ) {
          try {
            const parsedArgs = JSON.parse(line.argsText);
            if (parsedArgs.todos && Array.isArray(parsedArgs.todos)) {
              const safeTodos = parsedArgs.todos.map(
                (t: unknown, i: number) => {
                  const rec = isRecord(t) ? t : {};
                  const status: "pending" | "in_progress" | "completed" =
                    rec.status === "completed"
                      ? "completed"
                      : rec.status === "in_progress"
                        ? "in_progress"
                        : "pending";
                  const id = typeof rec.id === "string" ? rec.id : String(i);
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
                },
              );

              return <TodoRenderer todos={safeTodos} />;
            }
          } catch {}
        }

        if (!remote && isTaskCrudTool(rawName) && line.resultOk !== false) {
          try {
            const tasks = listTasks();
            if (tasks.length > 0) {
              const safeTodos = tasks.map((t) => ({
                content: t.subject,
                status: (t.status === "deleted" ? "completed" : t.status) as
                  | "pending"
                  | "in_progress"
                  | "completed",
                id: t.taskId,
              }));
              return <TodoRenderer todos={safeTodos} />;
            }
          } catch {}
        }

        if (
          isPlanTool(rawName, displayName) &&
          line.resultOk !== false &&
          line.argsText
        ) {
          try {
            const parsedArgs = JSON.parse(line.argsText);
            if (parsedArgs.plan && Array.isArray(parsedArgs.plan)) {
              const safePlan = parsedArgs.plan.map((item: unknown) => {
                const rec = isRecord(item) ? item : {};
                const status: "pending" | "in_progress" | "completed" =
                  rec.status === "completed"
                    ? "completed"
                    : rec.status === "in_progress"
                      ? "in_progress"
                      : "pending";
                const step =
                  typeof rec.step === "string"
                    ? rec.step
                    : JSON.stringify(item);
                return { step, status };
              });

              const explanation =
                typeof parsedArgs.explanation === "string"
                  ? parsedArgs.explanation
                  : undefined;

              return <PlanRenderer plan={safePlan} explanation={explanation} />;
            }
          } catch {}
        }

        if (isQuestionTool(rawName) && line.resultOk !== false) {
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
        }

        if (hasWorktreeResultRenderer(rawName, extractedText, line.resultOk)) {
          return (
            <WorktreeToolResult toolName={rawName} resultText={extractedText} />
          );
        }

        if (remote && line.resultOk !== false && line.toolCallId) {
          const diff = precomputedDiffs?.get(line.toolCallId);
          if (diff)
            return (
              <AdvancedDiffRenderer
                precomputed={diff}
                kind="write"
                filePath={diff.fileName}
                content=""
              />
            );
        }
        if (
          !remote &&
          isFileEditTool(rawName) &&
          line.resultOk !== false &&
          line.argsText
        ) {
          const diff = line.toolCallId
            ? precomputedDiffs?.get(line.toolCallId)
            : undefined;

          try {
            const parsedArgs = JSON.parse(line.argsText);
            const filePath = parsedArgs.file_path || "";

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

            if (diff) {
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
          } catch {}
        }

        if (
          !remote &&
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
          } catch {}
        }

        if (
          !remote &&
          isPatchTool(rawName) &&
          line.resultOk !== false &&
          line.argsText
        ) {
          try {
            const parsedArgs = JSON.parse(line.argsText);
            if (parsedArgs.input) {
              const operations = parsePatchOperations(parsedArgs.input);

              if (operations.length > 0) {
                return (
                  <Box flexDirection="column">
                    {operations.map((op) => {
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
                                <Text dimColor>{CLI_GLYPHS.result}</Text>
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
          } catch {}
        }

        if (
          isFileReadTool(rawName) &&
          line.resultOk !== false &&
          line.resultText
        ) {
          const isImageResult = line.resultText.startsWith("[Image: ");

          if (isImageResult) {
            return (
              <Box flexDirection="row">
                <Box width={prefixWidth} flexShrink={0}>
                  <Text>{prefix}</Text>
                </Box>
                <Box flexGrow={1} width={contentWidth}>
                  <Text>
                    Read <Text bold>1</Text> image
                  </Text>
                </Box>
              </Box>
            );
          }

          const lineCount = line.resultText.split("\n").length;
          return (
            <Box flexDirection="row">
              <Box width={prefixWidth} flexShrink={0}>
                <Text>{prefix}</Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <Text>
                  Read <Text bold>{lineCount}</Text> line
                  {lineCount !== 1 ? "s" : ""}
                </Text>
              </Box>
            </Box>
          );
        }

        if (
          isSearchTool(rawName) &&
          line.resultOk !== false &&
          line.resultText
        ) {
          const text = line.resultText;
          const filesMatch = text.match(/^Found (\d+) files?/);
          const noFilesMatch = text === "No files found";
          const noMatchesMatch = text === "No matches found";

          if (filesMatch?.[1]) {
            const count = parseInt(filesMatch[1], 10);
            return (
              <Box flexDirection="row">
                <Box width={prefixWidth} flexShrink={0}>
                  <Text>{prefix}</Text>
                </Box>
                <Box flexGrow={1} width={contentWidth}>
                  <Text>
                    Found <Text bold>{count}</Text> file{count !== 1 ? "s" : ""}
                  </Text>
                </Box>
              </Box>
            );
          } else if (noFilesMatch || noMatchesMatch) {
            return (
              <Box flexDirection="row">
                <Box width={prefixWidth} flexShrink={0}>
                  <Text>{prefix}</Text>
                </Box>
                <Box flexGrow={1} width={contentWidth}>
                  <Text>
                    Found <Text bold>0</Text>{" "}
                    {noFilesMatch ? "files" : "matches"}
                  </Text>
                </Box>
              </Box>
            );
          } else {
            const lineCount = text.split("\n").length;
            return (
              <Box flexDirection="row">
                <Box width={prefixWidth} flexShrink={0}>
                  <Text>{prefix}</Text>
                </Box>
                <Box flexGrow={1} width={contentWidth}>
                  <Text>
                    Found <Text bold>{lineCount}</Text> line
                    {lineCount !== 1 ? "s" : ""}
                  </Text>
                </Box>
              </Box>
            );
          }
        }

        if (isGlobTool(rawName) && line.resultOk !== false && line.resultText) {
          const text = line.resultText;
          const filesMatch = text.match(/^Found (\d+) files?/);
          const noFilesMatch = text === "No files found";

          if (filesMatch?.[1]) {
            const count = parseInt(filesMatch[1], 10);
            return (
              <Box flexDirection="row">
                <Box width={prefixWidth} flexShrink={0}>
                  <Text>{prefix}</Text>
                </Box>
                <Box flexGrow={1} width={contentWidth}>
                  <Text>
                    Found <Text bold>{count}</Text> file{count !== 1 ? "s" : ""}
                  </Text>
                </Box>
              </Box>
            );
          } else if (noFilesMatch) {
            return (
              <Box flexDirection="row">
                <Box width={prefixWidth} flexShrink={0}>
                  <Text>{prefix}</Text>
                </Box>
                <Box flexGrow={1} width={contentWidth}>
                  <Text>
                    Found <Text bold>0</Text> files
                  </Text>
                </Box>
              </Box>
            );
          }
        }

        const isError = line.resultOk === false;

        let displayText = displayResultText;
        try {
          const parsed = JSON.parse(displayResultText);
          if (parsed.error && typeof parsed.error === "string") {
            displayText = parsed.error;
          }
        } catch {}

        if (isError && displayText.includes("request to call tool denied")) {
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
          <ToolCallHeader
            name={displayName}
            args={args}
            shellArgs={
              shellFirstLineSpans ? renderSpans(shellFirstLineSpans) : undefined
            }
            columns={columns}
            phase={line.phase}
            resultOk={line.resultOk}
            isStreaming={isStreaming}
            isMemory={isMemoryTool(rawName)}
          />

          {shellContinuationLines.map((spans) => {
            const clipped = clipStyledSpans(spans, columns - 5);
            const lineKey = spans.map((s) => s.text).join("");
            return (
              <Box key={lineKey} flexDirection="row">
                <Box width={5} flexShrink={0}>
                  <Text color={colors.shellSyntax.text}>
                    {"  "}
                    {CLI_GLYPHS.continuation}
                    {"  "}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={colors.shellSyntax.text}>
                    {renderSpans(clipped.spans)}
                  </Text>
                </Box>
              </Box>
            );
          })}

          {isShellOutputTool(rawName) &&
            line.phase === "running" &&
            line.streaming && (
              <StreamingOutputDisplay streaming={line.streaming} />
            )}

          {isShellOutputTool(rawName) &&
            line.phase === "finished" &&
            line.resultText &&
            line.resultOk !== false &&
            (() => {
              const output = formatUnifiedExecOutputForTui(
                extractMessageFromResult(line.resultText),
                { hideEmptyCompletion: rawName === "write_stdin" },
              );
              return output ? (
                <CollapsedOutputDisplay
                  output={output}
                  maxChars={300}
                  expanded={
                    expandedToolCallId != null && expandedToolCallId === line.id
                  }
                  isLast={lastShellToolCallId === line.id}
                />
              ) : null;
            })()}

          {(() => {
            const showDefaultResult =
              !isShellOutputTool(rawName) ||
              (line.phase === "finished" && line.resultOk === false) ||
              (line.phase !== "running" && line.phase !== "finished");
            return showDefaultResult ? getResultElement() : null;
          })()}
        </Box>
      );
    } catch (err) {
      console.error(
        `[ToolCallMessage render error] tool=${line.name} id=${line.id}`,
        err,
      );
      return (
        <Text color="red">
          ⚠ render error: {line.name ?? "?"} ({String(err)})
        </Text>
      );
    }
  },
);

ToolCallMessage.displayName = "ToolCallMessage";
