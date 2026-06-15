import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRegisteredPiProviders,
  getRegisteredPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { resolveLocalProvider } from "@/backend/local/local-model-config";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";
import { listConnectProvidersForHelp } from "@/cli/commands/connect-normalize";
import {
  disposeProviderOnlyModsForProcess,
  ensureProviderOnlyModsLoadedForProcess,
} from "@/mods/provider-mod-adapter";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-provider-mod-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  disposeProviderOnlyModsForProcess();
  clearRegisteredPiProviders();
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("provider-only mod adapter", () => {
  test("loads process-wide provider registrations", async () => {
    const root = createTempDir();
    const modsDir = join(root, "mods");
    const cacheDir = join(root, "cache");
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(
      join(modsDir, "featherless.ts"),
      `export default function activate(letta) {
        letta.providers.register("featherless", {
          name: "Featherless",
          description: "Connect Featherless",
          api: "openai-completions",
          baseUrl: "https://api.featherless.ai/v1",
          apiKey: "FEATHERLESS_API_KEY",
          models: [{
            id: "qwen3-235b-a22b",
            name: "Qwen3 235B A22B",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          }],
        });
      }`,
    );

    await ensureProviderOnlyModsLoadedForProcess({
      cacheDirectory: cacheDir,
      globalModsDirectory: modsDir,
      workingDirectory: root,
    });

    expect(getRegisteredPiProvider("featherless")?.config).toMatchObject({
      name: "Featherless",
      baseUrl: "https://api.featherless.ai/v1",
      models: [{ id: "qwen3-235b-a22b" }],
    });
    expect(listConnectProvidersForHelp("local")).toContain("featherless");

    await createOrUpdateLocalProvider({
      storageDir: root,
      providerType: "featherless",
      providerName: "featherless",
      apiKey: "fake-key",
    });
    expect(String(resolveLocalProvider(root))).toBe("featherless");

    disposeProviderOnlyModsForProcess();
    expect(getRegisteredPiProvider("featherless")).toBeUndefined();
  });
});
