import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  ensureLettaShimDir,
  getShellEnv,
  resolveLettaInvocation,
} from "../../tools/impl/shellEnv";

describe("shellEnv letta shim", () => {
  test("resolveLettaInvocation prefers explicit launcher env", () => {
    const invocation = resolveLettaInvocation(
      {
        LETTA_CODE_BIN: "/tmp/custom-letta",
        LETTA_CODE_BIN_ARGS_JSON: JSON.stringify(["/tmp/entry.ts"]),
      },
      ["bun", "/something/else.ts"],
      "/opt/homebrew/bin/bun",
    );

    expect(invocation).toEqual({
      command: "/tmp/custom-letta",
      args: ["/tmp/entry.ts"],
    });
  });

  test("resolveLettaInvocation infers dev entrypoint launcher", () => {
    const invocation = resolveLettaInvocation(
      {},
      ["bun", "/Users/example/dev/letta-code-prod/src/index.ts"],
      "/opt/homebrew/bin/bun",
    );

    expect(invocation).toEqual({
      command: "/opt/homebrew/bin/bun",
      args: ["/Users/example/dev/letta-code-prod/src/index.ts"],
    });
  });

  test("resolveLettaInvocation returns null for unrelated argv scripts", () => {
    const invocation = resolveLettaInvocation(
      {},
      ["bun", "/Users/example/dev/another-project/scripts/run.ts"],
      "/opt/homebrew/bin/bun",
    );

    expect(invocation).toBeNull();
  });

  test("resolveLettaInvocation does not infer production letta.js entrypoint", () => {
    const invocation = resolveLettaInvocation(
      {},
      [
        "/usr/local/bin/node",
        "/usr/local/lib/node_modules/@letta-ai/letta-code/letta.js",
      ],
      "/usr/local/bin/node",
    );

    expect(invocation).toBeNull();
  });

  test("letta shim resolves first on PATH for subprocess shells", () => {
    if (process.platform === "win32") {
      return;
    }

    const shimDir = ensureLettaShimDir({
      command: "/bin/echo",
      args: ["shimmed-letta"],
    });
    expect(shimDir).toBeTruthy();

    const env = {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH || ""}`,
    };
    const whichResult = spawnSync("which", ["letta"], {
      env,
      encoding: "utf8",
    });
    expect(whichResult.status).toBe(0);
    expect(whichResult.stdout.trim()).toBe(
      path.join(shimDir as string, "letta"),
    );

    const versionResult = spawnSync("letta", ["--version"], {
      env,
      encoding: "utf8",
    });
    expect(versionResult.status).toBe(0);
    expect(versionResult.stdout.trim()).toBe("shimmed-letta --version");
  });

  test("getShellEnv sets launcher metadata when explicit launcher env is provided", () => {
    const originalBin = process.env.LETTA_CODE_BIN;
    const originalArgs = process.env.LETTA_CODE_BIN_ARGS_JSON;

    process.env.LETTA_CODE_BIN = "/tmp/explicit-bin";
    process.env.LETTA_CODE_BIN_ARGS_JSON = JSON.stringify([
      "/tmp/entrypoint.js",
    ]);

    try {
      const env = getShellEnv();
      expect(env.LETTA_CODE_BIN).toBe("/tmp/explicit-bin");
      expect(env.LETTA_CODE_BIN_ARGS_JSON).toBe(
        JSON.stringify(["/tmp/entrypoint.js"]),
      );
    } finally {
      if (originalBin === undefined) {
        delete process.env.LETTA_CODE_BIN;
      } else {
        process.env.LETTA_CODE_BIN = originalBin;
      }
      if (originalArgs === undefined) {
        delete process.env.LETTA_CODE_BIN_ARGS_JSON;
      } else {
        process.env.LETTA_CODE_BIN_ARGS_JSON = originalArgs;
      }
    }
  });
});
