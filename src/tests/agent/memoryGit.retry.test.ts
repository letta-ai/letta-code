import { describe, expect, test } from "bun:test";

import {
  isMissingCwdGitError,
  isRetryableGitTransientError,
} from "../../agent/memoryGit";

describe("isRetryableGitTransientError", () => {
  test("returns true for Cloudflare 52x HTTP errors", () => {
    expect(
      isRetryableGitTransientError(
        new Error(
          "fatal: unable to access 'https://api.letta.com/...': The requested URL returned error: 521",
        ),
      ),
    ).toBe(true);

    expect(
      isRetryableGitTransientError(
        new Error("error: RPC failed; HTTP 520 curl 22"),
      ),
    ).toBe(true);
  });

  describe("isMissingCwdGitError", () => {
    test("returns true for missing cwd git error", () => {
      expect(
        isMissingCwdGitError(
          new Error(
            "fatal: Unable to read current working directory: No such file or directory",
          ),
        ),
      ).toBe(true);
    });

    test("returns false for non-cwd errors", () => {
      expect(
        isMissingCwdGitError(
          new Error("fatal: the remote end hung up unexpectedly"),
        ),
      ).toBe(false);
    });
  });

  test("returns true for RPC failed + remote hung up", () => {
    expect(
      isRetryableGitTransientError(
        new Error(
          "error: RPC failed; HTTP 520 curl 22 The requested URL returned error: 520\nfatal: the remote end hung up unexpectedly",
        ),
      ),
    ).toBe(true);
  });

  test("returns false for auth failures", () => {
    expect(
      isRetryableGitTransientError(
        new Error(
          "fatal: could not read Username for 'https://api.letta.com': Device not configured",
        ),
      ),
    ).toBe(false);
  });

  test("returns false for non-network git errors", () => {
    expect(
      isRetryableGitTransientError(
        new Error("fatal: Not possible to fast-forward, aborting."),
      ),
    ).toBe(false);
  });
});
