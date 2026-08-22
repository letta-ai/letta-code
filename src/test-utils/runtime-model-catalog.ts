import { afterEach, beforeEach } from "bun:test";
import { type CatalogModel, models } from "@/agent/model-catalog";
import fixture from "@/test-utils/fixtures/runtime-model-catalog.json";

/** Install a focused cloud-shaped catalog for pure model-selection tests. */
export function installRuntimeModelCatalogFixture(): void {
  models.splice(
    0,
    models.length,
    ...(fixture.models as CatalogModel[]).map((model) => ({
      ...model,
      ...(model.updateArgs ? { updateArgs: { ...model.updateArgs } } : {}),
    })),
  );
}

export function clearRuntimeModelCatalogFixture(): void {
  models.splice(0, models.length);
}

/** Install and clear the runtime catalog around each test in the current file. */
export function setupRuntimeModelCatalogFixture(): void {
  beforeEach(installRuntimeModelCatalogFixture);
  afterEach(clearRuntimeModelCatalogFixture);
}
