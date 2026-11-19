import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import { resolvePiModelForAgent } from "@/backend/dev/pi-model-factory";
import {
  clearRegisteredPiProviders,
  getRegisteredPiProvider,
  getRegisteredPiProviderRevision,
  registerPiProvider,
  unregisterPiProvidersForOwner,
} from "@/backend/dev/pi-provider-mod-registry";
import { normalizeLocalModelHandle } from "@/backend/local/local-model-normalization";
import { createModEngine, type ModEngine } from "@/mods/mod-engine";
import {
  clearModPermissions,
  getModPermissionDefinition,
  registerModPermission,
  unregisterModPermissionsForOwner,
} from "@/mods/permission-registry";
import {
  clearModTools,
  getModToolDefinition,
  registerModTool,
  unregisterModToolsForOwner,
} from "@/mods/tool-registry";
import type { ModOwner } from "@/mods/types";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

type LifecycleGlobal = typeof globalThis & {
  __modLifecycleGate?: Promise<void>;
  __modLifecycleStarted?: () => void;
  __modLifecycleMode?: "wait" | "throw" | "ready";
  __modLifecycleRuns?: number;
};

const state = globalThis as LifecycleGlobal;
const roots: string[] = [];
const engines: ModEngine[] = [];
const providerName = "synthetic-mod-provider";
const modelHandle = `${providerName}/synthetic-model`;

setupRuntimeModelCatalogFixture();
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  clearRegisteredPiProviders();
  clearModTools();
  clearModPermissions();
  delete state.__modLifecycleGate;
  delete state.__modLifecycleStarted;
  delete state.__modLifecycleMode;
  delete state.__modLifecycleRuns;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; modDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "mod-lifecycle-"));
  roots.push(root);
  const modDir = path.join(root, "mods");
  mkdirSync(modDir);
  return { root, modDir };
}

function engine(root: string, modDir: string): ModEngine {
  const result = createModEngine({
    cacheDirectory: path.join(root, "cache"),
    getClient: async () => ({}) as Letta,
    globalModsDirectory: modDir,
  });
  engines.push(result);
  return result;
}

function writeProvider(modDir: string, filename: string, first = false): void {
  writeFileSync(
    path.join(modDir, filename),
    `
    export default async function(letta) {
      ${
        first
          ? `globalThis.__modLifecycleRuns = (globalThis.__modLifecycleRuns ?? 0) + 1;
        if (globalThis.__modLifecycleMode !== "ready") {
          globalThis.__modLifecycleStarted?.();
          await globalThis.__modLifecycleGate;
          if (globalThis.__modLifecycleMode === "throw") throw new Error("stale activation failed");
        }`
          : ""
      }
      letta.registerProvider("${providerName}", {
        baseUrl: "http://127.0.0.1:8000/v1", apiKey: "synthetic", api: "openai-completions",
        models: [{ id: "synthetic-model", name: "Synthetic Model", reasoning: false,
          input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000, maxTokens: 4096 }],
      });
      letta.tools.register({ name: "synthetic_tool", description: "current tool",
        parameters: { type: "object", properties: {} }, run() { return "ok"; } });
      letta.permissions.register({ id: "synthetic-permission", description: "Synthetic permission",
        check() { return { decision: "allow" }; } });
    }
  `,
  );
}

function gate(): { started: Promise<void>; release: () => void } {
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    state.__modLifecycleStarted = resolve;
  });
  state.__modLifecycleGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, release };
}

function expectCurrentRegistration(): void {
  expect(getRegisteredPiProvider(providerName)?.config.models?.[0]?.id).toBe(
    "synthetic-model",
  );
  expect(getModToolDefinition("synthetic_tool")?.description).toBe(
    "current tool",
  );
  expect(getModPermissionDefinition("synthetic-permission")).toBeDefined();
}

test.each(["wait", "throw"] as const)(
  "cancelled %s load cannot erase ready activation",
  async (mode) => {
    const { root, modDir } = fixture();
    writeProvider(modDir, "a-first.ts", true);
    writeFileSync(
      path.join(modDir, "b-second.ts"),
      `export default function() {
    globalThis.__modLifecycleRuns = (globalThis.__modLifecycleRuns ?? 0) + 1;
  }`,
    );
    const { started, release } = gate();
    state.__modLifecycleMode = mode;
    const loading = engine(root, modDir);
    const oldLoad = loading.reload();
    await started;
    loading.dispose();

    state.__modLifecycleMode = "ready";
    const ready = engine(root, modDir);
    await ready.reload();
    expectCurrentRegistration();
    const revision = getRegisteredPiProviderRevision(providerName);

    state.__modLifecycleMode = mode;
    release();
    await oldLoad;
    expectCurrentRegistration();
    expect(getRegisteredPiProviderRevision(providerName)).toBe(revision);
    expect(state.__modLifecycleRuns).toBe(3);
  },
);

test("loading-to-ready remount preserves saved mod model without reload", async () => {
  const { root, modDir } = fixture();
  writeProvider(modDir, "provider.ts", true);
  const { started, release } = gate();
  state.__modLifecycleMode = "wait";
  const loading = engine(root, modDir);
  const oldLoad = loading.reload();
  await started;
  loading.dispose();

  state.__modLifecycleMode = "ready";
  const ready = engine(root, modDir);
  await ready.reload();
  state.__modLifecycleMode = "throw";
  release();
  await oldLoad;

  expectCurrentRegistration();
  expect(
    normalizeLocalModelHandle(modelHandle, { provider_type: "openai" }),
  ).toBe(modelHandle);
  const resolved = await resolvePiModelForAgent(
    modelHandle,
    {},
    { localProviderAuthStorageDir: root },
  );
  expect(String(resolved.provider)).toBe(providerName);
  expect(resolved.model.id).toBe("synthetic-model");
});

test("older activation cannot unregister newer capabilities with the same stable owner ID", () => {
  const oldOwner: ModOwner = {
    id: "global:synthetic",
    path: "synthetic",
    scope: "global",
    generation: 1,
  };
  const newOwner: ModOwner = { ...oldOwner };
  const config = {
    baseUrl: "http://127.0.0.1:8000/v1",
    apiKey: "synthetic",
    api: "openai-completions" as const,
  };
  const signal = new AbortController().signal;
  for (const owner of [oldOwner, newOwner]) {
    registerPiProvider(providerName, config, owner);
    registerModTool({
      name: "synthetic_tool",
      description: "current tool",
      owner,
      path: owner.path,
      activationSignal: signal,
      parameters: { type: "object", properties: {} },
      requiresApproval: false,
      approvalPolicy: "auto",
      parallelSafe: false,
      run() {
        return "ok";
      },
    });
    registerModPermission({
      id: "synthetic-permission",
      description: "Synthetic permission",
      owner,
      path: owner.path,
      activationSignal: signal,
      check() {
        return { decision: "allow" };
      },
    });
  }
  const revision = getRegisteredPiProviderRevision(providerName);
  unregisterPiProvidersForOwner(oldOwner);
  unregisterModToolsForOwner(oldOwner);
  unregisterModPermissionsForOwner(oldOwner);
  expect(getRegisteredPiProvider(providerName)?.ownerId).toBe(newOwner.id);
  expect(getRegisteredPiProviderRevision(providerName)).toBe(revision);
  expect(getModToolDefinition("synthetic_tool")?.owner).toBe(newOwner);
  expect(getModPermissionDefinition("synthetic-permission")?.owner).toBe(
    newOwner,
  );
});
