import { describe, expect, test } from "bun:test";
import { validateMemoryTreeConstraints } from "@/memory-constraints";
import rootGuidance from "@/skills/builtin/initializing-memory/SKILL.md";

/** Fenced blocks in the skill, in document order. */
function fencedBlocks(guidance: string): string[] {
  return [...guidance.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? "",
  );
}

/**
 * Read an ASCII directory listing the way a reader does: indentation and
 * branch glyphs give depth, a trailing `/` marks a directory, and `#` starts a
 * comment. Returns the memory file paths the drawing depicts.
 */
function filesInTree(block: string): string[] {
  const directories: string[] = [];
  const files: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "").trimEnd();
    if (!line) continue;
    const match = line.match(/^((?:[│ ] {3})*)(?:[├└]── )?(.+)$/);
    if (!match) throw new Error(`unparsed tree line: ${rawLine}`);
    const [, indent = "", entry = ""] = match;
    const depth = indent.length / 4 + (line.includes("── ") ? 1 : 0);
    if (entry.endsWith("/")) {
      directories[depth] = entry.slice(0, -1);
      continue;
    }
    files.push([...directories.slice(0, depth), entry].join("/"));
  }
  return files;
}

/** Tree reader over paths alone; character limits need no content here. */
function readerFor(paths: string[]) {
  return {
    listFiles: async () => paths.map((path) => ({ path, mode: "100644" })),
    readFile: async () => new Uint8Array(),
  };
}

describe("initializing-memory example trees", () => {
  const section = rootGuidance.slice(
    rootGuidance.indexOf("### Example Structures"),
    rootGuidance.indexOf("## Initialization Flow"),
  );
  const trees = fencedBlocks(section);

  test("minimal memory is a single root MEMORY.md", () => {
    expect(filesInTree(trees[0] ?? "")).toEqual(["MEMORY.md"]);
  });

  test("every example tree satisfies MemFS v2 tree constraints", async () => {
    expect(trees.length).toBe(2);
    for (const tree of trees) {
      const paths = filesInTree(tree);
      const errors = await validateMemoryTreeConstraints(readerFor(paths), {
        config: { version: 1 },
        layout: "root-marker",
        requireRootMarker: true,
      });
      expect(errors).toEqual([]);
    }
  });

  test("the constraint check has teeth: a missing ancestor index is an error", async () => {
    const errors = await validateMemoryTreeConstraints(
      readerFor([
        "MEMORY.md",
        "letta-code/MEMORY.md",
        "letta-code/history/corrections.md",
      ]),
      {
        config: { version: 1 },
        layout: "root-marker",
        requireRootMarker: true,
      },
    );
    expect(errors).toEqual([
      "letta-code/history/corrections.md: missing required index letta-code/history/MEMORY.md",
    ]);
  });

  test("the expanded example contains the required nested index", () => {
    const paths = filesInTree(trees[1] ?? "");
    expect(paths).toContain("orchard/history/MEMORY.md");
    expect(paths).toContain("orchard/history/corrections.md");
  });
});
