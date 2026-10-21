import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LETTA_CHAT_API_KEYS_URL } from "@/cli/helpers/app-urls";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

/**
 * Startup flow tests that validate flag conflict handling.
 *
 * These must remain runnable in fork PR CI (no secrets), so they should not
 * require a working Letta server or LETTA_API_KEY.
 */

const projectRoot = process.cwd();
const CLI_TIMEOUT_MS = 30_000;

async function runCli(
  args: string[],
  options: {
    timeoutMs?: number;
    expectExit?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { timeoutMs = CLI_TIMEOUT_MS, expectExit } = options;
  const homeDir = await mkdtemp(join(tmpdir(), "letta-startup-flow-home-"));

  try {
    return await new Promise((resolve, reject) => {
      const proc = spawn("bun", ["run", "dev", ...args], {
        cwd: projectRoot,
        env: createIsolatedCliTestEnv({
          HOME: homeDir,
          LETTA_DISABLE_MODS: "1",
        }),
      });
      proc.stdin?.end();

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        reject(
          new Error(
            `Timeout after ${timeoutMs}ms. stdout: ${stdout}, stderr: ${stderr}`,
          ),
        );
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (expectExit !== undefined && code !== expectExit) {
          reject(
            new Error(
              `Expected exit code ${expectExit}, got ${code}. stdout: ${stdout}, stderr: ${stderr}`,
            ),
          );
        } else {
          resolve({ stdout, stderr, exitCode: code });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

const EVERYTHING_SERVER = fileURLToPath(
  new URL(
    "./dist/index.js",
    import.meta.resolve("@modelcontextprotocol/server-everything/package.json"),
  ),
);
const MCP_TEST_AGENT_ID = "agent-local-mcp-output";
const MCP_ECHO_TOOL = "mcp__everything__echo";

type McpOutputMode = "pipe" | "file" | "closed-pipe";

function escapedMcpPayload(size: number): string {
  const seed = ["A", "b", "+", "/", "=", "\\", '"', "\n", "雪"].join("");
  return seed.repeat(Math.ceil(size / seed.length)).slice(0, size);
}

function expectedMcpEchoStdout(payload: string): string {
  return `${JSON.stringify(
    { content: [{ type: "text", text: `Echo: ${payload}` }] },
    null,
    2,
  )}\n`;
}

function base64PayloadForResponseSize(responseSize: number): string {
  const emptyResponseSize = Buffer.byteLength(expectedMcpEchoStdout(""));
  const payloadSize = responseSize - emptyResponseSize;
  if (payloadSize < 0) throw new Error("Response size is too small");
  const seed = "Ab+/";
  return seed
    .repeat(Math.ceil(payloadSize / seed.length))
    .slice(0, payloadSize);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runMcpEcho(
  payload: string,
  outputMode: McpOutputMode = "pipe",
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  payload: string;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "letta-mcp-output-home-"));
  const storageDir = join(homeDir, "local-backend");
  const argsPath = join(homeDir, "mcp-args.json");
  const stdoutPath = join(homeDir, "mcp-stdout.json");
  let stdoutFile: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await mkdir(join(homeDir, ".letta"), { recursive: true });
    await writeFile(
      join(homeDir, ".letta", "settings.json"),
      JSON.stringify({
        agents: [
          {
            agentId: MCP_TEST_AGENT_ID,
            baseUrl: `local:${storageDir}`,
            mcpServers: [
              {
                name: "everything",
                transport: "stdio",
                command: process.execPath,
                args: [EVERYTHING_SERVER],
              },
            ],
          },
        ],
      }),
    );
    await writeFile(argsPath, JSON.stringify({ message: payload }));
    if (outputMode === "file") stdoutFile = await open(stdoutPath, "w");

    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const proc = spawn(
        "bun",
        [
          "--loader=.md:text",
          "--loader=.mdx:text",
          "--loader=.txt:text",
          "run",
          "src/index.ts",
          "--backend",
          "local",
          "mcp",
          "call",
          MCP_ECHO_TOOL,
          "--args-file",
          argsPath,
        ],
        {
          cwd: projectRoot,
          env: createIsolatedCliTestEnv({
            HOME: homeDir,
            AGENT_ID: MCP_TEST_AGENT_ID,
            LETTA_AGENT_ID: MCP_TEST_AGENT_ID,
            LETTA_DEBUG: "0",
            LETTA_DISABLE_MODS: "1",
            LETTA_LOCAL_BACKEND_DIR: storageDir,
            LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
          }),
          stdio: ["ignore", stdoutFile?.fd ?? "pipe", "pipe"],
        },
      );

      proc.stdout?.on("data", (data) => {
        stdoutChunks.push(Buffer.from(data));
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      if (outputMode === "closed-pipe") proc.stdout?.destroy();

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error(`Timeout waiting for MCP CLI. stderr: ${stderr}`));
      }, 30_000);
      proc.on("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
      proc.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    let stdout = Buffer.concat(stdoutChunks).toString("utf8");
    if (stdoutFile) {
      await stdoutFile.close();
      stdoutFile = undefined;
      stdout = await readFile(stdoutPath, "utf8");
    }
    return { stdout, stderr, exitCode, payload };
  } finally {
    await stdoutFile?.close().catch(() => {});
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe("Startup Flow - Flag Conflicts", () => {
  test("--conversation conflicts with --agent", async () => {
    const result = await runCli(
      ["--conversation", "conv-123", "--agent", "agent-123"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain(
      "--conversation cannot be used with --agent",
    );
  });

  test("--conversation conflicts with --new-agent", async () => {
    const result = await runCli(["--conversation", "conv-123", "--new-agent"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain(
      "--conversation cannot be used with --new-agent",
    );
  });

  test("--conversation conflicts with --resume", async () => {
    const result = await runCli(["--conversation", "conv-123", "--resume"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain(
      "--conversation cannot be used with --resume",
    );
  });

  test("--conversation conflicts with --name", async () => {
    const result = await runCli(
      ["--conversation", "conv-123", "--name", "MyAgent"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain(
      "--conversation cannot be used with --name",
    );
  });
});

describe("Startup Flow - Smoke", () => {
  test.each(["update", "upgrade", "--update", "--upgrade"])(
    "%s routes to manual update instead of flag parsing errors",
    async (alias) => {
      const result = await runCli([alias], { expectExit: 1 });
      expect(result.stdout).toContain(
        "Manual updates are disabled in development mode",
      );
      expect(result.stderr).not.toContain("Unknown option");
    },
  );

  test("--name conflicts with --new-agent", async () => {
    const result = await runCli(["--name", "MyAgent", "--new-agent"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain("--name cannot be used with --new-agent");
  });

  test("--new + --name does not conflict (new conversation on named agent)", async () => {
    const result = await runCli(
      ["-p", "Say OK", "--new", "--name", "NonExistentAgent999"],
      { expectExit: 1 },
    );
    // Should get past flag validation regardless of whether credentials exist.
    expect(result.stderr).not.toContain("cannot be used with");
    expect(
      result.stderr.includes("NonExistentAgent999") ||
        result.stderr.includes("Missing LETTA_API_KEY"),
    ).toBe(true);
  });

  test("--new-agent headless parses and reaches credential check", async () => {
    const result = await runCli(["--new-agent", "-p", "Say OK"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain("Missing LETTA_API_KEY");
    expect(result.stderr).toContain(
      `Get an API key at ${LETTA_CHAT_API_KEYS_URL}`,
    );
    expect(result.stderr).not.toContain("https://app.letta.com/api-keys");
    expect(result.stderr).not.toContain("No recent session found");
  });

  test("unknown positional with non-TTY stdin rejects before headless credential path", async () => {
    const result = await runCli(["whoami"], { expectExit: 1 });
    expect(result.stderr).toContain(
      'Error: Unknown command or argument "whoami"',
    );
    expect(result.stderr).toContain(
      "Run 'letta --help' for usage information.",
    );
    expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
  });

  test("stdin-only non-TTY startup still uses the headless path", async () => {
    const result = await runCli([], { expectExit: 1 });
    expect(result.stderr).toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Unknown command or argument");
  });

  test("--toolset auto is accepted", async () => {
    const result = await runCli(
      ["--new-agent", "--toolset", "auto", "-p", "Say OK"],
      {
        expectExit: 1,
      },
    );
    expect(result.stderr).toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Invalid toolset");
  });

  test("--toolset letta is accepted", async () => {
    const result = await runCli(
      ["--new-agent", "--toolset", "letta", "-p", "Say OK"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Invalid toolset");
  });

  test("--toolset accepts none", async () => {
    for (const toolset of ["none"]) {
      const result = await runCli(
        ["--new-agent", "--toolset", toolset, "-p", "Say OK"],
        { expectExit: 1 },
      );
      expect(result.stderr).toContain("Missing LETTA_API_KEY");
      expect(result.stderr).not.toContain("Invalid toolset");
    }
  });

  test("--memfs-startup is accepted for headless startup", async () => {
    const result = await runCli(
      ["--new-agent", "-p", "Say OK", "--memfs-startup", "background"],
      {
        expectExit: 1,
      },
    );
    expect(result.stderr).toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Unknown option '--memfs-startup'");
  });

  test("--stateless accepts an existing agent in headless mode", async () => {
    const result = await runCli(
      ["--agent", "agent-123", "--new", "--stateless", "-p", "Say OK"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Unknown option '--stateless'");
    expect(result.stderr).not.toContain("--stateless requires");
  });

  test("--stateless rejects MemFS and new-agent combinations", async () => {
    const withMemfs = await runCli(
      ["--agent", "agent-123", "--stateless", "--memfs", "-p", "Say OK"],
      { expectExit: 1 },
    );
    expect(withMemfs.stderr).toContain(
      "--stateless cannot be used with --memfs",
    );

    const withNewAgent = await runCli(
      ["--new-agent", "--stateless", "-p", "Say OK"],
      { expectExit: 1 },
    );
    expect(withNewAgent.stderr).toContain("--stateless is for existing agents");
  });

  test("--stateless requires an explicit existing-agent selector", async () => {
    const result = await runCli(["--stateless", "-p", "Say OK"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain("--stateless requires --agent");
  });

  test("-C alias for --conversation is accepted", async () => {
    const result = await runCli(["-p", "Say OK", "-C", "conv-123"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Unknown option '-C'");
  });

  test.each([
    ["--import", "test.af"],
    ["--import", "@author/agent"],
    ["--from-af", "test.af"],
    ["--from-af", "@author/agent"],
  ])(
    "%s %s rejects before startup",
    async (flag, value) => {
      const result = await runCli([flag, value, "-p", "Say OK"], {
        expectExit: 1,
      });
      expect(result.stderr).toContain(`Unknown option '${flag}'`);
      expect(result.stderr).not.toContain("Missing LETTA_API_KEY");
    },
    // Let the subprocess deadline fire before Bun's, with time for home cleanup.
    CLI_TIMEOUT_MS + 5_000,
  );

  test("--max-turns and --pre-load-skills are accepted in headless mode", async () => {
    const result = await runCli(
      [
        "--new-agent",
        "-p",
        "Say OK",
        "--max-turns",
        "2",
        "--pre-load-skills",
        "foo,bar",
      ],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Unknown option '--max-turns'");
    expect(result.stderr).not.toContain("Unknown option '--pre-load-skills'");
  });
});

describe("Startup Flow - Subcommand Output", () => {
  test.each([65_535, 65_536, 65_537, 100 * 1024, 1024 * 1024])(
    "preserves a %i-byte MCP response through subprocess capture",
    async (responseSize) => {
      const payload = base64PayloadForResponseSize(responseSize);
      const result = await runMcpEcho(payload);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(Buffer.byteLength(result.stdout)).toBe(responseSize);
      const parsed = JSON.parse(result.stdout);
      const text = parsed.content?.[0]?.text;
      expect(text?.slice(0, 6)).toBe("Echo: ");
      expect(sha256(text?.slice(6) ?? "")).toBe(sha256(result.payload));
    },
    30_000,
  );

  test("keeps ordinary small MCP output unchanged", async () => {
    const result = await runMcpEcho("small");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(expectedMcpEchoStdout(result.payload));
  });

  test("preserves escaped MCP output redirected directly to a file", async () => {
    const result = await runMcpEcho(escapedMcpPayload(100 * 1024), "file");

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.content?.[0]?.text?.length).toBe(result.payload.length + 6);
    expect(sha256(parsed.content?.[0]?.text?.slice(6) ?? "")).toBe(
      sha256(result.payload),
    );
  }, 30_000);

  test("returns an error when the stdout pipe closes early", async () => {
    const result = await runMcpEcho(
      base64PayloadForResponseSize(1024 * 1024),
      "closed-pipe",
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error?.code).toBe("mcp_error");
  }, 30_000);
});
