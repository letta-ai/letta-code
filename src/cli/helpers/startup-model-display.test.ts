import { describe, expect, test } from "bun:test";
import { getStartupModelDisplayOverride } from "@/cli/helpers/startup-model-display";

describe("getStartupModelDisplayOverride", () => {
  test("shows no-model label for local startup when no local models are available", () => {
    expect(
      getStartupModelDisplayOverride({
        isLocalBackend: true,
        startupHasAvailableLocalModels: false,
      }),
    ).toBe("No model selected");
  });

  test("does not override when local models are available", () => {
    expect(
      getStartupModelDisplayOverride({
        isLocalBackend: true,
        startupHasAvailableLocalModels: true,
      }),
    ).toBeNull();
  });

  test("does not override for non-local backends", () => {
    expect(
      getStartupModelDisplayOverride({
        isLocalBackend: false,
        startupHasAvailableLocalModels: false,
      }),
    ).toBeNull();
  });
});
