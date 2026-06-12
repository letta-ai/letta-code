import { describe, expect, test } from "bun:test";
import { shouldSlashCommandBypassQueue } from "./command-routing";

describe("command routing", () => {
  test("uses source precedence for slash command queue bypass", () => {
    expect(shouldSlashCommandBypassQueue("/reload")).toBe(true);
    expect(shouldSlashCommandBypassQueue("/mods learn memory-citations")).toBe(
      true,
    );

    expect(
      shouldSlashCommandBypassQueue("/reload", {
        modCommand: { runWhenBusy: false },
      }),
    ).toBe(false);

    expect(
      shouldSlashCommandBypassQueue("/review", {
        modCommand: { runWhenBusy: true },
      }),
    ).toBe(true);

    expect(
      shouldSlashCommandBypassQueue("/review", {
        hasCustomCommand: true,
        modCommand: { runWhenBusy: true },
      }),
    ).toBe(false);
  });
});
