import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    test(`${name} awaits the bounded push before emitting memory_updated`, () => {
      const pushIdx = block.indexOf("await awaitMemoryPushBounded(");
      const memoryUpdatedIdx = block.indexOf('type: "memory_updated"');
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

  test("bounded helper races the push against the cap", () => {
    const helperBlock = handlerBlock(
      "async function awaitMemoryPushBounded(",
      "export async function handleListMemoryCommand(",
    );
    expect(helperBlock).toContain("await Promise.race([syncPromise,");
  });

  test("push-await cap stays below the desktop UI's 10s device-command timeout", () => {
    const match = handlerSource.match(
      /const MEMORY_PUSH_AWAIT_CAP_MS = ([\d_]+);/,
    );
    expect(match).not.toBeNull();
    const capMs = Number(match?.[1]?.replaceAll("_", ""));
    expect(capMs).toBeGreaterThan(0);
    expect(capMs).toBeLessThan(10_000);
  });
});
