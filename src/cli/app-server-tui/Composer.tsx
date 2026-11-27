import { Box, useInput } from "ink";
import { useState } from "react";
import { colors } from "@/cli/components/colors";
import { PasteAwareTextInput } from "@/cli/components/PasteAwareTextInput";
import { Text } from "@/cli/components/Text";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import type { TuiQueueItem, TuiRunPhase } from "./session-store";

const EXIT_CONFIRM_WINDOW_MS = 1500;

function statusLabel(run: TuiRunPhase): string | null {
  switch (run) {
    case "running":
      return "Working… (esc to interrupt)";
    case "awaiting_approval":
      return "Waiting for approval";
    case "interrupting":
      return "Interrupting…";
    default:
      return null;
  }
}

export function Composer({
  run,
  queue,
  focused,
  columns,
  footer,
  onSubmit,
  onInterrupt,
  onExit,
}: {
  run: TuiRunPhase;
  queue: TuiQueueItem[];
  focused: boolean;
  columns: number;
  footer: string;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
}) {
  const [value, setValue] = useState("");
  const [exitArmedAt, setExitArmedAt] = useState(0);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (value.length > 0) {
        setValue("");
        return;
      }
      if (Date.now() - exitArmedAt < EXIT_CONFIRM_WINDOW_MS) {
        onExit();
        return;
      }
      setExitArmedAt(Date.now());
      return;
    }
    if (key.escape && focused && run !== "idle") onInterrupt();
  });

  const status = statusLabel(run);
  const exitHint =
    exitArmedAt > 0 && Date.now() - exitArmedAt < EXIT_CONFIRM_WINDOW_MS;

  return (
    <Box flexDirection="column" marginTop={1}>
      {status ? <Text color={colors.status.processing}>{status}</Text> : null}
      {queue.map((item) => (
        <Text key={item.id} dimColor>
          {`${CLI_GLYPHS.prompt} ${item.text}${item.pendingRemoval ? " (removing)" : " (queued)"}`}
        </Text>
      ))}
      <Text dimColor>{"─".repeat(Math.max(1, columns))}</Text>
      <Box flexDirection="row">
        <Text>{`${CLI_GLYPHS.prompt} `}</Text>
        <PasteAwareTextInput
          value={value}
          onChange={setValue}
          focus={focused}
          placeholder={run === "idle" ? "Message the agent" : "Queue a message"}
          onSubmit={(submitted) => {
            const text = submitted.trim();
            if (!text) return;
            setValue("");
            onSubmit(text);
          }}
        />
      </Box>
      <Text dimColor>{"─".repeat(Math.max(1, columns))}</Text>
      <Text dimColor>{exitHint ? "Press ctrl-c again to exit" : footer}</Text>
    </Box>
  );
}
