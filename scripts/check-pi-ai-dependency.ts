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
  const invalid: string[] = [];

  for (const model of modelsData.models) {
    const parsed = modelIdFromHandle(model.handle);
    if (!parsed) continue;
    if (allowedUnmirroredProviders.has(parsed.provider)) continue;
    if (!piProviders.has(parsed.provider)) continue;

    const piModel = getModels(parsed.provider).find(
      (candidate) => candidate.id === parsed.id,
    );
    if (!piModel) {
      missing.push(model.handle);
      continue;
    }

    if (!piModel.baseUrl || !piModel.api || piModel.input.length === 0) {
      invalid.push(model.handle);
    }
  }

  assert(
    missing.length === 0,
    `@earendil-works/pi-ai ${piAiPackageJson.version} is missing local models.json handles:\n${missing
      .map((handle) => `  - ${handle}`)
      .join("\n")}`,
  );
  assert(
    invalid.length === 0,
    `@earendil-works/pi-ai ${piAiPackageJson.version} has incompatible local models.json handles:\n${invalid
      .map((handle) => `  - ${handle}`)
      .join("\n")}`,
  );
}

const [firstProvider] = getProviders();
assert(firstProvider, "Pi provider catalog is empty");
const [firstModel] = getModels(firstProvider);
assert(firstModel, `Pi model catalog is empty for ${firstProvider}`);
assert(
  getModel(firstProvider, firstModel.id).id === firstModel.id,
  "Pi getModel smoke failed",
);
assertPiCatalogCoversLocalModels();

console.log(
  `@earendil-works/pi-ai ${piAiPackageJson.version} covers local Pi model handles`,
);
