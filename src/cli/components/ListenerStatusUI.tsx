import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";

interface ListenerStatusUIProps {
  connectionId: string;
  envName: string;
  onReady: (callbacks: {
    updateStatus: (status: "idle" | "receiving" | "processing") => void;
    updateRetryStatus: (attempt: number, nextRetryIn: number) => void;
    clearRetryStatus: () => void;
  }) => void;
}

export function ListenerStatusUI(props: ListenerStatusUIProps) {
  const { envName, onReady } = props;
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
          The name of your environment is: {envName}
        </Text>
      </Box>

      <Box marginBottom={1}>
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

      <Box>
        <Text dimColor>
          Connect to this environment by visiting any agent and clicking the
          "cloud" button at the bottom left of the messenger input and swapping
          your environment to {envName}
        </Text>
      </Box>
    </Box>
  );
}
