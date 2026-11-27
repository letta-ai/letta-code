import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMcpEventState } from "./mcp-event-state";

const subscription = {
  agentId: "agent",
  config: {
    name: "test-server",
    transport: "stdio" as const,
    command: "test-server",
  },
  event: "test.event",
  args: { project: "a", filter: true },
};

test("resumes a canonical subscription's cursor and deduplication across restarts", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-event-state-"));
  try {
    const first = openMcpEventState(subscription, root);
    first.mark("event-1");
    first.advance("opaque");
    const resumed = openMcpEventState(
      { ...subscription, args: { filter: true, project: "a" } },
      root,
    );
    expect(resumed.cursor()).toBe("opaque");
    expect(resumed.seen("event-1")).toBe(true);
    expect(
      openMcpEventState(
        { ...subscription, agentId: "other-agent" },
        root,
      ).cursor(),
    ).toBeNull();
    resumed.advance(null);
    expect(openMcpEventState(subscription, root).cursor()).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolates seen events and cursors by conversation for the same agent", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-event-state-"));
  try {
    const firstIdentity = { ...subscription, conversationId: "conversation-1" };
    const secondIdentity = {
      ...subscription,
      conversationId: "conversation-2",
    };
    const first = openMcpEventState(firstIdentity, root);
    first.mark("shared-event");
    first.advance("cursor-1");

    const second = openMcpEventState(secondIdentity, root);
    expect(second.seen("shared-event")).toBe(false);
    expect(second.cursor()).toBeNull();
    second.mark("shared-event");
    second.mark("second-only");
    second.advance("cursor-2");

    const resumedFirst = openMcpEventState(firstIdentity, root);
    expect(resumedFirst.cursor()).toBe("cursor-1");
    expect(resumedFirst.seen("shared-event")).toBe(true);
    expect(resumedFirst.seen("second-only")).toBe(false);
    const resumedSecond = openMcpEventState(secondIdentity, root);
    expect(resumedSecond.cursor()).toBe("cursor-2");
    expect(resumedSecond.seen("shared-event")).toBe(true);
    expect(resumedSecond.seen("second-only")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
