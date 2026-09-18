import { randomUUID } from "node:crypto";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalResult } from "@/agent/approval-execution";

type HeadlessInput = Array<MessageCreate | ApprovalCreate>;

/** Eligibility belongs to one freshly executed batch, not to the whole turn. */
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
      // Replaced/recovered input cannot inherit eligibility. Consume before
      // sending so even a rejected request cannot reuse it on a retry.
      const canReuse = input === reusableInput;
      reusableInput = null;
      return canReuse;
    },
  };
}
