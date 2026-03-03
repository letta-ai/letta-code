import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("auto-init wiring", () => {
  const readSource = (relativePath: string) =>
    readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf-8",
    );

  test("fireAutoInit is exported from initCommand.ts", () => {
    const helperSource = readSource("../../cli/helpers/initCommand.ts");
    expect(helperSource).toContain("export async function fireAutoInit(");
  });

  test("App.tsx uses a Set to track multiple pending agent IDs", () => {
    const appSource = readSource("../../cli/App.tsx");
    expect(appSource).toContain("autoInitPendingAgentIdsRef");
    expect(appSource).toContain("new Set()");
  });

  test("App.tsx uses agentProvenance?.isNew for startup path", () => {
    const appSource = readSource("../../cli/App.tsx");
    expect(appSource).toContain("agentProvenance?.isNew");
  });

  test("App.tsx checks .has(agentId) as agent ID match guard in onSubmit", () => {
    const appSource = readSource("../../cli/App.tsx");
    expect(appSource).toContain(
      "autoInitPendingAgentIdsRef.current.has(agentId)",
    );
  });

  test("auto-init is registered in catalog and engine", () => {
    const catalogSource = readSource("../../reminders/catalog.ts");
    const engineSource = readSource("../../reminders/engine.ts");

    expect(catalogSource).toContain('"auto-init"');
    expect(engineSource).toContain('"auto-init"');
    expect(engineSource).toContain("buildAutoInitReminder");
  });

  test("pendingAutoInitReminder is in state interface and factory", () => {
    const stateSource = readSource("../../reminders/state.ts");

    expect(stateSource).toContain("pendingAutoInitReminder: boolean");
    expect(stateSource).toContain("pendingAutoInitReminder: false");
  });
});

describe("auto-init lifecycle guards", () => {
  const readSource = (relativePath: string) =>
    readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf-8",
    );

  test("startup effect uses a consumed ref to fire at most once", () => {
    const appSource = readSource("../../cli/App.tsx");

    // The consumed ref must exist
    expect(appSource).toContain("startupAutoInitConsumedRef");

    // The guard check must appear before the assignment in the source.
    // This ensures the effect tests the consumed ref before marking it consumed.
    const guardIdx = appSource.indexOf("!startupAutoInitConsumedRef.current");
    const assignIdx = appSource.indexOf(
      "startupAutoInitConsumedRef.current = true",
    );
    expect(guardIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(assignIdx);
  });

  test("onSubmit only removes from pending set after confirmed launch (fired === true)", () => {
    const appSource = readSource("../../cli/App.tsx");

    // Find the auto-init block in onSubmit — starts with the .has() check
    const blockStart = appSource.indexOf(
      "autoInitPendingAgentIdsRef.current.has(agentId)",
    );
    expect(blockStart).toBeGreaterThan(-1);

    // Extract enough of the block to cover the clearing logic
    const block = appSource.slice(blockStart, blockStart + 600);

    // The delete must happen AFTER checking `fired`, not before fireAutoInit
    const firedCheck = block.indexOf("if (fired)");
    const setDelete = block.indexOf(
      "autoInitPendingAgentIdsRef.current.delete(agentId)",
    );
    expect(firedCheck).toBeGreaterThan(-1);
    expect(setDelete).toBeGreaterThan(-1);
    expect(setDelete).toBeGreaterThan(firedCheck);
  });

  test("manual /init clears pending auto-init for current agent", () => {
    const appSource = readSource("../../cli/App.tsx");

    // The /init handler must delete the current agent from the pending set
    const initHandlerIdx = appSource.indexOf('trimmed === "/init"');
    expect(initHandlerIdx).toBeGreaterThan(-1);

    const afterInit = appSource.slice(initHandlerIdx, initHandlerIdx + 400);
    expect(afterInit).toContain(
      "autoInitPendingAgentIdsRef.current.delete(agentId)",
    );
  });

  test("fireAutoInit returns false (not throw) when init subagent is active", () => {
    const helperSource = readSource("../../cli/helpers/initCommand.ts");

    // The guard must return false, not throw
    const fnBody = helperSource.slice(
      helperSource.indexOf("async function fireAutoInit("),
    );
    const guardIdx = fnBody.indexOf("hasActiveInitSubagent()");
    expect(guardIdx).toBeGreaterThan(-1);

    // The return false must follow the guard, confirming it's a soft skip
    const returnFalseIdx = fnBody.indexOf("return false", guardIdx);
    expect(returnFalseIdx).toBeGreaterThan(-1);
    // Should be on the same or next line (within a small window)
    expect(returnFalseIdx - guardIdx).toBeLessThan(40);
  });
});
