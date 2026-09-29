import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash } from "@/tools/impl/bash";
import { backgroundProcesses } from "@/tools/impl/process_manager";
import {
  buildPowerShellCommand,
  POWERSHELL_UTF8_OUTPUT_PREFIX,
} from "@/tools/impl/shell-launchers";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
  type ToolReturnContent,
} from "@/tools/manager";
import { createTempRuntimeScriptCommand } from "@/tools/runtime-script";
import {
  extractSecretEnvFromCommand,
  resolveShellSecretArgs,
  scrubSecretsFromString,
} from "@/tools/secret-substitution";
import {
  clearPendingMessages,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import {
  __testSeedSecretsCache,
  clearSecretsCache,
} from "@/utils/secrets-store";

const TEST_AGENT_ID = "agent-shell-secrets";

const seededSecrets = {
  API_KEY: "sk-12345",
  PASSWORD: "he$$o",
  TOKEN: "$foo$bar",
  BACKTICK: "`whoami`",
  PROFILE: "letta",
} as const;

afterEach(() => {
  clearSecretsCache(TEST_AGENT_ID);
  setMessageQueueAdder(null);
  clearPendingMessages();
  for (const processState of backgroundProcesses.values()) {
    try {
      processState.process.kill("SIGKILL");
    } catch {
      // Process group may already be gone.
    }
    if (processState.outputFile) {
      rmSync(processState.outputFile, { force: true });
    }
  }
  backgroundProcesses.clear();
});

const secretEnv = {
  PASSWORD: seededSecrets.PASSWORD,
  BACKTICK: seededSecrets.BACKTICK,
  TOKEN: seededSecrets.TOKEN,
};

function seedSecrets(): void {
  __testSeedSecretsCache(TEST_AGENT_ID, seededSecrets);
}

function literalSecretCommand(): string {
  return process.platform === "win32"
    ? "Write-Output $PASSWORD; Write-Output $BACKTICK; Write-Output $TOKEN"
    : 'printf "%s\\n%s\\n%s" "$PASSWORD" "$BACKTICK" "$TOKEN"';
}

function expectLiteralSecrets(output: string): void {
  expect(output).toContain("he$$o");
  expect(output).toContain("`whoami`");
  expect(output).toContain("$foo$bar");
}

async function waitForFileContent(
  filePath: string,
  predicate: (content: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const content = readFileSync(filePath, "utf8");
    if (predicate(content)) return content;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for background output in ${filePath}`);
}

function toolReturnText(toolReturn: ToolReturnContent): string {
  return typeof toolReturn === "string"
    ? toolReturn
    : toolReturn
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
}

describe("shell secret env extraction", () => {
  test("extracts only referenced known secrets", async () => {
    await seedSecrets();
    expect(
      extractSecretEnvFromCommand("$API_KEY:$PASSWORD:$UNKNOWN", TEST_AGENT_ID),
    ).toEqual({
      API_KEY: seededSecrets.API_KEY,
      PASSWORD: seededSecrets.PASSWORD,
    });
  });

  test("deduplicates repeated references", async () => {
    await seedSecrets();
    expect(
      extractSecretEnvFromCommand("$API_KEY and $API_KEY", TEST_AGENT_ID),
    ).toEqual({
      API_KEY: seededSecrets.API_KEY,
    });
  });

  test("returns empty object when no secrets are referenced", async () => {
    await seedSecrets();
    expect(extractSecretEnvFromCommand("echo hello", TEST_AGENT_ID)).toEqual(
      {},
    );
  });

  test("rejects transient secrets on unbound background shell tools", () => {
    expect(() =>
      resolveShellSecretArgs({
        command: "watch $BROWSER_CONTROL_KEY",
        transientSecretEnv: { BROWSER_CONTROL_KEY: "request-only-key" },
        toolName: "Monitor",
        executionContextId: "context-1",
      }),
    ).toThrow("cannot receive request-scoped secrets");
  });
});

describe("shell secret scrubbing", () => {
  test("replaces secret values with NAME=<REDACTED>", async () => {
    await seedSecrets();
    expect(
      scrubSecretsFromString(`key=${seededSecrets.API_KEY}`, seededSecrets),
    ).toBe("key=API_KEY=<REDACTED>");
  });

  test("scrubs shell-sensitive secret values literally", async () => {
    await seedSecrets();
    expect(
      scrubSecretsFromString(
        `pw=${seededSecrets.PASSWORD} x=${seededSecrets.BACKTICK}`,
        seededSecrets,
      ),
    ).toBe("pw=PASSWORD=<REDACTED> x=BACKTICK=<REDACTED>");
  });
});

describe("shell secret execution", () => {
  test("PowerShell aliases dynamically injected secret env vars", () => {
    const command = buildPowerShellCommand("Write-Output $API_KEY", [
      "API_KEY",
      "BAD;Write-Output pwned",
    ]);

    expect(command).toContain("$API_KEY = $env:API_KEY");
    expect(command).not.toContain("BAD;Write-Output pwned");
    expect(command.startsWith(POWERSHELL_UTF8_OUTPUT_PREFIX)).toBe(true);
    expect(command.endsWith("Write-Output $API_KEY")).toBe(true);
  });

  test("Bash expands injected secret env values literally", async () => {
    const result = await bash({
      command: literalSecretCommand(),
      description: "Test secret env expansion",
      secretEnv,
    });

    expect(result.status).toBe("success");
    expectLiteralSecrets(result.content[0]?.text ?? "");
  });

  test("does not scrub an unused low-entropy secret", async () => {
    await seedSecrets();
    const context = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
      {
        runtimeContext: {
          agentId: TEST_AGENT_ID,
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
      },
    );

    try {
      const command =
        process.platform === "win32" ? "Write-Output letta" : "printf letta";
      const result = await executeTool(
        "Bash",
        { command, description: "Print ordinary text" },
        { toolContextId: context.contextId },
      );

      expect(result.status).toBe("success");
      expect(toolReturnText(result.toolReturn)).toContain("letta");
      expect(toolReturnText(result.toolReturn)).not.toContain(
        "PROFILE=<REDACTED>",
      );
    } finally {
      releaseToolExecutionContext(context.contextId);
    }
  });

  test("keeps background output scoped to the launch secrets", async () => {
    await seedSecrets();
    const context = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
      {
        runtimeContext: {
          agentId: TEST_AGENT_ID,
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
      },
    );

    const runtimeScript = createTempRuntimeScriptCommand(
      "const value = process.env.PASSWORD ?? ''; process.stdout.write(value.slice(0, 2)); setTimeout(() => process.stdout.write(value.slice(2)), 25)",
    );
    try {
      const launched = await executeTool(
        "Bash",
        {
          command: `${runtimeScript.command} $PASSWORD`,
          description: "Print a split background secret",
          run_in_background: true,
        },
        { toolContextId: context.contextId },
      );
      const launchedText = toolReturnText(launched.toolReturn);
      const taskId = launchedText.match(/ID: (bash_\d+)/)?.[1];
      const outputFile = launchedText.match(/Output file: (.+)/)?.[1];
      expect(taskId).toBeString();
      expect(outputFile).toBeString();

      const output = await waitForFileContent(outputFile as string, (content) =>
        content.includes("PASSWORD=<REDACTED>"),
      );
      expect(output).toContain("PASSWORD=<REDACTED>");
      expect(output).not.toContain(seededSecrets.PASSWORD);
    } finally {
      releaseToolExecutionContext(context.contextId);
      runtimeScript.cleanup();
    }
  });

  test.skipIf(process.platform === "win32")(
    "kills a transient-secret Bash process group after its shell parent exits",
    async () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "transient-bash-"));
      const actionFile = join(fixtureDir, "action.txt");
      const runtimeScript = createTempRuntimeScriptCommand(
        `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(actionFile)}, process.env.BROWSER_CONTROL_KEY ?? "missing"), 600)`,
      );
      const queued: unknown[] = [];
      setMessageQueueAdder((message) => queued.push(message));
      const context = await prepareToolExecutionContextForSpecificTools(
        ["Bash"],
        {
          runtimeContext: {
            agentId: TEST_AGENT_ID,
            workingDirectory: process.cwd(),
            transientSecretEnv: { BROWSER_CONTROL_KEY: "request-only-key" },
          },
          workingDirectory: process.cwd(),
        },
      );

      try {
        const launched = await executeTool(
          "Bash",
          {
            command: `BROWSER_CONTROL_KEY="$BROWSER_CONTROL_KEY" ${runtimeScript.command} >/dev/null 2>&1 &`,
            description: "Schedule a delayed transient action",
            run_in_background: true,
          },
          { toolContextId: context.contextId },
        );
        const taskId = toolReturnText(launched.toolReturn).match(
          /ID: (bash_\d+)/,
        )?.[1];
        expect(taskId).toBeString();

        // The shell parent exits immediately, but its detached process group
        // still contains the delayed child and must remain bound to the context.
        const deadline = Date.now() + 2_000;
        while (
          taskId &&
          backgroundProcesses.get(taskId)?.status === "running" &&
          Date.now() < deadline
        ) {
          await Bun.sleep(10);
        }
        expect(backgroundProcesses.get(taskId as string)?.status).not.toBe(
          "running",
        );

        releaseToolExecutionContext(context.contextId);
        await Bun.sleep(750);
        expect(existsSync(actionFile)).toBe(false);
        // Completion may have raced before cleanup because the shell parent was
        // already done, but cleanup itself must never add another notification.
        expect(queued.length).toBeLessThanOrEqual(1);
      } finally {
        releaseToolExecutionContext(context.contextId);
        runtimeScript.cleanup();
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  test("kills transient-secret exec_command after automatic yield without notifying", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "transient-exec-"));
    const actionFile = join(fixtureDir, "action.txt");
    const runtimeScript = createTempRuntimeScriptCommand(
      `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(actionFile)}, process.env.BROWSER_CONTROL_KEY ?? "missing"), 700)`,
    );
    const queued: unknown[] = [];
    setMessageQueueAdder((message) => queued.push(message));
    const context = await prepareToolExecutionContextForSpecificTools(
      ["exec_command"],
      {
        runtimeContext: {
          agentId: TEST_AGENT_ID,
          workingDirectory: process.cwd(),
          transientSecretEnv: { BROWSER_CONTROL_KEY: "request-only-key" },
        },
        workingDirectory: process.cwd(),
      },
    );

    try {
      const launched = await executeTool(
        "exec_command",
        {
          cmd: `${runtimeScript.command} $BROWSER_CONTROL_KEY`,
          description: "Schedule a yielded transient action",
          yield_time_ms: 250,
        },
        { toolContextId: context.contextId },
      );
      expect(toolReturnText(launched.toolReturn)).toContain(
        "Process running with session ID",
      );

      releaseToolExecutionContext(context.contextId);
      await Bun.sleep(850);
      expect(existsSync(actionFile)).toBe(false);
      expect(queued).toHaveLength(0);
    } finally {
      releaseToolExecutionContext(context.contextId);
      runtimeScript.cleanup();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "does not bind ordinary persisted-secret background work to context release",
    async () => {
      await seedSecrets();
      const fixtureDir = mkdtempSync(join(tmpdir(), "persisted-bash-"));
      const actionFile = join(fixtureDir, "action.txt");
      const runtimeScript = createTempRuntimeScriptCommand(
        `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(actionFile)}, process.env.PASSWORD ?? "missing"), 300)`,
      );
      const context = await prepareToolExecutionContextForSpecificTools(
        ["Bash"],
        {
          runtimeContext: {
            agentId: TEST_AGENT_ID,
            workingDirectory: process.cwd(),
          },
          workingDirectory: process.cwd(),
        },
      );

      try {
        await executeTool(
          "Bash",
          {
            command: `PASSWORD="$PASSWORD" ${runtimeScript.command}`,
            description: "Run ordinary secret background work",
            run_in_background: true,
          },
          { toolContextId: context.contextId },
        );
        releaseToolExecutionContext(context.contextId);
        await Bun.sleep(500);
        expect(readFileSync(actionFile, "utf8")).toBe(seededSecrets.PASSWORD);
      } finally {
        releaseToolExecutionContext(context.contextId);
        runtimeScript.cleanup();
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  test("executeTool injects and scrubs referenced shell secrets", async () => {
    await seedSecrets();
    const command = literalSecretCommand();
    const context = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
      {
        runtimeContext: {
          agentId: TEST_AGENT_ID,
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
      },
    );

    try {
      const calls = [
        ["Bash", { command, description: "Test shell secrets" }],
      ] as const;

      for (const [toolName, args] of calls) {
        const result = await executeTool(toolName, args, {
          toolContextId: context.contextId,
        });
        const output = toolReturnText(result.toolReturn);

        expect(result.status).toBe("success");
        expect(output).toContain("PASSWORD=<REDACTED>");
        expect(output).toContain("BACKTICK=<REDACTED>");
        expect(output).toContain("TOKEN=<REDACTED>");
        expect(output).not.toContain(seededSecrets.PASSWORD);
        expect(output).not.toContain(seededSecrets.BACKTICK);
        expect(output).not.toContain(seededSecrets.TOKEN);
      }
    } finally {
      releaseToolExecutionContext(context.contextId);
    }
  });
});
