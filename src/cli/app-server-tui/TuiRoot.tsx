import { Box, Static, useApp } from "ink";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ApprovalSwitch } from "@/cli/components/ApprovalSwitch";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { ErrorMessage } from "@/cli/components/ErrorMessageRich";
import { ReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import { StatusMessage } from "@/cli/components/StatusMessage";
import { Text } from "@/cli/components/Text";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";
import { UserMessage } from "@/cli/components/UserMessageRich";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { Composer } from "./Composer";
import type { TuiItem } from "./project-rows";
import type { TuiSessionStore, TuiSnapshot } from "./session-store";

interface TuiHeader {
  agentName: string;
  backendLabel: string;
}

function TranscriptItem({ item }: { item: TuiItem }) {
  switch (item.kind) {
    case "user":
      return <UserMessage line={item} prompt={CLI_GLYPHS.prompt} />;
    case "assistant":
      return <AssistantMessage line={item} />;
    case "reasoning":
      return <ReasoningMessage line={item} />;
    case "tool_call":
      return (
        <ToolCallMessage line={item} isStreaming={item.phase !== "finished"} />
      );
    case "error":
      return <ErrorMessage line={item} />;
    case "status":
      return <StatusMessage line={item} />;
  }
}

type StaticEntry = { kind: "header"; id: string } | TuiItem;

function footerText(snapshot: TuiSnapshot, header: TuiHeader): string {
  const parts: string[] = [];
  if (snapshot.session?.model) parts.push(snapshot.session.model);
  if (snapshot.device) parts.push(snapshot.device.permissionMode);
  parts.push(header.backendLabel);
  if (snapshot.connection !== "connected") parts.push(snapshot.connection);
  return parts.join(" · ");
}

export function TuiRoot({
  store,
  header,
  onCommand,
}: {
  store: TuiSessionStore;
  header: TuiHeader;
  onCommand: (command: string) => boolean;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const columns = useTerminalWidth();
  const { exit } = useApp();

  const committed = useMemo<StaticEntry[]>(
    () => [
      { kind: "header", id: "header" },
      ...snapshot.items.slice(0, snapshot.committedCount),
    ],
    [snapshot.items, snapshot.committedCount],
  );
  const live = snapshot.items.slice(snapshot.committedCount);
  const approval = snapshot.approvals[0];
  const pendingApprovalCount = Math.max(0, snapshot.approvals.length - 1);

  const handleSubmit = useCallback(
    (text: string) => {
      if (text.startsWith("/") && onCommand(text)) return;
      void store.send(text);
    },
    [store, onCommand],
  );
  const handleExit = useCallback(() => {
    store.close();
    exit();
  }, [store, exit]);

  return (
    <Box flexDirection="column">
      <Static
        key={snapshot.epoch}
        items={committed}
        style={{ flexDirection: "column" }}
      >
        {(entry: StaticEntry, index: number) =>
          entry.kind === "header" ? (
            <Box key={entry.id} flexDirection="column">
              <Text bold>{`Letta Code · ${header.agentName}`}</Text>
              <Text
                dimColor
              >{`App Server runtime · ${header.backendLabel}`}</Text>
            </Box>
          ) : (
            <Box key={entry.id} marginTop={index > 0 ? 1 : 0}>
              <TranscriptItem item={entry} />
            </Box>
          )
        }
      </Static>
      {live.map((item) => (
        <Box key={item.id} marginTop={1}>
          <TranscriptItem item={item} />
        </Box>
      ))}
      {approval ? (
        <Box flexDirection="column" marginTop={1}>
          <ApprovalSwitch
            approval={approval}
            allowPersistence={approval.permissionSuggestions.length > 0}
            onApprove={() =>
              store.resolveApproval(approval.requestId, { kind: "allow" })
            }
            onApproveAlways={() =>
              store.resolveApproval(approval.requestId, {
                kind: "allow_always",
              })
            }
            onDeny={(reason) =>
              store.resolveApproval(approval.requestId, {
                kind: "deny",
                reason,
              })
            }
            onCancel={() => void store.interrupt()}
          />
          {pendingApprovalCount > 0 ? (
            <Text dimColor>{`${pendingApprovalCount} more pending`}</Text>
          ) : null}
        </Box>
      ) : null}
      <Composer
        run={snapshot.run}
        queue={snapshot.queue}
        focused={!approval && snapshot.connection !== "closed"}
        columns={columns}
        footer={footerText(snapshot, header)}
        onSubmit={handleSubmit}
        onInterrupt={() => void store.interrupt()}
        onExit={handleExit}
      />
    </Box>
  );
}
