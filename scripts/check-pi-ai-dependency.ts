#!/usr/bin/env bun

import { getModel, getModels, getProviders } from "@earendil-works/pi-ai";
import piAiPackageJson from "@earendil-works/pi-ai/package.json" with {
  type: "json",
};
import modelsData from "@/models.json" with { type: "json" };

const allowedUnmirroredProviders = new Set([
  // Letta Code intentionally carries some OpenAI handles that are not in Pi's
  // generated catalog yet, especially release-preview aliases.
  "openai",
]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function modelIdFromHandle(
  handle: string,
): { provider: string; id: string } | null {
  const slashIndex = handle.indexOf("/");
  if (slashIndex <= 0) return null;
  return {
    provider: handle.slice(0, slashIndex),
    id: handle.slice(slashIndex + 1),
  };
}

function assertPiCatalogCoversLocalModels(): void {
  const piProviders = new Set(getProviders());
  const missing: string[] = [];

  for (const model of modelsData.models) {
    const parsed = modelIdFromHandle(model.handle);
    if (!parsed) continue;
    if (allowedUnmirroredProviders.has(parsed.provider)) continue;
    if (!piProviders.has(parsed.provider)) continue;

    const hasModel = getModels(parsed.provider).some(
      (candidate) => candidate.id === parsed.id,
    );
    if (!hasModel) missing.push(model.handle);
  }

  assert(
    missing.length === 0,
    `@earendil-works/pi-ai ${piAiPackageJson.version} is missing local models.json handles:\n${missing
      .map((handle) => `  - ${handle}`)
      .join("\n")}`,
  );
}

function assertMiniMaxM3(): void {
  const model = getModel("minimax", "MiniMax-M3");
  assert(model.provider === "minimax", "MiniMax-M3 provider mismatch");
  assert(model.api === "anthropic-messages", "MiniMax-M3 API mismatch");
  assert(model.reasoning === true, "MiniMax-M3 should support reasoning");
  assert(
    model.input.includes("image"),
    "MiniMax-M3 should support image input",
  );
  assert(
    model.contextWindow >= 500_000,
    `MiniMax-M3 context window unexpectedly small: ${model.contextWindow}`,
  );

  const localModel = modelsData.models.find(
    (candidate) => candidate.id === "minimax-m3",
  );
  assert(
    localModel?.handle === "minimax/MiniMax-M3",
    "local MiniMax-M3 handle missing",
  );
}

assertPiCatalogCoversLocalModels();
assertMiniMaxM3();

console.log(
  `@earendil-works/pi-ai ${piAiPackageJson.version} covers local Pi model handles`,
);
