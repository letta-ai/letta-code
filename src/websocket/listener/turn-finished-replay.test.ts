import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnFinishedStore } from "./turn-finished-replay";

describe("turn-finished-replay read path", () => {
  test("read does not acquire a durable lock when the record is absent or has no expired entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-finished-read-"));
    try {
      const store = createTurnFinishedStore(dir);
      expect(store.read("agent-1", "conv-1")).toBeNull();
      expect(readdirSync(dir)).toEqual([]);

      store.put("agent-1", "conv-1", {
        type: "turn_finished",
        turn_id: "turn-1",
        status: "completed",
      } as never);

      // Remove any lock artifacts created by the write, then verify read does not create a lock.
      for (const entry of readdirSync(dir)) {
        if (entry.includes(".lock")) {
          rmSync(join(dir, entry), { recursive: true, force: true });
        }
      }

      const loaded = store.read("agent-1", "conv-1");
      expect(loaded).not.toBeNull();
      expect(readdirSync(dir).some((entry) => entry.includes(".lock"))).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
