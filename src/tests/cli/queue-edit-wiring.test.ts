import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("queue edit wiring", () => {
  test("QueuedMessage type includes queueItemId", () => {
    const path = fileURLToPath(
      new URL("../../cli/helpers/messageQueueBridge.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("queueItemId?: string");
  });

  test("toQueuedMsg propagates queueItemId", () => {
    const path = fileURLToPath(
      new URL("../../cli/helpers/queuedMessageParts.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("queueItemId: item.id");
  });

  test("QueuedMessages accepts focusIndex prop", () => {
    const path = fileURLToPath(
      new URL("../../cli/components/QueuedMessages.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("focusIndex");
    expect(source).toContain("isFocused");
  });

  test("InputRich has queue focus props", () => {
    const path = fileURLToPath(
      new URL("../../cli/components/InputRich.tsx", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("queueFocusIndex");
    expect(source).toContain("onQueueFocusChange");
    expect(source).toContain("onQueueEdit");
    expect(source).toContain("onQueueRemove");
    expect(source).toContain("onQueueEscape");
  });

  test("QueueRuntime has removeItem method", () => {
    const path = fileURLToPath(
      new URL("../../queue/queueRuntime.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("removeItem(id: string)");
    expect(source).toContain("onRemoved");
  });

  test("CLI_GLYPHS has focus glyph", () => {
    const path = fileURLToPath(
      new URL("../../cli/helpers/glyphs.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("focus:");
  });
});
