import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState, useSyncExternalStore } from "react";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { ReasoningMessage } from "@/cli/components/ReasoningMessageRich";
import { SessionDiff } from "@/cli/components/SessionDiff";
import { ToolCallHeader } from "@/cli/components/ToolCallHeader";
import { UserMessage } from "@/cli/components/UserMessageRich";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import type { DiffPreview } from "@/types/protocol_v2";
import type { TerminalSession } from "./terminal-session";

export function TerminalApp({ store }: { store: TerminalSession }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [draft, setDraft] = useState("");

  const columns = useTerminalWidth();
  const approval = state.approvals[0];
  useInput((input, key) => {
    if (key.escape) void store.interrupt();
    else if (state.status === "offline" && input === "r") void store.connect();
    else if (approval && (input === "y" || input === "n"))
      store.decide(input === "y");
  });
  return (
    <Box flexDirection="column">
      {state.rows.map((row) =>
        row.kind === "assistant" ? (
          <AssistantMessage
            key={row.key}
            line={{
              kind: "assistant",
              id: row.key,
              text: row.text,
              phase: "streaming",
            }}
          />
        ) : row.kind === "user" ? (
          <UserMessage
            key={row.key}
            line={{ kind: "user", id: row.key, text: row.text }}
          />
        ) : row.kind === "tool_call" ? (
          <Box flexDirection="column" key={row.key}>
            <ToolCallHeader
              columns={columns}
              name={row.toolName}
              args={row.rawArguments ?? JSON.stringify(row.toolInput)}
              phase={row.status === "complete" ? "finished" : row.status}
              resultOk={!row.result?.isError}
            />
            {row.result && <Text dimColor>{row.result.content}</Text>}
          </Box>
        ) : (
          <ReasoningMessage
            key={row.key}
            line={{
              kind: "reasoning",
              id: row.key,
              text: row.text,
              phase: state.activity ? "streaming" : "finished",
            }}
          />
        ),
      )}
      {state.activity && <Text dimColor>{state.activity}</Text>}
      {state.queue.length > 0 && <Text>Queued: {state.queue.length}</Text>}
      {state.commandOutput && <Text>{state.commandOutput}</Text>}
      {state.error && <Text color="red">{state.error}</Text>}
      {approval ? (
        <Box flexDirection="column">
          <Text>
            {approval.name} {JSON.stringify(approval.input)}
          </Text>
          {(approval.context?.diffs as DiffPreview[] | undefined)?.map(
            (preview, index) => (
              <SessionDiff
                key={`${preview.fileName}-${index}`}
                preview={preview}
              />
            ),
          )}
          <Text>Allow? [y/n]</Text>
        </Box>
      ) : state.status === "online" ? (
        <Box>
          <Text>❯ </Text>
          <TextInput
            placeholder="Message · /help for commands"
            value={draft}
            onChange={setDraft}
            onSubmit={(value) => {
              if (value.trim()) {
                setDraft("");
                void store.send(value);
              }
            }}
          />
        </Box>
      ) : (
        <Text>
          {state.status === "offline"
            ? "Disconnected · r to reconnect"
            : "Connecting…"}
        </Text>
      )}
    </Box>
  );
}
