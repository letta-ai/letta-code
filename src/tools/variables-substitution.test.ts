import { afterEach, expect, test } from "bun:test";
import {
  __testSeedSecretsCache,
  clearSecretsCache,
} from "@/utils/secrets-store";
import {
  __testOverrideVariablesRequest,
  ensureVariablesLoaded,
} from "@/utils/variables-store";
import {
  captureSecretRedactions,
  extractSecretEnvFromCommand,
  resolveVariableEnvFromCommand,
  scrubOutgoingMessageContent,
  scrubSecretsFromString,
} from "./secret-substitution";

const id = "agent-plain-variable-test";
afterEach(() => {
  __testOverrideVariablesRequest(null);
  clearSecretsCache(id);
});

test.skipIf(process.platform === "win32")(
  "variables enter the shell environment without redacting output or user messages",
  async () => {
    __testOverrideVariablesRequest(
      async <T>() => [{ key: "USERNAME", value: "example-account" }] as T,
    );
    __testSeedSecretsCache(id, {});
    await ensureVariablesLoaded(id);
    const variables = await resolveVariableEnvFromCommand(
      'printf "%s" "$USERNAME"',
      id,
    );
    const secrets = extractSecretEnvFromCommand("$USERNAME", id);
    const result = Bun.spawnSync(["sh", "-c", 'printf "%s" "$USERNAME"'], {
      env: { ...process.env, ...variables, ...secrets },
    });
    const output = result.stdout.toString();
    expect(output).toBe("example-account");
    expect(
      scrubSecretsFromString(output, captureSecretRedactions(id, secrets), id),
    ).toBe(output);
    expect(scrubOutgoingMessageContent(output, id)).toBe(output);
  },
);

test("a secret wins when a variable has the same name", async () => {
  __testOverrideVariablesRequest(
    async <T>() => [{ key: "USERNAME", value: "plain-account" }] as T,
  );
  __testSeedSecretsCache(id, { USERNAME: "secret-account" });
  const variables = await resolveVariableEnvFromCommand("$USERNAME", id);
  const secrets = extractSecretEnvFromCommand("$USERNAME", id);
  expect({ ...variables, ...secrets }).toEqual({ USERNAME: "secret-account" });
  expect(
    scrubSecretsFromString(
      "plain-account secret-account",
      captureSecretRedactions(id, secrets),
      id,
    ),
  ).toBe("plain-account USERNAME=<REDACTED>");
});

test.skipIf(process.platform === "win32")(
  "shell tool output retains plain values while scrubbing secrets",
  async () => {
    const { exec_command, __clearExecSessionsForTests } = await import(
      "@/tools/impl/exec-command"
    );
    try {
      const result = await exec_command({
        cmd: 'printf "%s %s" "$USERNAME" "$PASSWORD"',
        login: false,
        variableEnv: { USERNAME: "example-account" },
        secretEnv: { PASSWORD: "credential-value" },
        yield_time_ms: 1000,
      });
      const text = JSON.stringify(result);
      expect(text).toContain("example-account");
      expect(text).not.toContain("credential-value");
      expect(text).toContain("REDACTED");
    } finally {
      __clearExecSessionsForTests();
    }
  },
);
