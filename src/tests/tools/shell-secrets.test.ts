import { afterAll, describe, expect, mock, test } from "bun:test";
import { bash } from "../../tools/impl/Bash";
import { run_shell_command } from "../../tools/impl/RunShellCommandGemini";
import { shell_command } from "../../tools/impl/ShellCommand.js";
import { buildPowerShellCommand } from "../../tools/impl/shellLaunchers";
import {
  extractSecretEnvFromCommand,
  scrubSecretsFromString,
} from "../../tools/secret-substitution";

const mockSecrets: Record<string, string> = {
  API_KEY: "sk-12345",
  PASSWORD: "he$$o",
  TOKEN: "$foo$bar",
  EMPTY: "",
  BACKTICK: "`whoami`",
};

mock.module("../../utils/secretsStore", () => ({
  loadSecrets: () => mockSecrets,
}));

afterAll(() => {
  mock.restore();
});

const secretEnv = {
  PASSWORD: "he$$o",
  BACKTICK: "`whoami`",
  TOKEN: "$foo$bar",
};

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

describe("shell secret env extraction", () => {
  test("extracts only referenced known secrets", () => {
    expect(
      extractSecretEnvFromCommand("$API_KEY:$PASSWORD:$UNKNOWN:$EMPTY"),
    ).toEqual({
      API_KEY: "sk-12345",
      PASSWORD: "he$$o",
      EMPTY: "",
    });
  });

  test("deduplicates repeated references", () => {
    expect(extractSecretEnvFromCommand("$API_KEY and $API_KEY")).toEqual({
      API_KEY: "sk-12345",
    });
  });

  test("returns empty object when no secrets are referenced", () => {
    expect(extractSecretEnvFromCommand("echo hello")).toEqual({});
  });
});

describe("shell secret scrubbing", () => {
  test("replaces secret values with NAME=<REDACTED>", () => {
    expect(scrubSecretsFromString("key=sk-12345")).toBe(
      "key=API_KEY=<REDACTED>",
    );
  });

  test("scrubs shell-sensitive secret values literally", () => {
    expect(scrubSecretsFromString("pw=he$$o x=`whoami`")).toBe(
      "pw=PASSWORD=<REDACTED> x=BACKTICK=<REDACTED>",
    );
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
});
