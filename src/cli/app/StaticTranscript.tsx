import { Box, Static } from "ink";
import { ApprovalPreview } from "../components/ApprovalPreview";
import { AssistantMessage } from "../components/AssistantMessageRich";
import { BashCommandMessage } from "../components/BashCommandMessage";
import { CommandMessage } from "../components/CommandMessage";
import { ErrorMessage } from "../components/ErrorMessageRich";
import { EventMessage } from "../components/EventMessage";
import { ReasoningMessage } from "../components/ReasoningMessageRich";
import { StatusMessage } from "../components/StatusMessage";
import { SubagentGroupStatic } from "../components/SubagentGroupStatic";
import { Text } from "../components/Text";
import { ToolCallMessage } from "../components/ToolCallMessageRich";
import { TrajectorySummary } from "../components/TrajectorySummary";
import { UserMessage } from "../components/UserMessageRich";
import { WelcomeScreen } from "../components/WelcomeScreen";
import type { AdvancedDiffSuccess } from "../helpers/diff";
import type { StaticItem } from "./types";

export function StaticTranscript({
  renderEpoch,
  items,
  columns,
  statusLinePrompt,
  showCompactionsEnabled,
  precomputedDiffs,
  lastPlanFilePath,
  hiddenToolCallId,
  lastShellToolCallId,
}: {
  renderEpoch: number;
  items: StaticItem[];
  columns: number;
  statusLinePrompt: string;
  showCompactionsEnabled: boolean;
  precomputedDiffs: Map<string, AdvancedDiffSuccess>;
  lastPlanFilePath: string | null;
  hiddenToolCallId?: string;
  lastShellToolCallId?: string;
}) {
  return (
    <Static
      key={`${renderEpoch}-${hiddenToolCallId ?? ""}-${lastShellToolCallId ?? ""}`}
      items={items}
      style={{ flexDirection: "column" }}
    >
      {(item: StaticItem, index: number) => {
        try {
          return (
            <Box key={item.id} marginTop={index > 0 ? 1 : 0}>
              {item.kind === "welcome" ? (
                <WelcomeScreen loadingState="ready" {...item.snapshot} />
              ) : item.kind === "user" ? (
                <UserMessage line={item} prompt={statusLinePrompt} />
              ) : item.kind === "reasoning" ? (
                <ReasoningMessage line={item} />
              ) : item.kind === "assistant" ? (
                <AssistantMessage line={item} />
              ) : item.kind === "tool_call" ? (
                <ToolCallMessage
                  line={item}
                  precomputedDiffs={precomputedDiffs}
                  lastPlanFilePath={lastPlanFilePath}
                  expandedToolCallId={hiddenToolCallId}
                  lastShellToolCallId={lastShellToolCallId}
                />
              ) : item.kind === "subagent_group" ? (
                <SubagentGroupStatic agents={item.agents} />
              ) : item.kind === "error" ? (
                <ErrorMessage line={item} />
              ) : item.kind === "status" ? (
                <StatusMessage line={item} />
              ) : item.kind === "event" ? (
                !showCompactionsEnabled &&
                item.eventType === "compaction" ? null : (
                  <EventMessage line={item} />
                )
              ) : item.kind === "separator" ? (
                <Box marginTop={1}>
                  <Text dimColor>{"─".repeat(columns)}</Text>
                </Box>
              ) : item.kind === "command" ? (
                <CommandMessage line={item} />
              ) : item.kind === "bash_command" ? (
                <BashCommandMessage line={item} />
              ) : item.kind === "trajectory_summary" ? (
                <TrajectorySummary line={item} />
              ) : item.kind === "approval_preview" ? (
                <ApprovalPreview
                  toolName={item.toolName}
                  toolArgs={item.toolArgs}
                  precomputedDiff={item.precomputedDiff}
                  allDiffs={precomputedDiffs}
                  planContent={item.planContent}
                  planFilePath={item.planFilePath}
                  toolCallId={item.toolCallId}
                />
              ) : null}
            </Box>
          );
        } catch (err) {
          console.error(
            `[Static render error] kind=${item.kind} id=${item.id}`,
            err,
          );
          return (
            <Box key={item.id}>
              <Text color="red">
                ⚠ render error: {item.kind} ({String(err)})
              </Text>
            </Box>
          );
        }
      }}
    </Static>
  );
}
