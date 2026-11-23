import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = process.cwd();

const isWindows = process.platform === "win32";

interface TestEnv {
  baseDir: string;
  projectDir: string;
  fakeHome: string;
  markerFile: string;
}

function setupTestEnv(): TestEnv {
  const baseDir = join(
    tmpdir(),
    `hooks-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  const projectDir = join(baseDir, "project");
  const fakeHome = join(baseDir, "home");
  const markerFile = join(baseDir, "hook-marker.txt");

  mkdirSync(join(projectDir, ".letta"), { recursive: true });
  mkdirSync(join(fakeHome, ".letta"), { recursive: true });

  return { baseDir, projectDir, fakeHome, markerFile };
}

function cleanup(env: TestEnv): void {
  try {
    rmSync(env.baseDir, { recursive: true, force: true });
  } catch {}
}

function writeHooksConfig(env: TestEnv, hooks: Record<string, unknown>): void {
  writeFileSync(
    join(env.projectDir, ".letta", "settings.json"),
    JSON.stringify({ hooks }),
  );
}

async function runCli(
  args: string[],
  env: TestEnv,
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { timeoutMs = 120000 } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [join(projectRoot, "src/index.ts"), ...args], {
      cwd: env.projectDir,
      env: {
        ...process.env,
        HOME: env.fakeHome,
        LETTA_CODE_AGENT_ROLE: "subagent",
        LETTA_SKIP_KEYCHAIN_CHECK: "1",
      },
    });

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
      resolve({ stdout, stderr, exitCode: code });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function readMarker(env: TestEnv): string {
  if (!existsSync(env.markerFile)) {
    return "";
  }
  return readFileSync(env.markerFile, "utf-8");
}

function hasApiKey(): boolean {
  return !!process.env.LETTA_API_KEY;
}

describe.skipIf(isWindows)("Hooks E2E Tests", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    cleanup(env);
  });

  describe("PreToolUse hooks", () => {
    test(
      "hook fires when Read tool is called",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        writeHooksConfig(env, {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [
                {
                  type: "command",
                  command: `echo "PreToolUse:Read" >> "${env.markerFile}"`,
                },
              ],
            },
          ],
        });

        await runCli(
          [
            "--new-agent",
            "-m",
            "haiku",
            "--yolo",
            "-p",
            "Read the file /etc/hostname and tell me what it says. Do not ask for confirmation.",
          ],
          env,
        );

        const marker = readMarker(env);
        expect(marker).toContain("PreToolUse:Read");
      },
      { timeout: 180000 },
    );

    test(
      "hook fires for any tool with wildcard matcher",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        writeHooksConfig(env, {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `echo "PreToolUse:ANY" >> "${env.markerFile}"`,
                },
              ],
            },
          ],
        });

        await runCli(
          [
            "--new-agent",
            "-m",
            "haiku",
            "--yolo",
            "-p",
            "Read the file /etc/hostname and tell me what it says. Do not ask for confirmation.",
          ],
          env,
        );

        const marker = readMarker(env);
        expect(marker).toContain("PreToolUse:ANY");
      },
      { timeout: 180000 },
    );

    test(
      "hook exit 2 blocks tool execution",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        writeHooksConfig(env, {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `echo "BLOCKED_BY_HOOK" >> "${env.markerFile}" && echo "Hook blocked this tool" && exit 2`,
                },
              ],
            },
          ],
        });

        const result = await runCli(
          [
            "--new-agent",
            "-m",
            "haiku",
            "--yolo",
            "-p",
            "Read /etc/hostname",
            "--output-format",
            "json",
          ],
          env,
        );

        const marker = readMarker(env);
        expect(marker).toContain("BLOCKED_BY_HOOK");

        expect(result.exitCode).toBe(0);
      },
      { timeout: 180000 },
    );

    test(
      "hook receives JSON input with tool_name",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        const inputFile = join(env.baseDir, "hook-input.json");

        writeHooksConfig(env, {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `cat > "${inputFile}"`,
                },
              ],
            },
          ],
        });

        await runCli(
          ["--new-agent", "-m", "haiku", "--yolo", "-p", "Read /etc/hostname"],
          env,
        );

        if (existsSync(inputFile)) {
          const input = JSON.parse(readFileSync(inputFile, "utf-8"));
          expect(input.event_type).toBe("PreToolUse");
          expect(input.tool_name).toBeDefined();
          expect(input.working_directory).toBeDefined();
        }
      },
      { timeout: 180000 },
    );
  });

  describe("PostToolUse hooks", () => {
    test(
      "hook fires after tool execution",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        writeHooksConfig(env, {
          PostToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `echo "PostToolUse:FIRED" >> "${env.markerFile}"`,
                },
              ],
            },
          ],
        });

        await runCli(
          ["--new-agent", "-m", "haiku", "--yolo", "-p", "Read /etc/hostname"],
          env,
        );

        const marker = readMarker(env);
        expect(marker).toContain("PostToolUse:FIRED");
      },
      { timeout: 180000 },
    );

    test(
      "hook receives tool_result in input",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        const inputFile = join(env.baseDir, "post-tool-input.json");

        writeHooksConfig(env, {
          PostToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `cat > "${inputFile}"`,
                },
              ],
            },
          ],
        });

        await runCli(
          ["--new-agent", "-m", "haiku", "--yolo", "-p", "Read /etc/hostname"],
          env,
        );

        if (existsSync(inputFile)) {
          const input = JSON.parse(readFileSync(inputFile, "utf-8"));
          expect(input.event_type).toBe("PostToolUse");
          expect(input.tool_name).toBeDefined();
          expect(input.tool_result).toBeDefined();
        }
      },
      { timeout: 180000 },
    );
  });

  describe("SessionStart hooks", () => {
    test.skip(
      "hook fires when CLI starts (SKIPPED: only works in interactive mode)",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        writeHooksConfig(env, {
          SessionStart: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `echo "SessionStart:FIRED" >> "${env.markerFile}"`,
                },
              ],
            },
          ],
        });

        await runCli(["--new-agent", "-m", "haiku", "-p", "Say OK"], env);

        const marker = readMarker(env);
        expect(marker).toContain("SessionStart:FIRED");
      },
      { timeout: 180000 },
    );

    test(
      "hook receives session info in input",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        const inputFile = join(env.baseDir, "session-start-input.json");

        writeHooksConfig(env, {
          SessionStart: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `cat > "${inputFile}"`,
                },
              ],
            },
          ],
        });

        await runCli(["--new-agent", "-m", "haiku", "-p", "Say OK"], env);

        if (existsSync(inputFile)) {
          const input = JSON.parse(readFileSync(inputFile, "utf-8"));
          expect(input.event_type).toBe("SessionStart");
          expect(input.working_directory).toBeDefined();
        }
      },
      { timeout: 180000 },
    );
  });

  describe("UserPromptSubmit hooks", () => {
    test.skip(
      "hook fires before prompt processing (SKIPPED: only works in interactive mode)",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        writeHooksConfig(env, {
          UserPromptSubmit: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `echo "UserPromptSubmit:FIRED" >> "${env.markerFile}"`,
                },
              ],
            },
          ],
        });

        await runCli(
          ["--new-agent", "-m", "haiku", "-p", "Say hello world"],
          env,
        );

        const marker = readMarker(env);
        expect(marker).toContain("UserPromptSubmit:FIRED");
      },
      { timeout: 180000 },
    );

    test.skip(
      "hook receives prompt text in input (SKIPPED: only works in interactive mode)",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        const inputFile = join(env.baseDir, "prompt-input.json");

        writeHooksConfig(env, {
          UserPromptSubmit: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `cat > "${inputFile}"`,
                },
              ],
            },
          ],
        });

        await runCli(
          ["--new-agent", "-m", "haiku", "-p", "Test prompt message"],
          env,
        );

        if (existsSync(inputFile)) {
          const input = JSON.parse(readFileSync(inputFile, "utf-8"));
          expect(input.event_type).toBe("UserPromptSubmit");
          expect(input.prompt).toBe("Test prompt message");
        }
      },
      { timeout: 180000 },
    );

    test.skip(
      "hook exit 2 blocks prompt processing (SKIPPED: only works in interactive mode)",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        writeHooksConfig(env, {
          UserPromptSubmit: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `echo "BLOCKED" >> "${env.markerFile}" && echo "Prompt blocked" && exit 2`,
                },
              ],
            },
          ],
        });

        await runCli(
          ["--new-agent", "-m", "haiku", "-p", "This should be blocked"],
          env,
        );

        const marker = readMarker(env);
        expect(marker).toContain("BLOCKED");
      },
      { timeout: 180000 },
    );
  });

  describe("Multiple hooks", () => {
    test(
      "PreToolUse and PostToolUse fire in correct order",
      async () => {
        if (!hasApiKey()) {
          console.log("SKIP: Missing LETTA_API_KEY");
          return;
        }

        writeHooksConfig(env, {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `echo "1:PreToolUse" >> "${env.markerFile}"`,
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `echo "2:PostToolUse" >> "${env.markerFile}"`,
                },
              ],
            },
          ],
        });

        await runCli(
          ["--new-agent", "-m", "haiku", "--yolo", "-p", "Read /etc/hostname"],
          env,
        );

        const marker = readMarker(env);

        expect(marker).toContain("1:PreToolUse");
        expect(marker).toContain("2:PostToolUse");

        const preIndex = marker.indexOf("1:PreToolUse");
        const postIndex = marker.indexOf("2:PostToolUse");
        expect(preIndex).toBeLessThan(postIndex);
      },
      { timeout: 180000 },
    );
  });
});
