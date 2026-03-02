import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("auto-init onboarding wiring", () => {
  const readSource = (relativePath: string) =>
    readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf-8",
    );

  test("fireAutoInit is exported from initCommand.ts", () => {
    const helperSource = readSource("../../cli/helpers/initCommand.ts");
    expect(helperSource).toContain("export async function fireAutoInit(");
  });

  test("App.tsx contains autoInitPendingAgentIdRef", () => {
    const appSource = readSource("../../cli/App.tsx");
    expect(appSource).toContain("autoInitPendingAgentIdRef");
  });

  test("App.tsx contains pendingAutoInitReminder", () => {
    const appSource = readSource("../../cli/App.tsx");
    expect(appSource).toContain("pendingAutoInitReminder");
  });

  test("App.tsx imports and uses fireAutoInit", () => {
    const appSource = readSource("../../cli/App.tsx");
    expect(appSource).toContain("fireAutoInit");
  });

  test("App.tsx checks pendingInitAgentId === agentId (agent ID match guard)", () => {
    const appSource = readSource("../../cli/App.tsx");
    expect(appSource).toContain("pendingInitAgentId === agentId");
  });

  test("auto-init-onboarding is in catalog", () => {
    const catalogSource = readSource("../../reminders/catalog.ts");
    expect(catalogSource).toContain('"auto-init-onboarding"');
  });

  test("auto-init-onboarding is in engine", () => {
    const engineSource = readSource("../../reminders/engine.ts");
    expect(engineSource).toContain('"auto-init-onboarding"');
    expect(engineSource).toContain("buildAutoInitOnboardingReminder");
  });

  test("pendingAutoInitReminder is in state", () => {
    const stateSource = readSource("../../reminders/state.ts");
    expect(stateSource).toContain("pendingAutoInitReminder");
  });
});
