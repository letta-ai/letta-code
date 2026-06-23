import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("/reload command", () => {
  test("is registered in the command registry", () => {
    const registryPath = fileURLToPath(
      new URL("../cli/commands/registry.ts", import.meta.url),
    );
    const source = readFileSync(registryPath, "utf-8");

    expect(source).toContain('"/reload"');
    expect(source).toContain("Reload settings and local mods");
  });

  test("AppCoordinator owns the in-place reload callback", () => {
    const appCoordinatorPath = fileURLToPath(
      new URL("../cli/app/AppCoordinator.tsx", import.meta.url),
    );
    const source = readFileSync(appCoordinatorPath, "utf-8");

    expect(source).toContain("const handleReload = useCallback(async () =>");
    expect(source).toContain("settingsManager.clearCaches()");
    expect(source).toContain("await settingsManager.loadProjectSettings()");
    expect(source).toContain(
      "await settingsManager.loadLocalProjectSettings()",
    );
    expect(source).toContain("refreshCustomCommands()");
    expect(source).toContain(
      'void modAdapter.events.emit(\n      "conversation_close"',
    );
    expect(source).toContain("await modAdapter.reload()");
    expect(source).toContain(
      'void modAdapter.events.emit(\n      "conversation_open"',
    );
    expect(source).toContain('reason: "reload"');
  });

  test("useSubmitHandler handles /reload command", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("../cli/app/use-submit-handler.ts", import.meta.url),
    );
    const source = readFileSync(submitHandlerPath, "utf-8");

    expect(source).toContain('trimmed === "/reload"');
    expect(source).toContain("await onReload()");
    expect(source).toContain("Reloaded settings and local mods");
  });

  test("/reload has a busy guard", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("../cli/app/use-submit-handler.ts", import.meta.url),
    );
    const source = readFileSync(submitHandlerPath, "utf-8");

    expect(source).toContain("Cannot reload while the agent is running.");
  });

  test("/reload is in NON_STATE_COMMANDS for bypass routing", () => {
    const commandRoutingPath = fileURLToPath(
      new URL("../cli/app/command-routing.ts", import.meta.url),
    );
    const source = readFileSync(commandRoutingPath, "utf-8");

    expect(source).toContain('"/reload"');
  });

  test("/reload does not remount App through startup state", () => {
    const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
    const source = readFileSync(indexPath, "utf-8");
    expect(source).not.toContain("appReloadEpoch");
    expect(source).not.toContain("setAppReloadEpoch");
    expect(source).not.toContain("onReload: handleReload");
    expect(source).not.toContain("setResumeData(null)");
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting source contains literal template string syntax
      "key: `${agentId}:${conversationId}`",
    );
  });
});
