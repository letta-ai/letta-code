import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMcpEventState } from "./mcp-event-state";

test("resumes a canonical subscription's cursor and deduplication across restarts", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-event-state-"));
  try {
    const first = openMcpEventState(
      ["agent", { project: "a", filter: true }],
      root,
    );
    first.mark("event-1");
    first.advance("opaque");
    const resumed = openMcpEventState(
      ["agent", { filter: true, project: "a" }],
      root,
    );
    expect(resumed.cursor()).toBe("opaque");
    expect(resumed.seen("event-1")).toBe(true);
    expect(
      openMcpEventState(
        ["other-agent", { filter: true, project: "a" }],
        root,
      ).cursor(),
    ).toBeNull();
    resumed.advance(null);
    expect(
      openMcpEventState(
        ["agent", { project: "a", filter: true }],
        root,
      ).cursor(),
    ).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
