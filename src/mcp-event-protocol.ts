import { z } from "zod";

const jsonObject = z.record(z.string(), z.unknown());
export const eventCursor = z
  .string()
  .nullish()
  .transform((value) => value ?? null);
export const eventList = z.object({
  events: z.array(
    z
      .object({
        name: z.string(),
        description: z.string().optional(),
        delivery: z.array(z.enum(["poll", "push", "webhook"])).min(1),
        inputSchema: jsonObject,
        payloadSchema: jsonObject,
      })
      .passthrough(),
  ),
  nextCursor: z.string().optional(),
});
export const occurrence = z.object({
  eventId: z.string(),
  name: z.string(),
  timestamp: z.iso.datetime({ offset: true }),
  data: jsonObject,
  cursor: eventCursor,
});
export const eventError = z.object({
  code: z.number().int(),
  message: z.string(),
});
export const pollResult = z.object({
  events: z.array(occurrence),
  cursor: eventCursor,
  truncated: z.boolean(),
  hasMore: z.boolean(),
  nextPollMs: z.number().nonnegative(),
});
export const emptyResult = z.object({});

export type EventOccurrence = z.infer<typeof occurrence>;
export type McpEventNotice =
  | { type: "event"; server: string; event: EventOccurrence }
  | { type: "gap"; server: string; name: string }
  | {
      type: "error" | "terminated";
      server: string;
      name: string;
      error: z.infer<typeof eventError>;
    };

export function recentEventIds(limit = 1_000) {
  const recent = new Set<string>();
  return {
    has: (id: string) => recent.has(id),
    add(id: string) {
      recent.add(id);
      if (recent.size <= limit) return;
      const oldest = recent.values().next().value;
      if (oldest !== undefined) recent.delete(oldest);
    },
  };
}
