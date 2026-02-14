import React, { useState, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";

interface ListenerStatusUIProps {
  agentId: string;
  connectionId: string;
  onReady: (callbacks: {
    updateStatus: (status: "idle" | "receiving" | "processing") => void;
  }) => void;
}

export function ListenerStatusUI(props: ListenerStatusUIProps) {
  const { agentId, connectionId, onReady } = props;
  const { exit } = useApp();
  const [status, setStatus] = useState<"idle" | "receiving" | "processing">(
    "idle",
  );

  useEffect(() => {
    onReady({
      updateStatus: setStatus,
    });
  }, [onReady]);

  const adeUrl = `https://app.letta.com/agents/${agentId}?deviceId=${connectionId}`;

  const statusText =
    status === "receiving"
      ? "Receiving message"
      : status === "processing"
        ? "Processing message"
        : "Awaiting instructions";

  const showSpinner = status !== "idle";

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="green">
          Connected to Letta Cloud
        </Text>
      </Box>

      <Box marginBottom={1}>
        {showSpinner && (
          <Text>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            {" "}
            <Text>{statusText}</Text>
          </Text>
        )}
        {!showSpinner && <Text dimColor>{statusText}</Text>}
      </Box>

      <Box>
        <Text dimColor>View in ADE → </Text>
        <Text color="blue" underline>
          {adeUrl}
        </Text>
      </Box>
    </Box>
  );
}
