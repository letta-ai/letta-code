import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LETTA_CHAT_API_KEYS_URL } from "@/cli/helpers/app-urls";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

/**
 * Startup flow tests that validate flag conflict handling.
 *
 * These must remain runnable in fork PR CI (no secrets), so they should not
 * require a working Letta server or LETTA_API_KEY.
 */

const projectRoot = process.cwd();

async function runCli(
  args: string[],
  options: {
    timeoutMs?: number;
    expectExit?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { timeoutMs = 30000, expectExit } = options;
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

  test("--conversation conflicts with --import", async () => {
    const result = await runCli(
      ["--conversation", "conv-123", "--import", "test.af"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain(
      "--conversation cannot be used with --import",
    );
  });

  test("--conversation conflicts with legacy --from-af using canonical --import error text", async () => {
    const result = await runCli(
      ["--conversation", "conv-123", "--from-af", "test.af"],
      { expectExit: 1 },
    );
    expect(result.stderr).toContain(
      "--conversation cannot be used with --import",
    );
    expect(result.stderr).not.toContain(
      "--conversation cannot be used with --from-af",
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

  test("--import conflicts with --name (including legacy --from-af alias)", async () => {
    const result = await runCli(["--from-af", "test.af", "--name", "MyAgent"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain("--import cannot be used with --name");
    expect(result.stderr).not.toContain("--from-af cannot be used with --name");
  });
});

describe("Startup Flow - Smoke", () => {
  test("update aliases route to manual update instead of flag parsing errors", async () => {
    for (const alias of ["update", "upgrade", "--update", "--upgrade"]) {
      const result = await runCli([alias], { expectExit: 1 });
      expect(result.stdout).toContain(
        "Manual updates are disabled in development mode",
      );
      expect(result.stderr).not.toContain("Unknown option");
    }
  });

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

  test("--import handle is accepted in headless mode", async () => {
    const result = await runCli(["--import", "@author/agent", "-p", "Say OK"], {
      expectExit: 1,
    });
    expect(result.stderr).toContain("Missing LETTA_API_KEY");
    expect(result.stderr).not.toContain("Invalid registry handle");
  });

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
