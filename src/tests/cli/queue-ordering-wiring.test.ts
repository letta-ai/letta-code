import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readAppSource(): string {
  const appPath = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
  return readFileSync(appPath, "utf-8");
}

describe("queue ordering wiring", () => {
  test("dequeue effect keeps all sensitive safety gates", () => {
    const source = readAppSource();
    const start = source.indexOf(
      "// Process queued messages when streaming ends.",
    );
    const end = source.indexOf(
      "// Helper to send all approval results when done",
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("pendingApprovals.length === 0");
    expect(segment).toContain("!commandRunning");
    expect(segment).toContain("!isExecutingTool");
    expect(segment).toContain("!anySelectorOpen");
    expect(segment).toContain("!queuedOverlayAction");
    expect(segment).toContain("!waitingForQueueCancelRef.current");
    expect(segment).toContain("!userCancelledRef.current");
    expect(segment).toContain("!abortControllerRef.current");
    expect(segment).toContain("queuedOverlayAction=");
    // Queue is now drained via QueueRuntime.consumeItems; setQueueDisplay is
    // updated automatically via the onDequeued callback — no direct setState here.
    expect(segment).toContain("tuiQueueRef.current?.consumeItems(queueLen)");
    expect(segment).toContain("onSubmitRef.current(concatenatedMessage);");
    expect(segment).toContain("queuedOverlayAction,");
  });

  test("queue display trim uses displayable-item count, not mergedCount", () => {
    const source = readAppSource();
    const start = source.indexOf("onDequeued: (batch) => {");
    const end = source.indexOf("onBlocked: (reason, queueLen) =>");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("const displayConsumedCount =");
    expect(segment).toContain('item.kind === "message"');
    expect(segment).toContain('item.kind === "task_notification"');
    expect(segment).toContain("prev.slice(displayConsumedCount)");
  });

  test("onSubmit allows override-only queued submissions", () => {
    const source = readAppSource();
    const start = source.indexOf("const onSubmit = useCallback(");
    const end = source.indexOf(
      "// Process queued overlay actions when streaming ends",
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain(
      "if (!msg && !hasOverrideContent) return { submitted: false };",
    );
    expect(segment).toContain(
      "if (profileConfirmPending && !msg && !hasOverrideContent)",
    );
  });

  test("queued overlay effect only runs when idle and clears action before processing", () => {
    const source = readAppSource();
    const start = source.indexOf(
      "// Process queued overlay actions when streaming ends",
    );
    const end = source.indexOf(
      "// Handle escape when profile confirmation is pending",
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start, end);
    expect(segment).toContain("!streaming");
    expect(segment).toContain("!commandRunning");
    expect(segment).toContain("!isExecutingTool");
    expect(segment).toContain("pendingApprovals.length === 0");
    expect(segment).toContain("queuedOverlayAction !== null");
    expect(segment).toContain("setQueuedOverlayAction(null)");
    expect(segment).toContain('action.type === "switch_model"');
    expect(segment).toContain("handleModelSelect(action.modelId");
    expect(segment).toContain('action.type === "switch_toolset"');
    expect(segment).toContain("handleToolsetSelect(action.toolsetId");
  });

  test("busy model/toolset handlers enqueue overlay actions", () => {
    const source = readAppSource();

    const modelAnchor = source.indexOf(
      "Model switch queued – will switch after current task completes",
    );
    expect(modelAnchor).toBeGreaterThan(-1);
    const modelWindow = source.slice(
      Math.max(0, modelAnchor - 700),
      modelAnchor + 700,
    );
    expect(modelWindow).toContain("if (isAgentBusy())");
    expect(modelWindow).toContain("setQueuedOverlayAction({");
    expect(modelWindow).toContain('type: "switch_model"');

    const toolsetAnchor = source.indexOf(
      "Toolset switch queued – will switch after current task completes",
    );
    expect(toolsetAnchor).toBeGreaterThan(-1);
    const toolsetWindow = source.slice(
      Math.max(0, toolsetAnchor - 700),
      toolsetAnchor + 700,
    );
    expect(toolsetWindow).toContain("if (isAgentBusy())");
    expect(toolsetWindow).toContain("setQueuedOverlayAction({");
    expect(toolsetWindow).toContain('type: "switch_toolset"');
  });
});
