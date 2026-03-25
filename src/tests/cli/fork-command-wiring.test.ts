import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("/fork command wiring", () => {
  test("guards against forking the default conversation", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    // Find the /fork handler
    const forkHandlerIndex = source.indexOf('if (msg.trim() === "/fork")');
    expect(forkHandlerIndex).toBeGreaterThanOrEqual(0);

    // Check the guard is right after the handler starts
    const windowEnd = Math.min(source.length, forkHandlerIndex + 1500);
    const scoped = source.slice(forkHandlerIndex, windowEnd);

    // Must check for default conversation
    expect(scoped).toContain('conversationIdRef.current === "default"');

    // Must fail with appropriate message
    expect(scoped).toContain(
      "Cannot fork the default conversation — use /new instead",
    );
  });

  test("calls client.post for fork endpoint", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const forkHandlerIndex = source.indexOf('if (msg.trim() === "/fork")');
    expect(forkHandlerIndex).toBeGreaterThanOrEqual(0);

    const windowEnd = Math.min(source.length, forkHandlerIndex + 3000);
    const scoped = source.slice(forkHandlerIndex, windowEnd);

    // Must call POST to fork endpoint
    expect(scoped).toContain("client.post<");
    expect(scoped).toContain("/fork");
  });

  test("sets origin to fork for conversation switch context", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    const forkHandlerIndex = source.indexOf('if (msg.trim() === "/fork")');
    expect(forkHandlerIndex).toBeGreaterThanOrEqual(0);

    const windowEnd = Math.min(source.length, forkHandlerIndex + 3000);
    const scoped = source.slice(forkHandlerIndex, windowEnd);

    expect(scoped).toContain('origin: "fork"');
  });

  test("fork origin is defined in ConversationSwitchContext type", () => {
    const alertPath = fileURLToPath(
      new URL(
        "../../cli/helpers/conversationSwitchAlert.ts",
        import.meta.url,
      ),
    );
    const source = readFileSync(alertPath, "utf-8");

    // The origin union type should include "fork"
    expect(source).toContain('"fork"');
  });
});
