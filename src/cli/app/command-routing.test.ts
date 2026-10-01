import { describe, expect, test } from "bun:test";
import {
  aliasBareExitCommand,
  shouldSlashCommandBypassQueue,
} from "./command-routing";

describe("command routing", () => {
  test("aliases only bare exit and quit without changing other commands", () => {
    expect(aliasBareExitCommand("exit")).toBe("/exit");
    expect(aliasBareExitCommand("quit")).toBe("/exit");
    for (const input of [
      "/reflect --recent 2",
      "/reflection",
      "/dream",
      "exit later",
      "QUIT",
    ]) {
      expect(aliasBareExitCommand(input)).toBe(input);
    }
  });
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
