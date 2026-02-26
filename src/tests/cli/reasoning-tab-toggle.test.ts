import { describe, expect, test } from "bun:test";
import { resolveReasoningTabToggleCommand } from "../../cli/helpers/reasoningTabToggle";

describe("reasoning tab toggle command parsing", () => {
  test("returns null for non-matching commands", () => {
    expect(resolveReasoningTabToggleCommand("/model", false)).toBeNull();
  });

  test("status/default reports current state", () => {
    expect(resolveReasoningTabToggleCommand("/reasoning-tab", false)).toEqual({
      kind: "status",
      message:
        "Reasoning Tab shortcut is disabled. Use /reasoning-tab on to enable it.",
    });

    expect(
      resolveReasoningTabToggleCommand("/reasoning-tab status", true),
    ).toEqual({
      kind: "status",
      message:
        "Reasoning Tab shortcut is enabled. Tab now cycles reasoning tiers.",
    });
  });

  test("accepts enable aliases", () => {
    for (const arg of ["on", "enable", "enabled", "true", "1"]) {
      expect(
        resolveReasoningTabToggleCommand(`/reasoning-tab ${arg}`, false),
      ).toEqual({
        kind: "set",
        enabled: true,
        message: "Reasoning Tab shortcut enabled.",
      });
    }
  });

  test("accepts disable aliases", () => {
    for (const arg of ["off", "disable", "disabled", "false", "0"]) {
      expect(
        resolveReasoningTabToggleCommand(`/reasoning-tab ${arg}`, true),
      ).toEqual({
        kind: "set",
        enabled: false,
        message: "Reasoning Tab shortcut disabled.",
      });
    }
  });

  test("returns usage for invalid arg", () => {
    expect(resolveReasoningTabToggleCommand("/reasoning-tab maybe", true)).toEqual(
      {
        kind: "invalid",
        message: "Usage: /reasoning-tab [on|off|status] (default is off)",
      },
    );
  });
});

