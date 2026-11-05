import { Box } from "ink";
import type { ChatGPTRateLimitResetCredit } from "@/providers/chatgpt-reset-credit-service";
import { formatResetCreditLabel } from "./chatgpt-reset-credit-helpers";
import { colors } from "./colors";
import { Text } from "./Text";

export type ResetPickerPhase = "select" | "confirm" | "consuming";

interface ChatGPTResetCreditPickerProps {
  providerName: string;
  credits: readonly ChatGPTRateLimitResetCredit[];
  selectedIndex: number;
  phase: ResetPickerPhase;
  /** Credit chosen for the confirm/consuming phases. */
  chosen?: ChatGPTRateLimitResetCredit;
}

/**
 * Explicit, user-driven reset flow: pick a credit, then confirm with a second
 * keypress. Spending a reset affects the ChatGPT account everywhere it is
 * used, so nothing here redeems automatically.
 */
export function ChatGPTResetCreditPicker({
  providerName,
  credits,
  selectedIndex,
  phase,
  chosen,
}: ChatGPTResetCreditPickerProps) {
  if (phase !== "select" && chosen) {
    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Use a reset on {providerName}?
          </Text>
          <Box height={1} />
          <Text>
            {"  "}
            {formatResetCreditLabel(chosen)}
          </Text>
          <Box height={1} />
          <Text dimColor>
            {"  "}This clears the current ChatGPT usage limit for this account
          </Text>
          <Text dimColor>
            {"  "}everywhere it is used. It cannot be undone.
          </Text>
        </Box>
        <Box marginTop={1}>
          {phase === "consuming" ? (
            <Text dimColor>{"  "}Applying reset...</Text>
          ) : (
            <Text dimColor>{"  "}Enter use reset · Esc cancel</Text>
          )}
        </Box>
      </>
    );
  }

  return (
    <>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Resets for {providerName}
        </Text>
        <Box height={1} />
        {credits.map((credit, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={credit.id} flexDirection="row">
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "> " : "  "}
              </Text>
              <Text
                bold={isSelected}
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {formatResetCreditLabel(credit)}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"  "}Enter choose · ↑↓ navigate · Esc back</Text>
      </Box>
    </>
  );
}
