import { describe, expect, test } from "bun:test";
import {
  findUnusableNodePtyReason,
  formatNodePtyUnavailableMessage,
  isNodePtyUnavailableError,
  loadNodePtyWith,
} from "@/utils/node-pty-loader";

describe("loadNodePtyWith", () => {
  test("returns the loaded module untouched", () => {
    const module = { spawn: () => {} };
    expect(loadNodePtyWith(() => module)).toBe(module);
  });

  test("tags load failures so callers can degrade to a pipe", () => {
    const cause = new Error(
      "Error relocating /app/node_modules/node-pty/prebuilds/linux-x64/pty.node: __libc_start_main: symbol not found",
    );

    let thrown: unknown;
    try {
      loadNodePtyWith(() => {
        throw cause;
      });
    } catch (error) {
      thrown = error;
    }

    expect(isNodePtyUnavailableError(thrown)).toBe(true);
    expect((thrown as Error).cause).toBe(cause);
    expect((thrown as Error).message).toContain("symbol not found");
    expect((thrown as Error).message).toContain(
      "npm_config_build_from_source=true",
    );
  });

  test("handles non-Error throws", () => {
    expect(() =>
      loadNodePtyWith(() => {
        throw "boom";
      }),
    ).toThrow(/boom/);
  });
});

describe("isNodePtyUnavailableError", () => {
  test("does not match unrelated errors", () => {
    expect(isNodePtyUnavailableError(new Error("spawn ENOENT"))).toBe(false);
    expect(isNodePtyUnavailableError("nope")).toBe(false);
    expect(isNodePtyUnavailableError(undefined)).toBe(false);
  });
});

describe("findUnusableNodePtyReason", () => {
  const musl = { isMuslRuntime: () => true, hasSourceBuild: () => false };

  test("refuses the glibc prebuild on a musl runtime", () => {
    // Loading it succeeds and the first spawn() segfaults, which no try/catch
    // can recover from — so the load has to be refused up front.
    const reason = findUnusableNodePtyReason({ platform: "linux", ...musl });
    expect(reason).toContain("musl");
    expect(reason).toContain("npm_config_build_from_source=true");
  });

  test("allows a locally compiled binding on musl", () => {
    expect(
      findUnusableNodePtyReason({
        platform: "linux",
        isMuslRuntime: () => true,
        hasSourceBuild: () => true,
      }),
    ).toBeNull();
  });

  test("allows glibc linux", () => {
    expect(
      findUnusableNodePtyReason({
        platform: "linux",
        isMuslRuntime: () => false,
        hasSourceBuild: () => false,
      }),
    ).toBeNull();
  });

  test("never probes libc off linux", () => {
    for (const platform of ["darwin", "win32"]) {
      expect(
        findUnusableNodePtyReason({
          platform,
          isMuslRuntime: () => {
            throw new Error(`libc probed on ${platform}`);
          },
          hasSourceBuild: () => false,
        }),
      ).toBeNull();
    }
  });
});

describe("formatNodePtyUnavailableMessage", () => {
  test("includes the original failure and the rebuild hint", () => {
    const message = formatNodePtyUnavailableMessage(new Error("no such file"));
    expect(message).toContain("no such file");
    expect(message).toContain("compile node-pty from source");
  });
});
