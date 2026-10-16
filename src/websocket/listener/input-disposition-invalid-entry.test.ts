import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createAcceptedInputDispositionLedger,
  dispositionKey,
  loadDurableQueuedInputs,
  reserveInputDisposition,
} from "./input-disposition";
import { createRuntime } from "./lifecycle";
import type { AcceptedInputDispositionEntry, InputIdentity } from "./types";

test("invalid entries are isolated without allowing started inputs to execute again", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-invalid-disposition-"));
  const path = join(root, "state.json");
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const listener = createRuntime();
    const ledger = createAcceptedInputDispositionLedger({
      persistentPath: path,
    });
    listener.acceptedInputDispositionLedger = ledger;
    const runtime = getOrCreateScopedRuntime(listener, "agent", "conversation");
    const identity = (id: string): InputIdentity => ({ domain: "input", id });
    const key = (id: string) => dispositionKey(runtime.key, identity(id));
    const entries = Object.fromEntries(
      ["valid", "completed", "bad-started", "bad-queued"].map<
        [string, AcceptedInputDispositionEntry]
      >((id) => [
        key(id),
        {
          runtimeKey: runtime.key,
          generation: 1,
          acceptedAt: now,
          expiresAt: now + 1000,
          disposition:
            id === "bad-started" || id === "completed" ? "started" : "queued",
          ...(id === "completed"
            ? { replayCompleted: true }
            : {
                queuedInput: {
                  scope: { agentId: "agent", conversationId: "conversation" },
                  identity: identity(id.startsWith("bad-") ? "wrong-id" : id),
                  incoming: {
                    type: "message",
                    agentId: "agent",
                    conversationId: "conversation",
                    messages: [],
                  },
                },
              }),
        },
      ]),
    );
    writeFileSync(
      path,
      JSON.stringify({
        version: 4,
        nextGeneration: 1,
        entries,
        reservations: {},
      }),
    );
    expect(
      loadDurableQueuedInputs(listener).map((input) => input.identity),
    ).toEqual([identity("valid")]);
    expect(ledger.entries.get(key("valid"))).toEqual(entries[key("valid")]);
    expect(ledger.entries.get(key("completed"))).toEqual(
      entries[key("completed")],
    );
    expect(ledger.entries.get(key("bad-started"))).toEqual({
      disposition: "started",
      replayCompleted: true,
      runtimeKey: runtime.key,
      generation: 0,
      acceptedAt: 0,
      expiresAt: now + 1000,
    });
    expect(ledger.entries.has(key("bad-queued"))).toBe(false);
    expect(warning).toHaveBeenCalledTimes(2);
    for (const id of ["bad-started", "bad-queued"]) {
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(
          `${key(id)}: Disposition replay payload identity is invalid`,
        ),
      );
    }
    expect(reserveInputDisposition(runtime, identity("bad-started"))).toEqual({
      kind: "duplicate",
      disposition: "started",
    });
    expect(reserveInputDisposition(runtime, identity("bad-queued")).kind).toBe(
      "reserved",
    );
    clock.mockReturnValue(now + 1001);
    expect(reserveInputDisposition(runtime, identity("bad-started")).kind).toBe(
      "reserved",
    );
    for (const corrupt of ["{", '{"version":4}']) {
      writeFileSync(path, corrupt);
      expect(() => loadDurableQueuedInputs(listener)).toThrow();
    }
  } finally {
    warning.mockRestore();
    clock.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
