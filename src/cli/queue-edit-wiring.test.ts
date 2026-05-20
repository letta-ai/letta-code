import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("queue edit wiring", () => {
  test("QueuedMessage type includes queueItemId", () => {
    const path = fileURLToPath(
      new URL("../utils/messageQueueBridge.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("queueItemId?: string");
  });

  test("toQueuedMsg propagates queueItemId", () => {
    const path = fileURLToPath(
      new URL("../cli/helpers/queuedMessageParts.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("queueItemId: item.id");
  });

  test("QueuedMessages shows no focus UI or hint text", () => {
    const path = fileURLToPath(
      new URL("../cli/components/QueuedMessages.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).not.toContain("focusIndex");
    expect(source).not.toContain("isFocused");
    // Hint text is now in the InputFooter, not QueuedMessages
    expect(source).not.toContain("press ↑ to edit");
  });

  test("InputFooter shows queue hint when hasQueuedMessages", () => {
    const path = fileURLToPath(
      new URL("../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("hasQueuedMessages");
    expect(source).toContain("press ↑ to edit queued message");
  });

  test("InputRich has onQueueEdit prop for up-arrow edit", () => {
    const path = fileURLToPath(
      new URL("../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("onQueueEdit");
    expect(source).not.toContain("onQueueFocusChange");
    expect(source).not.toContain("onQueueRemove");
    expect(source).not.toContain("onQueueEscape");
  });

  test("QueueRuntime has removeItem method", () => {
    const path = fileURLToPath(
      new URL("../queue/queueRuntime.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("removeItem(id: string)");
    expect(source).toContain("onRemoved");
  });
});
