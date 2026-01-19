import { Box, Text } from "ink";
import { memo } from "react";

type Props = {
  toolName: string;
  description?: string;
  /** If provided, shows as "Decision queued" instead of "Awaiting approval" */
  decision?: {
    type: "approve" | "deny";
    reason?: string;
  };
};

/**
 * PendingApprovalStub - Compact placeholder for approvals that aren't currently active.
 *
 * When multiple tools need approval, only one shows the full approval UI at a time.
 * Others display as this minimal stub to avoid cluttering the transcript.
 *
 * Two modes:
 * - Pending (no decision): "⧗ Awaiting approval: <tool>"
 * - Queued (decision made): "✓ Decision queued: approve" or "✕ Decision queued: deny"
 */
export const PendingApprovalStub = memo(
  ({ toolName, description, decision }: Props) => {
    if (decision) {
      // Queued state - decision made but not yet executed
      const isApprove = decision.type === "approve";
      return (
        <Box>
          <Text dimColor>
            <Text color={isApprove ? "green" : "red"}>
              {isApprove ? "✓" : "✕"}
            </Text>
            {" Decision queued: "}
            <Text>{isApprove ? "approve" : "deny"}</Text>{" "}
            <Text dimColor>({toolName})</Text>
          </Text>
        </Box>
      );
    }

    // Pending state - awaiting user decision
    return (
      <Box>
        <Text dimColor>
          <Text color="yellow">⧗</Text>
          {" Awaiting approval: "}
          <Text>{toolName}</Text>
          {description && <Text dimColor> ({description})</Text>}
        </Text>
      </Box>
    );
  },
);

PendingApprovalStub.displayName = "PendingApprovalStub";
