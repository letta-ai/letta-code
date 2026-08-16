import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bash } from "@/tools/impl/bash";
import { run_shell_command } from "@/tools/impl/run-shell-command-gemini";
import { shell_command } from "@/tools/impl/shell-command.js";
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
  scrubSecretsFromString,
} from "@/tools/secret-substitution";
import {
  clearSecretsCache,
  initSecretsFromServer,
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
});

const secretEnv = {
  PASSWORD: seededSecrets.PASSWORD,
  BACKTICK: seededSecrets.BACKTICK,
  TOKEN: seededSecrets.TOKEN,
};

async function seedSecrets(): Promise<void> {
  await initSecretsFromServer(TEST_AGENT_ID, {
    secrets: Object.entries(seededSecrets).map(([key, value]) => ({
      key,
      value,
    })),
  });
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

  test("shell_command expands injected secret env values literally", async () => {
    const result = await shell_command({
      command: literalSecretCommand(),
      secretEnv,
    });

    expectLiteralSecrets(result.output);
  });

  test("run_shell_command expands injected secret env values literally", async () => {
    const result = await run_shell_command({
      command: literalSecretCommand(),
      secretEnv,
    });

    expectLiteralSecrets(result.message);
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
      ["Bash", "TaskOutput"],
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

      const completed = await executeTool(
        "TaskOutput",
        { task_id: taskId, block: true, timeout: 5000 },
        { toolContextId: context.contextId },
      );
      const output = toolReturnText(completed.toolReturn);
      expect(output).toContain("PASSWORD=<REDACTED>");
      expect(output).not.toContain(seededSecrets.PASSWORD);
      expect(readFileSync(outputFile as string, "utf8")).not.toContain(
        seededSecrets.PASSWORD,
      );
    } finally {
      releaseToolExecutionContext(context.contextId);
      runtimeScript.cleanup();
    }
  });

  test("executeTool injects and scrubs referenced shell secrets", async () => {
    await seedSecrets();
    const command = literalSecretCommand();
    const context = await prepareToolExecutionContextForSpecificTools(
      ["Bash", "shell_command", "ShellCommand", "run_shell_command"],
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
        ["shell_command", { command, description: "Test shell secrets" }],
        ["ShellCommand", { command, description: "Test shell secrets" }],
        ["run_shell_command", { command, description: "Test shell secrets" }],
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
