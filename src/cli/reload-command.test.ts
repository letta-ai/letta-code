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
    expect(source).toContain("Reload settings and restart TUI effects");
  });

  test("AppProps includes onReload callback", () => {
    const typesPath = fileURLToPath(
      new URL("../cli/app/types.ts", import.meta.url),
    );
    const source = readFileSync(typesPath, "utf-8");

    expect(source).toContain(
      "onReload?: (agentId: string, conversationId: string) => Promise<void>",
    );
  });

  test("useSubmitHandler handles /reload command", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("../cli/app/use-submit-handler.ts", import.meta.url),
    );
    const source = readFileSync(submitHandlerPath, "utf-8");

    expect(source).toContain('trimmed === "/reload"');
    expect(source).toContain("onReload(");
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

  test("LoadingApp passes onReload and key to App", () => {
    const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
    const source = readFileSync(indexPath, "utf-8");
    expect(source).toContain("onReload: handleReload");
    expect(source).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting source contains literal template string syntax
      "key: `${agentId}:${conversationId}:${appReloadEpoch}`",
    );
  });
});
