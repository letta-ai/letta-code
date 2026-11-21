import { Box } from "ink";
import type {
  ChatGPTResetCreditsStatus,
  ChatGPTUsageStatus,
} from "@/cli/hooks/use-chatgpt-rate-limit-state";
import {
  formatResetCreditsSummary,
  type ResetNotice,
} from "./chatgpt-reset-credit-helpers";
import { Text } from "./Text";

const INDENT = "      ";

function usageRows(status: ChatGPTUsageStatus | undefined): string[] {
  if (!status || status.status === "loading") return ["Loading..."];
  if (status.status === "error") return [`Unavailable: ${status.message}`];
  return status.rows;
}

function creditsRow(status: ChatGPTResetCreditsStatus | undefined): string {
  if (!status || status.status === "loading") return "Resets: loading...";
  if (status.status === "error") return `Resets unavailable: ${status.message}`;
  return formatResetCreditsSummary(status.credits);
}

/** Usage windows plus banked reset inventory under one ChatGPT account row. */
export function ChatGPTAccountUsage({
  usage,
  credits,
}: {
  usage: ChatGPTUsageStatus | undefined;
  credits: ChatGPTResetCreditsStatus | undefined;
}) {
  const usageIsError = usage?.status === "error";
  const creditsIsError = credits?.status === "error";
  return (
    <Box flexDirection="column">
      {usageRows(usage).map((row) => (
        <Box key={row} flexDirection="row">
          <Text>{INDENT}</Text>
          <Text
            color={usageIsError ? "yellow" : undefined}
            dimColor={!usageIsError}
          >
            {row}
          </Text>
        </Box>
      ))}
      <Box flexDirection="row">
        <Text>{INDENT}</Text>
        <Text
          color={creditsIsError ? "yellow" : undefined}
          dimColor={!creditsIsError}
        >
          {creditsRow(credits)}
        </Text>
      </Box>
    </Box>
  );
}

const NOTICE_COLORS = {
  success: "green",
  info: undefined,
  warning: "yellow",
} as const;

export function ResetNoticeLine({ notice }: { notice: ResetNotice }) {
  return (
    <Box marginBottom={1}>
      <Text color={NOTICE_COLORS[notice.tone]}>
        {"  "}
        {notice.message}
      </Text>
    </Box>
  );
}
