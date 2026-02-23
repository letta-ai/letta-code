import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";

interface ListenerStatusUIProps {
  connectionId: string;
  onReady: (callbacks: {
    updateStatus: (status: "idle" | "receiving" | "processing") => void;
    updateRetryStatus: (attempt: number, nextRetryIn: number) => void;
    clearRetryStatus: () => void;
  }) => void;
}

export function ListenerStatusUI(props: ListenerStatusUIProps) {
  const { connectionId, onReady } = props;
  const [status, setStatus] = useState<"idle" | "receiving" | "processing">(
    "idle",
  );
  const [retryInfo, setRetryInfo] = useState<{
    attempt: number;
    nextRetryIn: number;
  } | null>(null);

  useEffect(() => {
    onReady({
      updateStatus: setStatus,
      updateRetryStatus: (attempt, nextRetryIn) => {
        setRetryInfo({ attempt, nextRetryIn });
      },
      clearRetryStatus: () => {
        setRetryInfo(null);
      },
    });
  }, [onReady]);

  const statusText = retryInfo
    ? `Reconnecting (attempt ${retryInfo.attempt}, retry in ${Math.round(retryInfo.nextRetryIn / 1000)}s)`
    : status === "receiving"
      ? "Receiving message"
      : status === "processing"
        ? "Processing message"
        : "Awaiting instructions";

  const showSpinner = status !== "idle" || retryInfo !== null;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="green">
          Connected to Letta Cloud
        </Text>
      </Box>

      <Box>
        {showSpinner && (
          <Text>
            <Text color={retryInfo ? "yellow" : "cyan"}>
              <Spinner type="dots" />
            </Text>{" "}
            <Text color={retryInfo ? "yellow" : undefined}>{statusText}</Text>
          </Text>
        )}
        {!showSpinner && <Text dimColor>{statusText}</Text>}
      </Box>
    </Box>
  );
}
