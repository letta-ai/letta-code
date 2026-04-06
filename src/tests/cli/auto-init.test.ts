import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("new agent init behavior", () => {
  const readSource = (relativePath: string) =>
    readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf-8",
    );

  test("App.tsx no longer queues or launches auto-init for new agents", () => {
    const appSource = readSource("../../cli/App.tsx");

    expect(appSource).not.toContain("autoInitPendingAgentIdsRef");
    expect(appSource).not.toContain("startupAutoInitConsumedRef");
    expect(appSource).not.toContain("fireAutoInit(");
    expect(appSource).not.toContain("pendingAutoInitReminder");
  });

  test("new agent success copy points users to manual /init", () => {
    const appSource = readSource("../../cli/App.tsx");

    expect(appSource).toContain(
      "Tip: use /init to initialize your agent's memory system!",
    );
    expect(appSource).not.toContain(
      "Memory will be auto-initialized on your first message.",
    );
  });

  test("shared reminder plumbing no longer includes auto-init", () => {
    const catalogSource = readSource("../../reminders/catalog.ts");
    const engineSource = readSource("../../reminders/engine.ts");
    const stateSource = readSource("../../reminders/state.ts");

    expect(catalogSource).not.toContain('"auto-init"');
    expect(engineSource).not.toContain('"auto-init"');
    expect(engineSource).not.toContain("buildAutoInitReminder");
    expect(stateSource).not.toContain("pendingAutoInitReminder");
  });

  test("prompt assets and docs no longer expose the auto-init reminder", () => {
    const promptAssetsSource = readSource("../../agent/promptAssets.ts");
    const promptsReadmeSource = readSource("../../agent/prompts/README.md");

    expect(promptAssetsSource).not.toContain("AUTO_INIT_REMINDER");
    expect(promptAssetsSource).not.toContain("auto_init_reminder.txt");
    expect(promptsReadmeSource).not.toContain("auto_init_reminder.txt");
  });

  test("manual /init remains the initialization path", () => {
    const appSource = readSource("../../cli/App.tsx");
    const initHandlerIdx = appSource.indexOf('trimmed === "/init"');

    expect(initHandlerIdx).toBeGreaterThan(-1);

    const initBlock = appSource.slice(initHandlerIdx, initHandlerIdx + 1600);
    expect(initBlock).toContain("buildInitMessage({");
    expect(initBlock).toContain("processConversation(");
  });
});
