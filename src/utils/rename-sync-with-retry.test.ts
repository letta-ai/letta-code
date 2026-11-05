import { expect, mock, test } from "bun:test";
import { renameSyncWithRetry } from "./rename-sync-with-retry";

test("retries transient rename failures only on Windows", () => {
  for (const platform of ["win32", "linux"] as const) {
    const error = Object.assign(new Error("busy"), { code: "EPERM" });
    const rename = mock(() => {
      if (rename.mock.calls.length <= 2) throw error;
    });
    const run = () => renameSyncWithRetry("temp", "dest", platform, rename);
    if (platform === "win32") {
      expect(run).not.toThrow();
      expect(rename).toHaveBeenCalledTimes(3);
    } else {
      expect(run).toThrow(error);
      expect(rename).toHaveBeenCalledTimes(1);
    }
  }
});
