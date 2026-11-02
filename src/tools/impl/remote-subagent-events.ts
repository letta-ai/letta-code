import type { SubagentSnapshot } from "@/types/protocol_v2";
import type { ReadSubagentEventsResponse } from "@/types/subagent-protocol";
import {
  recordMissedRemoteEvents,
  recordRemoteTaskEvent,
  recordTaskProgressRemoteText,
  recordTaskProgressToolCall,
} from "./task-transcript";

type EventPage = Extract<ReadSubagentEventsResponse, { success: true }>;

/**
 * Copy a remote worker's progress into this task's logs. A computer that
 * keeps events announces the latest as `event_seq`; each is read once, in
 * full. From an older computer, or after repeated read failures, the
 * snapshot's own short tool-call and text lists are used instead.
 */
export function followRemoteSubagentEvents(
  subagentId: string,
  read: (afterSeq: number) => Promise<EventPage>,
) {
  let cursor = 0;
  let requested = 0;
  let failures = 0;
  let draining = Promise.resolve();

  const pull = (target: number) => {
    requested = target;
    draining = draining.then(async () => {
      try {
        while (cursor < requested) {
          const page = await read(cursor);
          recordMissedRemoteEvents(subagentId, page.missed);
          for (const event of page.events)
            recordRemoteTaskEvent(subagentId, event);
          if (page.next_seq <= cursor) break;
          cursor = page.next_seq;
        }
        failures = 0;
      } catch {
        failures++;
        requested = cursor;
      }
    });
  };

  const recordSnapshot = (snapshot: SubagentSnapshot) => {
    if (typeof snapshot.event_seq === "number" && failures < 2) {
      if (snapshot.event_seq > requested) pull(snapshot.event_seq);
      return;
    }
    // Snapshots carry full lists; the task log appends each ID once.
    for (const call of snapshot.tool_calls ?? [])
      recordTaskProgressToolCall(subagentId, call);
    for (const entry of snapshot.progress_texts ?? []) {
      if (typeof entry?.id === "string" && typeof entry.text === "string")
        recordTaskProgressRemoteText(subagentId, {
          id: entry.id,
          at: typeof entry.at === "string" ? entry.at : "",
          text: entry.text,
        });
    }
  };

  return {
    recordSnapshot,
    /** Read the final snapshot's events; keep its lists if reads failed. */
    async finish(final: SubagentSnapshot): Promise<void> {
      recordSnapshot(final);
      await draining;
      if (failures > 0 && cursor < (final.event_seq ?? 0)) {
        failures = 2;
        recordSnapshot(final);
      }
    },
  };
}
