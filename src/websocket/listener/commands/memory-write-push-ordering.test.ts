import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Push-before-notify contract for GUI-initiated memory writes (LET-9481).
 *
 * Server-of-record reads (e.g. cloud-api's agent profile picture endpoint)
 * are served from the remote memfs (Pierre), so `memory_updated` and the
 * `write_memory_file_response` / `delete_memory_file_response` frames must
 * not be emitted until the push has completed. Otherwise the UI invalidates
 * its query caches, refetches stale bytes from the remote, and drops its
 * optimistic state (the "profile picture doesn't refresh" bug).
 *
 * Source-level pins are used because the handler wires the sync via dynamic
 * imports and `mock.module` in other suites is process-global under Bun
 * (matching the `acting-user-attribution.test.ts` convention).
 */

const handlerSource = readFileSync(
  fileURLToPath(new URL("./memory.ts", import.meta.url)),
  "utf-8",
);

function handlerBlock(startMarker: string, endMarker: string | null): string {
  const start = handlerSource.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  if (endMarker === null) return handlerSource.slice(start);
  const end = handlerSource.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return handlerSource.slice(start, end);
}

describe("listener memory write push ordering (contract)", () => {
  const writeBlock = handlerBlock(
    "isWriteMemoryFileCommand(parsed)",
    "isDeleteMemoryFileCommand(parsed)",
  );
  const deleteBlock = handlerBlock("isDeleteMemoryFileCommand(parsed)", null);

  for (const [name, block] of [
    ["write_memory_file", writeBlock],
    ["delete_memory_file", deleteBlock],
  ] as const) {
    test(`${name} awaits the remote push before emitting memory_updated`, () => {
      const pushIdx = block.indexOf("await syncPendingMemoryCommitsAfterTurn(");
      const memoryUpdatedIdx = block.indexOf('type: "memory_updated"');
      // The success-path response emission is the last occurrence — the
      // first occurrence is the `sendFailure` helper at the top of each
      // handler.
      const responseIdx = block.lastIndexOf(`type: "${name}_response"`);

      expect(pushIdx).toBeGreaterThan(-1);
      expect(memoryUpdatedIdx).toBeGreaterThan(pushIdx);
      expect(responseIdx).toBeGreaterThan(pushIdx);
    });

    test(`${name} does not fire-and-forget the push`, () => {
      expect(block).not.toMatch(
        /syncPendingMemoryCommitsAfterTurn\([\s\S]{0,120}?\)\.catch\(/,
      );
    });
  }
});
