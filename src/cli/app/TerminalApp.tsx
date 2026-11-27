import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AssistantMessage } from "@/cli/components/AssistantMessageRich";
import { UserMessage } from "@/cli/components/UserMessageRich";
import { openEmbeddedTerminal } from "./embedded-terminal";
import type { TerminalSession } from "./terminal-session";

function TerminalConversation({ store }: { store: TerminalSession }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [draft, setDraft] = useState("");
  const { exit } = useApp();
  const approval = state.approvals[0];
  useInput((input, key) => {
    if (key.ctrl && input === "c") exit();
    else if (key.escape) void store.interrupt();
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
        ) : (
          <Text key={row.key}>
            {row.kind === "tool_call"
              ? row.toolName +
                " " +
                (row.result?.content ?? row.rawArguments ?? "")
              : row.text}
          </Text>
        ),
      )}
      {Array.from(state.echoes, ([id, text]) => (
        <UserMessage key={id} line={{ kind: "user", id, text }} />
      ))}
      {state.queue.length > 0 && <Text>Queued: {state.queue.length}</Text>}
      {state.memory && <Text>{state.memory}</Text>}
      {state.error && <Text color="red">{state.error}</Text>}
      {approval ? (
        <Box flexDirection="column">
          <Text>
            {approval.name} {JSON.stringify(approval.input)}
          </Text>
          <Text>{JSON.stringify(approval.context?.diffs)}</Text>
          <Text>Allow? [y/n]</Text>
        </Box>
      ) : state.status === "online" ? (
        <Box>
          <Text>❯ </Text>
          <TextInput
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

export function TerminalApp({
  agentId,
  conversationId,
  cloud,
  name,
  updateNotification,
}: {
  agentId: string;
  conversationId: string;
  cloud: boolean;
  name: string;
  updateNotification: string | null;
}) {
  const [session, setSession] =
    useState<Awaited<ReturnType<typeof openEmbeddedTerminal>>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let current: typeof session;
    void openEmbeddedTerminal(agentId, conversationId, cloud, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) {
          await result.close();
          return;
        }
        current = result;
        setSession(result);
        void result.store.connect();
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(String(reason));
      });
    return () => {
      controller.abort();
      void current?.close();
    };
  }, [agentId, conversationId, cloud]);
  if (!session) return <Text>{error ?? "Connecting to app server…"}</Text>;
  return (
    <Box flexDirection="column">
      <Text bold>{name}</Text>
      {updateNotification && (
        <Text>Update available: {updateNotification}</Text>
      )}
      {session.cloudError && (
        <Text>Cloud registration unavailable: {session.cloudError}</Text>
      )}
      <TerminalConversation store={session.store} />
    </Box>
  );
}
