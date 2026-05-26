import { describe, expect, test } from "bun:test";
import {
  getStartupModelDisplayOverride,
  shouldHideReasoningForModelDisplay,
} from "@/cli/helpers/startup-model-display";

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

  test("suppresses reasoning suffix for the no-model placeholder", () => {
    expect(shouldHideReasoningForModelDisplay("No model selected")).toBe(true);
    expect(shouldHideReasoningForModelDisplay("GPT-5.5")).toBe(false);
    expect(shouldHideReasoningForModelDisplay(null)).toBe(false);
  });
});
