import { randomUUID } from "node:crypto";
import type { Buffers } from "@/cli/helpers/accumulator";

// tiny helper for unique ids (avoid overwriting prior user lines)
export function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// OTIDs are client-generated correlation ids, not canonical backend message ids.
// We use them to stitch together an optimistic local transcript row, the outbound
// request payload, and the echoed user_message chunk that later arrives from the
// server with the real message.id.
export function createClientOtid(): string {
  return randomUUID();
}

export function appendOptimisticUserLine(
  buffers: Buffers,
  text: string,
  otid: string,
): string | null {
  if (!text) {
    return null;
  }

  const userId = uid("user");
  buffers.byId.set(userId, {
    kind: "user",
    id: userId,
    text,
    otid,
  });
  buffers.userLineIdByOtid.set(otid, userId);
  buffers.order.push(userId);
  return userId;
}
