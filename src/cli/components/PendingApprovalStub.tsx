import { Box } from "ink";
import { memo } from "react";
import { Text } from "./Text";

type Props = {
  toolName: string;
  description?: string;
  decision?: {
    type: "approve" | "deny";
    reason?: string;
  };
};

export const PendingApprovalStub = memo(
  ({ toolName, description, decision }: Props) => {
    if (decision) {
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
