import { describe, expect, mock, spyOn, test } from "bun:test";
import { runEnvironmentsSubcommand } from "@/cli/subcommands/environments";

describe("environments list numeric options", () => {
  test.each(["0", "-1", "1.5", "10junk", " ", "9007199254740992", "1001"])(
    "rejects invalid limit %p before initialization",
    async (limit) => {
      const initializeSettings = mock(() => Promise.resolve());
      const listEnvironments = mock(() =>
        Promise.resolve({ connections: [], hasMore: false }),
      );
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const code = await runEnvironmentsSubcommand(
          [
            "list",
            limit.startsWith("-") ? `--limit=${limit}` : "--limit",
            ...(limit.startsWith("-") ? [] : [limit]),
          ],
          { initializeSettings, listEnvironments: listEnvironments as never },
        );

        expect(code).toBe(1);
        expect(initializeSettings).not.toHaveBeenCalled();
        expect(listEnvironments).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            "--limit must be an integer between 1 and 1000",
          ),
        );
      } finally {
        errorSpy.mockRestore();
      }
    },
  );
});
