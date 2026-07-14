import { describe, expect, test } from "bun:test";
import { localModelsChangedCallback } from "@/cli/commands/connect";

describe("connect command model refresh callbacks", () => {
  test("prefers the generic local-model refresh callback", () => {
    const calls: string[] = [];
    const legacyCalls: string[] = [];
    const callback = localModelsChangedCallback({
      onLocalModelsChanged: (providerName) => calls.push(providerName),
      onCodexConnected: (providerName) => legacyCalls.push(providerName),
    });

    callback?.("xai");

    expect(calls).toEqual(["xai"]);
    expect(legacyCalls).toEqual([]);
  });

  test("keeps the old Codex callback as a fallback", () => {
    const calls: string[] = [];
    const callback = localModelsChangedCallback({
      onCodexConnected: (providerName) => calls.push(providerName),
    });

    callback?.("chatgpt-plus-pro");

    expect(calls).toEqual(["chatgpt-plus-pro"]);
  });
});
