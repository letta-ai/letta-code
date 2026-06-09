import { describe, expect, test } from "bun:test";
import {
  areExtensionsDisabled,
  LETTA_DISABLE_EXTENSIONS_ENV,
  LETTA_DISABLE_MODS_ENV,
  shouldDisableExtensions,
} from "@/extensions/disable";

describe("mod disable switch", () => {
  test("recognizes CLI flag and common truthy env values", () => {
    expect(shouldDisableExtensions({ cliFlag: true, env: {} })).toBe(true);
    expect(shouldDisableExtensions({ cliFlag: false, env: {} })).toBe(false);

    for (const value of ["1", "true", "TRUE", "yes", "on"] as const) {
      expect(areExtensionsDisabled({ [LETTA_DISABLE_MODS_ENV]: value })).toBe(
        true,
      );
    }

    for (const value of ["", "0", "false", "off", "no"] as const) {
      expect(areExtensionsDisabled({ [LETTA_DISABLE_MODS_ENV]: value })).toBe(
        false,
      );
    }

    expect(areExtensionsDisabled({ [LETTA_DISABLE_EXTENSIONS_ENV]: "1" })).toBe(
      true,
    );
  });
});
