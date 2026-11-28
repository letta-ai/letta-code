import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { openEmbeddedTerminal } from "./embedded-terminal";
import { SessionViewHost } from "./SessionViewHost";

export function TerminalSessionHost({
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
  const { exit } = useApp();
  useInput((input, key) => {
    if (!session && key.ctrl && input === "c") exit();
  });
  const [cloudError, setCloudError] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let current: typeof session;
    void openEmbeddedTerminal(
      agentId,
      conversationId,
      cloud,
      controller.signal,
      (error) => {
        if (!controller.signal.aborted) setCloudError(error);
      },
    )
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
      {updateNotification && (
        <Text>Update available: {updateNotification}</Text>
      )}
      {cloudError && <Text>Cloud registration unavailable: {cloudError}</Text>}
      <SessionViewHost
        store={session.store}
        initialName={name}
        embeddedCloud={cloud}
      />
    </Box>
  );
}
