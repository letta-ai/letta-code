import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectMemoryViewerFiles } from "./generate-memory-viewer";
import template from "./memory-viewer-template.txt";
import type { MemoryFile } from "./types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function memoryRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "palace-memory-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/");
    if (parts.length > 1)
      mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...parts), content);
  }
  return root;
}

// Exercise the actual self-contained HTML's tree construction without requiring a browser.
function renderedTrees(files: MemoryFile[]): {
  core: string;
  external: string;
  coreLabel: string;
  externalLabel: string;
} {
  const start = template.indexOf("  // Build file tree (from path segments)");
  const end = template.indexOf("  // Collapsible directory toggling", start);
  if (start < 0 || end < 0) throw new Error("Memory tree script not found");
  const script = template.slice(start, end);
  const panels: Record<string, { innerHTML: string; textContent: string }> = {};
  const document = {
    getElementById(id: string) {
      if (!panels[id]) panels[id] = { innerHTML: "", textContent: "" };
      return panels[id];
    },
  };
  const render = new Function("DATA", "document", "escAttr", "escHtml", script);
  const identity = (text: string) => text;
  render({ files }, document, identity, identity);
  return {
    core: panels["tree-panel-core"]?.innerHTML ?? "",
    external: panels["tree-panel-external"]?.innerHTML ?? "",
    coreLabel: panels["tab-core-label"]?.textContent ?? "",
    externalLabel: panels["tab-external-label"]?.textContent ?? "",
  };
}

describe("memory palace file layout", () => {
  test("v2 puts root Markdown including MEMORY.md in core and nested Markdown in external", () => {
    const files = collectMemoryViewerFiles(
      memoryRoot({
        "MEMORY.md": "Index",
        "persona.md": "---\ndescription: identity\n---\nHello",
        "notes/MEMORY.md": "Notes index",
        "notes/topic.md": "Detail",
        "system/legacy.md": "Not core in v2",
        "notes/image.png": "not markdown",
      }),
    );
    expect(files.map((file) => [file.path, file.isSystem])).toEqual([
      ["system/legacy.md", false],
      ["notes/MEMORY.md", false],
      ["notes/topic.md", false],
      ["MEMORY.md", true],
      ["persona.md", true],
    ]);
    expect(files.find((file) => file.path === "persona.md")?.content).toBe(
      "Hello",
    );

    const tree = renderedTrees(files);
    expect(tree.coreLabel).toBe("Core Memory (2)");
    expect(tree.externalLabel).toBe("External Memory (3)");
    expect(tree.core).toContain('data-path="MEMORY.md"');
    expect(tree.core).toContain('data-path="persona.md"');
    expect(tree.core).not.toContain('data-dir="system"');
    expect(tree.external).toContain('data-dir="notes"');
    expect(tree.external).toContain('data-path="notes/MEMORY.md"');
    expect(tree.external).toContain('data-dir="system"');
    expect(tree.external).toContain('data-path="system/legacy.md"');
  });

  test("v1 retains system/ core layout and strips its tree prefix", () => {
    const files = collectMemoryViewerFiles(
      memoryRoot({
        "system/persona.md": "Core",
        "system/deep/soul.md": "Core nested",
        "notes.md": "External in v1",
        "notes/topic.md": "Also external",
      }),
    );
    expect(files.map((file) => [file.path, file.isSystem])).toEqual([
      ["system/deep/soul.md", true],
      ["system/persona.md", true],
      ["notes/topic.md", false],
      ["notes.md", false],
    ]);

    const tree = renderedTrees(files);
    expect(tree.coreLabel).toBe("Core Memory (2)");
    expect(tree.externalLabel).toBe("External Memory (2)");
    expect(tree.core).toContain('data-dir="deep"');
    expect(tree.core).toContain('data-path="system/deep/soul.md"');
    expect(tree.core).not.toContain('data-dir="system"');
    expect(tree.external).toContain('data-path="notes.md"');
    expect(tree.external).not.toContain('data-path="system/persona.md"');
  });
});
