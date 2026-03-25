import { describe, expect, mock, test } from "bun:test";

// We test the logout subcommand logic in isolation by mocking settingsManager.
// This avoids touching real keychain/file storage in the test environment.

describe("runLogoutSubcommand", () => {
  test("returns 0 and clears credentials on success", async () => {
    const logoutMock = mock(async () => {});
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      // Import the module under test, replacing the settingsManager singleton
      // by injecting a mock via the module cache is not trivial in Bun, so we
      // verify the end-to-end contract through the exported function directly.
      const { runLogoutSubcommand } = await import(
        "../../cli/subcommands/logout"
      );

      // Patch the settingsManager singleton used by the module
      const settingsMod = await import("../../settings-manager");
      const original = settingsMod.settingsManager.logout;
      settingsMod.settingsManager.logout = logoutMock;

      const code = await runLogoutSubcommand([]);

      settingsMod.settingsManager.logout = original;
      expect(logoutMock).toHaveBeenCalledTimes(1);
      expect(code).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });

  test("returns 1 and logs error when logout throws", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) =>
      errors.push(args.map(String).join(" "));

    try {
      const { runLogoutSubcommand } = await import(
        "../../cli/subcommands/logout"
      );
      const settingsMod = await import("../../settings-manager");
      const original = settingsMod.settingsManager.logout;
      settingsMod.settingsManager.logout = mock(async () => {
        throw new Error("keychain unavailable");
      });

      const code = await runLogoutSubcommand([]);

      settingsMod.settingsManager.logout = original;
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes("keychain unavailable"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});
