import { describe, expect, test } from "bun:test";
import {
  areModsDisabled,
  LEGACY_LETTA_DISABLE_EXTENSIONS_ENV,
  LETTA_DISABLE_MODS_ENV,
  shouldDisableMods,
} from "@/mods/disable";

describe("mod disable switch", () => {
  test("recognizes CLI flag and common truthy env values", () => {
    expect(shouldDisableMods({ cliFlag: true, env: {} })).toBe(true);
    expect(shouldDisableMods({ cliFlag: false, env: {} })).toBe(false);

    for (const value of ["1", "true", "TRUE", "yes", "on"] as const) {
      expect(areModsDisabled({ [LETTA_DISABLE_MODS_ENV]: value })).toBe(true);
    }

    for (const value of ["", "0", "false", "off", "no"] as const) {
      expect(areModsDisabled({ [LETTA_DISABLE_MODS_ENV]: value })).toBe(false);
    }
  });

  test("recognizes legacy extension disable env", () => {
    expect(
      areModsDisabled({ [LEGACY_LETTA_DISABLE_EXTENSIONS_ENV]: "1" }),
    ).toBe(true);
  });
});
