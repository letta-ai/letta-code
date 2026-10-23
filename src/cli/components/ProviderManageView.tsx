import { Box } from "ink";
import type {
  ChatGPTResetCreditsStatus,
  ChatGPTUsageStatus,
} from "@/cli/hooks/use-chatgpt-rate-limit-state";
import type { ProviderResponse } from "@/providers/byok-providers";
import { ChatGPTAccountUsage, ResetNoticeLine } from "./ChatGPTAccountUsage";
import type { ResetNotice } from "./chatgpt-reset-credit-helpers";
import { colors } from "./colors";
import { Text } from "./Text";

interface ProviderManageViewProps {
  displayName: string;
  connectedRecords: readonly ProviderResponse[];
  showChatGPTUsage: boolean;
  usageByProvider: Record<string, ChatGPTUsageStatus>;
  creditsByProvider: Record<string, ChatGPTResetCreditsStatus>;
  resetNotice: ResetNotice | null;
  optionLabels: readonly string[];
  optionIndex: number;
}

/** Connected-account list and manage menu for one provider in /connect. */
export function ProviderManageView({
  displayName,
  connectedRecords,
  showChatGPTUsage,
  usageByProvider,
  creditsByProvider,
  resetNotice,
  optionLabels,
  optionIndex,
}: ProviderManageViewProps) {
  return (
    <>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Manage {displayName}
        </Text>
        <Box height={1} />
        {connectedRecords.length > 0 ? (
          connectedRecords.map((record) => (
            <Box key={record.id} flexDirection="column">
              <Box flexDirection="row">
                <Text>{"  "}</Text>
                <Text color="green">[✓]</Text>
                <Text> </Text>
                <Text bold>{record.name}</Text>
                <Text dimColor> · </Text>
                <Text color="green">Connected</Text>
              </Box>
              {showChatGPTUsage && (
                <ChatGPTAccountUsage
                  usage={usageByProvider[record.name]}
                  credits={creditsByProvider[record.name]}
                />
              )}
            </Box>
          ))
        ) : (
          <Text dimColor>{"  "}No connected providers.</Text>
        )}
      </Box>
      {resetNotice && <ResetNoticeLine notice={resetNotice} />}

      <Box flexDirection="column">
        {optionLabels.map((option, index) => {
          const isSelected = index === optionIndex;
          const color = isSelected
            ? colors.selector.itemHighlighted
            : undefined;
          return (
            <Box key={option} flexDirection="row">
              <Text color={color}>{isSelected ? "> " : "  "}</Text>
              <Text bold={isSelected} color={color}>
                {option}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{"  "}Enter confirm · ↑↓ navigate · Esc back</Text>
      </Box>
    </>
  );
}
