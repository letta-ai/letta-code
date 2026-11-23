import { randomUUID } from "node:crypto";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalResult } from "@/agent/approval-execution";

type HeadlessInput = Array<MessageCreate | ApprovalCreate>;

export function createHeadlessResponseState() {
  let reusableInput: HeadlessInput | null = null;
  return {
    prepare(
      approvals: ApprovalResult[],
      fullyAutoHandled: boolean,
    ): HeadlessInput {
      const input: HeadlessInput = [
        { type: "approval", approvals, otid: randomUUID() },
      ];
      reusableInput = fullyAutoHandled ? input : null;
      return input;
    },
    consume(input: HeadlessInput): boolean {
      const canReuse = input === reusableInput;
      reusableInput = null;
      return canReuse;
    },
  };
}
