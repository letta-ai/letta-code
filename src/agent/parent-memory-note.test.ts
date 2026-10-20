import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { getScopedMemoryFilesystemRoot } from "./memory-filesystem";
import { buildParentMemoryNote } from "./parent-memory-note";

test("only advertises an existing parent memory directory", () => {
  const id = `agent-parent-note-${randomUUID()}`;
  const directory = getScopedMemoryFilesystemRoot(id);
  expect(buildParentMemoryNote(id)).toBeUndefined();
  mkdirSync(directory, { recursive: true });
  try {
    const note = buildParentMemoryNote(id);
    expect(note).toContain(id);
    expect(note).toContain(`\`${directory}\``);
    expect(note).toContain("Don't edit or commit there unless asked");
    expect(note).toContain("start with `MEMORY.md` and the directory indexes");
    expect(note).not.toContain("<system-reminder>");
    rmSync(directory, { recursive: true });
    writeFileSync(directory, "not a directory");
    expect(buildParentMemoryNote(id)).toBeUndefined();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
