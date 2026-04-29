import { afterEach, describe, expect, test } from "bun:test";
import { bash } from "../../tools/impl/Bash";
import { run_shell_command } from "../../tools/impl/RunShellCommandGemini";
import { shell_command } from "../../tools/impl/ShellCommand.js";
import { buildPowerShellCommand } from "../../tools/impl/shellLaunchers";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
  type ToolReturnContent,
} from "../../tools/manager";
import {
  extractSecretEnvFromCommand,
  scrubSecretsFromString,
} from "../../tools/secret-substitution";
import {
  clearSecretsCache,
  initSecretsFromServer,
} from "../../utils/secretsStore";

const TEST_AGENT_ID = "agent-shell-secrets";

const seededSecrets = {
  API_KEY: "sk-12345",
  PASSWORD: "he$$o",
  TOKEN: "$foo$bar",
  BACKTICK: "`whoami`",
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
      scrubSecretsFromString(`key=${seededSecrets.API_KEY}`, TEST_AGENT_ID),
    ).toBe("key=API_KEY=<REDACTED>");
  });

  test("scrubs shell-sensitive secret values literally", async () => {
    await seedSecrets();
    expect(
      scrubSecretsFromString(
        `pw=${seededSecrets.PASSWORD} x=${seededSecrets.BACKTICK}`,
        TEST_AGENT_ID,
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
        ["shell_command", { command }],
        ["ShellCommand", { command }],
        ["run_shell_command", { command }],
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
