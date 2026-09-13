import type { ModConversationMessage, ModTurnStartEvent } from "@/mods/types";

export function isTurnStartInput(
  value: unknown,
): value is ModTurnStartEvent["input"] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

export function cloneTurnStartInput(
  input: ModTurnStartEvent["input"],
): ModTurnStartEvent["input"] {
  return input.map((item) => structuredClone(item));
}

function isApprovalInput(item: ModConversationMessage): boolean {
  return item.type === "approval";
}

export function preserveApprovalFirstOrdering(
  wasApprovalContinuation: boolean,
  transformedInput: ModConversationMessage[],
): ModConversationMessage[] {
  if (!wasApprovalContinuation) return transformedInput;

  let sawNonApproval = false;
  let needsReorder = false;
  for (const item of transformedInput) {
    if (isApprovalInput(item)) {
      if (sawNonApproval) {
        needsReorder = true;
        break;
      }
    } else {
      sawNonApproval = true;
    }
  }
  if (!needsReorder) return transformedInput;

  const approvals: ModConversationMessage[] = [];
  const remaining: ModConversationMessage[] = [];
  for (const item of transformedInput) {
    (isApprovalInput(item) ? approvals : remaining).push(item);
  }
  return [...approvals, ...remaining];
}
