import { Box, Static, useInput } from "ink";
import { useSyncExternalStore } from "react";
import { CLEAR_SCREEN_AND_HOME } from "@/cli/app/constants";
import { ApprovalPreview } from "@/cli/components/ApprovalPreview";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { BashCommandMessage } from "@/cli/components/BashCommandMessage";
import { CommandMessage } from "@/cli/components/CommandMessage";
import { ErrorMessage } from "@/cli/components/ErrorMessageRich";
import { EventMessage } from "@/cli/components/EventMessage";
import { ReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import { StatusMessage } from "@/cli/components/StatusMessage";
import { SubagentGroupStatic } from "@/cli/components/SubagentGroupStatic";
import { Text } from "@/cli/components/Text";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";
import { TrajectorySummary } from "@/cli/components/TrajectorySummary";
import {
  getSystemRemindersExpanded,
  getThinkingExpanded,
  subscribeToSystemReminderDisplay,
  subscribeToThinkingDisplay,
  toggleSystemReminderDisplay,
  toggleThinkingDisplay,
} from "@/cli/components/transcript-display-state";
import { UserMessage } from "@/cli/components/UserMessageRich";
import { WelcomeScreen } from "@/cli/components/WelcomeScreen";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { StaticItem } from "./types";

export function StaticTranscript({
  renderEpoch,
  items,
  columns,
  statusLinePrompt,
  showCompactionsEnabled,
  precomputedDiffs,
  hiddenToolCallId,
  lastShellToolCallId,
}: {
  renderEpoch: number;
  items: StaticItem[];
  columns: number;
  statusLinePrompt: string;
  showCompactionsEnabled: boolean;
  precomputedDiffs: Map<string, AdvancedDiffSuccess>;
  hiddenToolCallId?: string;
  /** Used to show ctrl+o hint on the last committed tool call.
   *  Intentionally NOT included in the Static key — passing it here without
   *  keying on it means the hint shows correctly when an item first commits,
   *  and may be stale on older items (minor cosmetic issue, much better than
   *  remounting on every tool call and re-printing history). */
  lastShellToolCallId?: string;
}) {
  const systemRemindersExpanded = useSyncExternalStore(
    subscribeToSystemReminderDisplay,
    getSystemRemindersExpanded,
  );
  const thinkingExpanded = useSyncExternalStore(
    subscribeToThinkingDisplay,
    getThinkingExpanded,
  );
  useInput((input, key) => {
    if (!key.ctrl || (input !== "r" && input !== "t")) return;
    if (process.stdout?.isTTY) process.stdout.write(CLEAR_SCREEN_AND_HOME);
    if (input === "r") toggleSystemReminderDisplay();
    if (input === "t") toggleThinkingDisplay();
  });

  return (
    <Static
      key={`${renderEpoch}-${hiddenToolCallId ?? ""}-${systemRemindersExpanded}-${thinkingExpanded}`}
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
                <UserMessage
                  line={item}
                  prompt={statusLinePrompt}
                  systemRemindersExpanded={systemRemindersExpanded}
                />
              ) : item.kind === "reasoning" ? (
                <ReasoningMessage line={item} expanded={thinkingExpanded} />
              ) : item.kind === "assistant" ? (
                <AssistantMessage line={item} />
              ) : item.kind === "tool_call" ? (
                <ToolCallMessage
                  line={item}
                  precomputedDiffs={precomputedDiffs}
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
