import { describe, expect, test } from "bun:test";
import { __listenSubcommandTestUtils } from "@/cli/subcommands/listen";

const { shouldInstallChannelRuntimes } = __listenSubcommandTestUtils;

describe("listener channel runtime installation", () => {
  test("honors the install flag for restored enabled channels", () => {
    expect(shouldInstallChannelRuntimes([], true, true)).toBe(true);
  });

  test("honors the install flag for explicitly selected channels", () => {
    expect(shouldInstallChannelRuntimes(["slack"], false, true)).toBe(true);
  });

  test("does not install runtimes without a channel selection or request", () => {
    expect(shouldInstallChannelRuntimes([], false, true)).toBe(false);
    expect(shouldInstallChannelRuntimes(["slack"], false, false)).toBe(false);
    expect(shouldInstallChannelRuntimes([], true, false)).toBe(false);
  });
});
