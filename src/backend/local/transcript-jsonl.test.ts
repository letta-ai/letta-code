import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalTranscriptJsonlCorruptionError,
  readLocalTranscriptJsonl,
  readLocalTranscriptJsonlSuffix,
  repairLocalTranscriptJsonlTail,
} from "./transcript-jsonl";

let testDir: string | undefined;

function transcriptPath(): string {
  testDir ??= mkdtempSync(join(tmpdir(), "local-transcript-jsonl-"));
  return join(testDir, "messages.jsonl");
}

afterEach(() => {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
    testDir = undefined;
  }
});

describe("local transcript JSONL", () => {
  test("keeps valid rows before an incomplete trailing row", () => {
    const path = transcriptPath();
    writeFileSync(path, '{"id":"one"}\n{"id":"two"}\n{"id":"partial"');

    expect(readLocalTranscriptJsonl<{ id: string }>(path)).toEqual([
      { id: "one" },
      { id: "two" },
    ]);
  });

  test("reports committed corruption with path, line, and byte offset", () => {
    const path = transcriptPath();
    const firstRow = '{"id":"one"}\n';
    writeFileSync(path, `${firstRow}not-json\n{"id":"three"}\n`);

    try {
      readLocalTranscriptJsonl(path);
      throw new Error("Expected transcript corruption to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalTranscriptJsonlCorruptionError);
      expect(error).toMatchObject({
        path,
        lineNumber: 2,
        byteOffset: Buffer.byteLength(firstRow),
      });
      expect(String(error)).toContain("Malformed transcript JSONL");
      expect(String(error)).toContain("line 2");
    }
  });

  test("suffix reads discard a clipped UTF-8 row and ignore a partial tail", () => {
    const path = transcriptPath();
    const firstRow = `${JSON.stringify({ id: "one", text: "before 😀 after" })}\n`;
    const secondRow = `${JSON.stringify({ id: "two" })}\n`;
    const partialTail = Buffer.from(
      '{"id":"partial","text":"\xf0\x9f',
      "binary",
    );
    const content = Buffer.concat([
      Buffer.from(firstRow),
      Buffer.from(secondRow),
      partialTail,
    ]);
    writeFileSync(path, content);

    const emojiByteOffset = content.indexOf(Buffer.from("😀"));
    const suffix = readLocalTranscriptJsonlSuffix<{ id: string }>(
      path,
      content.length - emojiByteOffset - 1,
    );

    expect(suffix).toEqual({
      items: [{ id: "two" }],
      reachedStart: false,
    });
  });

  test("repair backs up the original bytes before truncating a partial tail", () => {
    const path = transcriptPath();
    const validContent = '{"id":"one"}\n{"id":"two"}\n';
    const originalContent = `${validContent}{"id":"partial"`;
    writeFileSync(path, originalContent);

    const result = repairLocalTranscriptJsonlTail(path);

    expect(result.repaired).toBe(true);
    expect(result.backupPath).toBeString();
    expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(originalContent);
    expect(readFileSync(path, "utf8")).toBe(validContent);
    expect(readLocalTranscriptJsonl(path)).toEqual([
      { id: "one" },
      { id: "two" },
    ]);
  });

  test("repair preserves and terminates a complete final row", () => {
    const path = transcriptPath();
    writeFileSync(path, '{"id":"one"}');

    expect(readLocalTranscriptJsonl(path)).toEqual([{ id: "one" }]);
    expect(repairLocalTranscriptJsonlTail(path)).toEqual({ repaired: true });
    expect(readFileSync(path, "utf8")).toBe('{"id":"one"}\n');
  });
});
