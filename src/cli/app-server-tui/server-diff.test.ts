import { expect, test } from "bun:test";
import { buildMemorySource } from "./memory-source";
import { fileEditHeader, serverDiffFromPreviews } from "./server-diff";

test("server diff previews become renderable hunks without reading the file", () => {
  const created = serverDiffFromPreviews([
    { mode: "fallback", fileName: "a.md", reason: "binary" },
    {
      mode: "advanced",
      fileName: "notes.md",
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          lines: [
            { type: "add", content: "# Notes" },
            { type: "add", content: "" },
          ],
        },
      ],
    },
  ]);
  expect(created?.diff.hunks[0]?.lines).toEqual([
    { raw: "+# Notes" },
    { raw: "+" },
  ]);
  expect(fileEditHeader("Write", { file_path: "notes.md" }, created)).toBe(
    "Write to notes.md?",
  );

  const overwrite = serverDiffFromPreviews([
    {
      mode: "advanced",
      fileName: "notes.md",
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { type: "remove", content: "old" },
            { type: "add", content: "new" },
          ],
        },
      ],
    },
  ]);
  expect(fileEditHeader("Write", { file_path: "notes.md" }, overwrite)).toBe(
    "Overwrite notes.md?",
  );
  expect(fileEditHeader("Edit", { file_path: "notes.md" }, overwrite)).toBe(
    "Update notes.md?",
  );
  expect(serverDiffFromPreviews([{ mode: "unpreviewable" }, null])).toBeNull();
});

test("memory entries from the runtime build an ordered tree keyed by path", () => {
  const source = buildMemorySource([
    { relative_path: "system/persona.md", content: "persona" },
    { relative_path: "notes.md", content: "notes" },
    { relative_path: "system/project/todo.md", content: "todo" },
  ]);
  expect(
    source.nodes.map((node) => [node.relativePath, node.depth, node.isLast]),
  ).toEqual([
    ["system", 0, false],
    ["system/project", 1, false],
    ["system/project/todo.md", 2, true],
    ["system/persona.md", 1, true],
    ["notes.md", 0, true],
  ]);
  expect(source.contents["system/project/todo.md"]).toBe("todo");
});
