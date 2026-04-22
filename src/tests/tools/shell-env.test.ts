import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { runWithRuntimeContext } from "../../runtime-context";
import { settingsManager } from "../../settings-manager";
import {
  ensureLettaShimDir,
  getShellEnv,
  resolveLettaInvocation,
} from "../../tools/impl/shellEnv";

function withTemporaryAgentEnv<T>(agentId: string, fn: () => T): T {
  const originalAgentId = process.env.AGENT_ID;
  const originalLettaAgentId = process.env.LETTA_AGENT_ID;

  process.env.AGENT_ID = agentId;
  process.env.LETTA_AGENT_ID = agentId;

  try {
    return fn();
  } finally {
    if (originalAgentId === undefined) {
      delete process.env.AGENT_ID;
    } else {
      process.env.AGENT_ID = originalAgentId;
    }

    if (originalLettaAgentId === undefined) {
      delete process.env.LETTA_AGENT_ID;
    } else {
      process.env.LETTA_AGENT_ID = originalLettaAgentId;
    }
  }
}

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

  test("resolveLettaInvocation strips accidental wrapping quotes in LETTA_CODE_BIN", () => {
    const invocation = resolveLettaInvocation(
      {
        LETTA_CODE_BIN:
          '"C:\\Users\\Example User\\AppData\\Roaming\\npm\\letta.cmd"',
      },
      ["node", "/irrelevant/script.js"],
      "/opt/homebrew/bin/bun",
    );

    expect(invocation).toEqual({
      command: "C:\\Users\\Example User\\AppData\\Roaming\\npm\\letta.cmd",
      args: [],
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
      args: [
        "--loader:.md=text",
        "--loader:.mdx=text",
        "--loader:.txt=text",
        "run",
        "/Users/example/dev/letta-code-prod/src/index.ts",
      ],
    });
  });

  test("resolveLettaInvocation resolves relative dev entrypoint against cwd", () => {
    const cwd =
      process.platform === "win32"
        ? path.win32.join("C:\\", "Users", "example", "dev", "letta-code-prod")
        : path.posix.join("/", "Users", "example", "dev", "letta-code-prod");
    const expectedScriptPath =
      process.platform === "win32"
        ? path.win32.join(cwd, "src", "index.ts")
        : path.posix.join(cwd, "src", "index.ts");
    const execPath =
      process.platform === "win32"
        ? "C:\\bun\\bun.exe"
        : "/opt/homebrew/bin/bun";

    const invocation = resolveLettaInvocation(
      {},
      ["bun", "src/index.ts"],
      execPath,
      cwd,
    );

    expect(invocation).toEqual({
      command: execPath,
      args: [
        "--loader:.md=text",
        "--loader:.mdx=text",
        "--loader:.txt=text",
        "run",
        expectedScriptPath,
      ],
    });
  });

  test("resolveLettaInvocation keeps non-bun dev launcher behavior", () => {
    const invocation = resolveLettaInvocation(
      {},
      ["node", "/Users/example/dev/letta-code-prod/src/index.ts"],
      "/usr/local/bin/node",
    );

    expect(invocation).toEqual({
      command: "/usr/local/bin/node",
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

test("getShellEnv injects AGENT_ID aliases", () => {
  withTemporaryAgentEnv(`agent-test-${Date.now()}`, () => {
    const env = getShellEnv();

    expect(env.AGENT_ID).toBeTruthy();
    expect(env.LETTA_AGENT_ID).toBe(env.AGENT_ID);
  });
});

test("getShellEnv prefers runtime-scoped agent, conversation, and cwd", () => {
  const env = runWithRuntimeContext(
    {
      agentId: "agent-runtime-scope",
      conversationId: "conv-runtime-scope",
      workingDirectory: "/tmp/runtime-scope-cwd",
    },
    () => getShellEnv(),
  );

  expect(env.AGENT_ID).toBe("agent-runtime-scope");
  expect(env.LETTA_AGENT_ID).toBe("agent-runtime-scope");
  expect(env.CONVERSATION_ID).toBe("conv-runtime-scope");
  expect(env.LETTA_CONVERSATION_ID).toBe("conv-runtime-scope");
  expect(env.USER_CWD).toBe("/tmp/runtime-scope-cwd");
});

test("getShellEnv isolates overlapping runtime scopes", async () => {
  let releaseAgentA!: () => void;
  const waitForAgentA = new Promise<void>((resolve) => {
    releaseAgentA = resolve;
  });

  const taskA = runWithRuntimeContext(
    {
      agentId: "agent-a",
      conversationId: "conv-a",
      workingDirectory: "/tmp/agent-a",
    },
    async () => {
      await waitForAgentA;
      return getShellEnv();
    },
  );

  const taskB = runWithRuntimeContext(
    {
      agentId: "agent-b",
      conversationId: "conv-b",
      workingDirectory: "/tmp/agent-b",
    },
    async () => {
      releaseAgentA();
      return getShellEnv();
    },
  );

  const [envA, envB] = await Promise.all([taskA, taskB]);

  expect(envA.AGENT_ID).toBe("agent-a");
  expect(envA.CONVERSATION_ID).toBe("conv-a");
  expect(envA.USER_CWD).toBe("/tmp/agent-a");
  expect(envB.AGENT_ID).toBe("agent-b");
  expect(envB.CONVERSATION_ID).toBe("conv-b");
  expect(envB.USER_CWD).toBe("/tmp/agent-b");
});

test("getShellEnv does not inject MEMORY_DIR aliases when memfs is disabled", () => {
  withTemporaryAgentEnv(`agent-test-${Date.now()}`, () => {
    const originalIsMemfsEnabled =
      settingsManager.isMemfsEnabled.bind(settingsManager);
    const originalMemoryDir = process.env.MEMORY_DIR;
    const originalLettaMemoryDir = process.env.LETTA_MEMORY_DIR;
    (
      settingsManager as unknown as { isMemfsEnabled: (id: string) => boolean }
    ).isMemfsEnabled = () => false;
    process.env.MEMORY_DIR = "/tmp/stale-memory-dir";
    process.env.LETTA_MEMORY_DIR = "/tmp/stale-memory-dir";

    try {
      const env = getShellEnv();
      expect(env.LETTA_MEMORY_DIR).toBeUndefined();
      expect(env.MEMORY_DIR).toBeUndefined();
    } finally {
      (
        settingsManager as unknown as {
          isMemfsEnabled: (id: string) => boolean;
        }
      ).isMemfsEnabled = originalIsMemfsEnabled;

      if (originalMemoryDir === undefined) {
        delete process.env.MEMORY_DIR;
      } else {
        process.env.MEMORY_DIR = originalMemoryDir;
      }

      if (originalLettaMemoryDir === undefined) {
        delete process.env.LETTA_MEMORY_DIR;
      } else {
        process.env.LETTA_MEMORY_DIR = originalLettaMemoryDir;
      }
    }
  });
});

test("getShellEnv injects MEMORY_DIR aliases when memfs is enabled", () => {
  withTemporaryAgentEnv(`agent-test-${Date.now()}`, () => {
    const original = settingsManager.isMemfsEnabled.bind(settingsManager);
    (
      settingsManager as unknown as { isMemfsEnabled: (id: string) => boolean }
    ).isMemfsEnabled = () => true;

    try {
      const env = getShellEnv();
      expect(env.AGENT_ID).toBeTruthy();
      const resolvedAgentId = env.AGENT_ID as string;
      const expectedMemoryDir = getMemoryFilesystemRoot(resolvedAgentId);
      expect(env.LETTA_MEMORY_DIR).toBe(expectedMemoryDir);
      expect(env.MEMORY_DIR).toBe(expectedMemoryDir);
    } finally {
      (
        settingsManager as unknown as {
          isMemfsEnabled: (id: string) => boolean;
        }
      ).isMemfsEnabled = original;
    }
  });
});
