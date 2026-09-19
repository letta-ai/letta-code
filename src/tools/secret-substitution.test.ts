import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INHERITED_SECRET_NAMES_ENV } from "@/agent/subagents/subagent-launcher";
import type { ModToolEndEvent } from "@/mods/types";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import {
  extractSecretEnvFromCommand,
  getManagedCloudAgentSecretEnv,
  getScopedSecretRedactions,
  scrubSecretsFromString,
} from "@/tools/secret-substitution";
import {
  __testSeedSecretsCache,
  clearSecretsCache,
} from "@/utils/secrets-store";
import { createTempRuntimeScriptCommand } from "./runtime-script";

const AGENT_A = "agent-secret-substitution-a";
const AGENT_B = "agent-secret-substitution-b";
const SECRET_KEY = "WS_SECRET_TOKEN";
const SECRET_A = "scopedsecreta";
const SECRET_B = "scopedsecretb";

function asText(
  toolReturn: Awaited<ReturnType<typeof executeTool>>["toolReturn"],
): string {
  return typeof toolReturn === "string"
    ? toolReturn
    : JSON.stringify(toolReturn);
}

function seedSecret(agentId: string, value: string): void {
  __testSeedSecretsCache(agentId, { [SECRET_KEY]: value });
}

afterEach(() => {
  clearSecretsCache(AGENT_A);
  clearSecretsCache(AGENT_B);
});

describe("scoped secret helpers", () => {
  test("extracts env vars using the explicit agent scope", async () => {
    await seedSecret(AGENT_A, SECRET_A);
    await seedSecret(AGENT_B, SECRET_B);

    expect(extractSecretEnvFromCommand(`echo $${SECRET_KEY}`, AGENT_A)).toEqual(
      {
        [SECRET_KEY]: SECRET_A,
      },
    );
    expect(extractSecretEnvFromCommand(`echo $${SECRET_KEY}`, AGENT_B)).toEqual(
      {
        [SECRET_KEY]: SECRET_B,
      },
    );
  });

  test("extracts env vars from braced shell references", async () => {
    await seedSecret(AGENT_A, SECRET_A);

    const expected = { [SECRET_KEY]: SECRET_A };
    expect(
      extractSecretEnvFromCommand(`echo "\${${SECRET_KEY}}"`, AGENT_A),
    ).toEqual(expected);
    expect(
      extractSecretEnvFromCommand(`[ -z "\${${SECRET_KEY}:-}" ]`, AGENT_A),
    ).toEqual(expected);
    expect(
      extractSecretEnvFromCommand(`echo "\${#${SECRET_KEY}}"`, AGENT_A),
    ).toEqual(expected);
    expect(
      extractSecretEnvFromCommand(`echo "\${!${SECRET_KEY}}"`, AGENT_A),
    ).toEqual(expected);
  });

  test("ignores text without a secret reference outside managed cloud", async () => {
    await seedSecret(AGENT_A, SECRET_A);
    const originalManagedCloudMarker = process.env.LETTA_MANAGED_CLOUD_SANDBOX;
    delete process.env.LETTA_MANAGED_CLOUD_SANDBOX;

    try {
      expect(
        extractSecretEnvFromCommand(`printenv ${SECRET_KEY}`, AGENT_A),
      ).toEqual({});
      expect(
        extractSecretEnvFromCommand(`echo \${lowercase}`, AGENT_A),
      ).toEqual({});
    } finally {
      if (originalManagedCloudMarker !== undefined) {
        process.env.LETTA_MANAGED_CLOUD_SANDBOX = originalManagedCloudMarker;
      }
    }
  });

  test("extracts env vars from command arrays", async () => {
    await seedSecret(AGENT_A, SECRET_A);

    expect(
      extractSecretEnvFromCommand(
        [process.execPath, "-e", "console.log('ok')", `$${SECRET_KEY}`],
        AGENT_A,
      ),
    ).toEqual({
      [SECRET_KEY]: SECRET_A,
    });
  });

  test("injects all scoped secrets only for the managed cloud sandbox", async () => {
    __testSeedSecretsCache(AGENT_A, {
      [SECRET_KEY]: SECRET_A,
      LETTA_API_KEY: "must-not-replace-runtime-auth",
      LETTA_INHERITED_SECRET_NAMES: "must-not-replace-secret-metadata",
      LETTA_MANAGED_CLOUD_SANDBOX: "must-not-replace-cloud-marker",
      LETTA_MEMORY_DIR: "must-not-replace-memory-path",
      PATH: "must-not-replace-platform-path",
      EXISTING_PLATFORM_VALUE: "must-not-replace-ambient",
    });

    const managedEnv = {
      LETTA_MANAGED_CLOUD_SANDBOX: "1",
      EXISTING_PLATFORM_VALUE: "ambient-value",
    };
    expect(getManagedCloudAgentSecretEnv(AGENT_A, managedEnv)).toEqual({
      [SECRET_KEY]: SECRET_A,
    });
    expect(
      getManagedCloudAgentSecretEnv(AGENT_A, {
        ...managedEnv,
        [SECRET_KEY]: SECRET_A,
      }),
    ).toEqual({ [SECRET_KEY]: SECRET_A });
    expect(getManagedCloudAgentSecretEnv(AGENT_B, managedEnv)).toEqual({});
    clearSecretsCache(AGENT_A);
    expect(
      getManagedCloudAgentSecretEnv(AGENT_A, {
        ...managedEnv,
        [INHERITED_SECRET_NAMES_ENV]: JSON.stringify([SECRET_KEY]),
        [SECRET_KEY]: SECRET_A,
      }),
    ).toEqual({ [SECRET_KEY]: SECRET_A });
    expect(
      getManagedCloudAgentSecretEnv(AGENT_A, {
        LETTA_BASE_URL: "https://api.letta.com",
      }),
    ).toEqual({});
  });

  test("scrubs secret values using the explicit agent scope", async () => {
    await seedSecret(AGENT_A, SECRET_A);
    await seedSecret(AGENT_B, SECRET_B);

    expect(scrubSecretsFromString(SECRET_A, { [SECRET_KEY]: SECRET_A })).toBe(
      `${SECRET_KEY}=<REDACTED>`,
    );
    expect(scrubSecretsFromString(SECRET_B, { [SECRET_KEY]: SECRET_A })).toBe(
      SECRET_B,
    );
  });
});

describe("all-tool secret redaction", () => {
  for (const override of [false, true]) {
    test(`redacts Read errors${override ? " after tool_end replacement" : ""}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "letta-error-secret-"));
      seedSecret(AGENT_A, SECRET_A);
      let endEvents = 0;
      const prepared = await prepareToolExecutionContextForSpecificTools(
        ["Read"],
        {
          runtimeContext: { agentId: AGENT_A, workingDirectory: directory },
          workingDirectory: directory,
          ...(override && {
            modEvents: {
              async emit(name, event) {
                if (name === "tool_end") {
                  endEvents++;
                  (
                    event as ModToolEndEvent & {
                      result?: { status: "error"; output: string };
                    }
                  ).result = {
                    status: "error",
                    output: `override:${SECRET_A}`,
                  };
                }
                return { diagnostics: [], handlerCount: 0, name, results: [] };
              },
            },
          }),
        },
      );
      try {
        const result = await executeTool(
          "Read",
          { file_path: join(directory, SECRET_A) },
          { toolContextId: prepared.contextId },
        );
        expect(result.status).toBe("error");
        expect(asText(result.toolReturn)).not.toContain(SECRET_A);
        expect(asText(result.toolReturn)).toContain(`${SECRET_KEY}=<REDACTED>`);
        if (override) {
          expect(endEvents).toBe(1);
          expect(asText(result.toolReturn)).toBe(
            `override:${SECRET_KEY}=<REDACTED>`,
          );
        }
      } finally {
        releaseToolExecutionContext(prepared.contextId);
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("redacts a scoped secret from real Read output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "letta-read-secret-"));
    const file = join(directory, "secret.txt");
    writeFileSync(file, `prefix:${SECRET_A}:suffix`);
    seedSecret(AGENT_A, SECRET_A);
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Read"],
      {
        runtimeContext: { agentId: AGENT_A, workingDirectory: directory },
        workingDirectory: directory,
      },
    );

    try {
      const result = await executeTool(
        "Read",
        { file_path: file },
        { toolContextId: prepared.contextId },
      );
      const text = asText(result.toolReturn);
      expect(text).toContain(`${SECRET_KEY}=<REDACTED>`);
      expect(text).not.toContain(SECRET_A);
    } finally {
      releaseToolExecutionContext(prepared.contextId);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("redaction replacements cannot reintroduce another secret", () => {
    const secrets = {
      SHORT_SECRET: "secret",
      LONG_SECRET: "long-secret",
      PLACEHOLDER_SECRET: "LONG_SECRET=<REDACTED>",
      DIGIT_SECRET: "0",
      FALLBACK_SECRET: "<REDACTED>",
      WORD_SECRET: "REDACTED",
    };
    const output = scrubSecretsFromString(
      "long-secret 0 <REDACTED> REDACTED",
      secrets,
    );
    for (const value of Object.values(secrets))
      expect(output).not.toContain(value);
    expect(output).toBe("   ");
  });

  test("uses ambient runtime scope when executeTool has no explicit context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "letta-read-secret-"));
    const file = join(directory, "secret.txt");
    writeFileSync(file, SECRET_A);
    seedSecret(AGENT_A, SECRET_A);
    const prepared = await prepareToolExecutionContextForSpecificTools([
      "Read",
    ]);
    releaseToolExecutionContext(prepared.contextId);

    try {
      const result = await runWithRuntimeContext(
        { agentId: AGENT_A, workingDirectory: directory },
        () => executeTool("Read", { file_path: file }),
      );
      expect(asText(result.toolReturn)).not.toContain(SECRET_A);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps rotated inherited and current same-name values in redaction scope", () => {
    __testSeedSecretsCache(AGENT_A, {
      [SECRET_KEY]: SECRET_B,
      [`${SECRET_KEY}_INHERITED`]: "collision-value",
    });
    expect(
      getScopedSecretRedactions(AGENT_A, {
        [INHERITED_SECRET_NAMES_ENV]: JSON.stringify([SECRET_KEY]),
        [SECRET_KEY]: SECRET_A,
      }),
    ).toEqual({
      [SECRET_KEY]: SECRET_B,
      [`${SECRET_KEY}_INHERITED`]: "collision-value",
      [`${SECRET_KEY}_INHERITED_INHERITED`]: SECRET_A,
    });
    expect(
      getManagedCloudAgentSecretEnv(AGENT_A, {
        LETTA_MANAGED_CLOUD_SANDBOX: "1",
        [INHERITED_SECRET_NAMES_ENV]: JSON.stringify([SECRET_KEY]),
        [SECRET_KEY]: SECRET_A,
      }),
    ).toEqual({
      [SECRET_KEY]: SECRET_A,
      [`${SECRET_KEY}_INHERITED`]: "collision-value",
    });
  });

  test("includes protected and inherited values in redaction scope", () => {
    __testSeedSecretsCache(AGENT_A, { LETTA_API_KEY: SECRET_A });
    expect(
      getScopedSecretRedactions(AGENT_A, {
        [INHERITED_SECRET_NAMES_ENV]: JSON.stringify([SECRET_KEY]),
        [SECRET_KEY]: SECRET_B,
      }),
    ).toEqual({ [SECRET_KEY]: SECRET_B, LETTA_API_KEY: SECRET_A });
  });
});

describe("managed cloud shell secret execution", () => {
  test("protected managed runtime auth wins over an explicit agent secret", async () => {
    const configuredAgentKey = "configured-agent-runtime-key";
    const managedRuntimeKey = "managed-sandbox-runtime-key";
    __testSeedSecretsCache(AGENT_A, { LETTA_API_KEY: configuredAgentKey });
    const runtimeScript = createTempRuntimeScriptCommand(
      "process.stdout.write(process.env.LETTA_API_KEY ?? '')",
    );
    const originalEnv = {
      marker: process.env.LETTA_MANAGED_CLOUD_SANDBOX,
      apiKey: process.env.LETTA_API_KEY,
    };
    process.env.LETTA_MANAGED_CLOUD_SANDBOX = "1";
    process.env.LETTA_API_KEY = managedRuntimeKey;
    let prepared: Awaited<
      ReturnType<typeof prepareToolExecutionContextForSpecificTools>
    > | null = null;

    try {
      prepared = await prepareToolExecutionContextForSpecificTools(["Bash"], {
        runtimeContext: {
          agentId: AGENT_A,
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
      });
      const result = await executeTool(
        "Bash",
        {
          command: `${runtimeScript.command} $LETTA_API_KEY`,
          timeout: 5000,
        },
        { toolContextId: prepared.contextId },
      );
      const text = asText(result.toolReturn);
      expect(text).toContain("LETTA_API_KEY=<REDACTED>");
      expect(text).not.toContain(configuredAgentKey);
      expect(text).not.toContain(managedRuntimeKey);
      expect(getScopedSecretRedactions(AGENT_A).LETTA_API_KEY).toBe(
        configuredAgentKey,
      );
    } finally {
      if (prepared) releaseToolExecutionContext(prepared.contextId);
      runtimeScript.cleanup();
      for (const [name, value] of [
        ["LETTA_MANAGED_CLOUD_SANDBOX", originalEnv.marker],
        ["LETTA_API_KEY", originalEnv.apiKey],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("local explicit references still use the configured agent secret", () => {
    __testSeedSecretsCache(AGENT_A, { LETTA_API_KEY: SECRET_A });
    expect(extractSecretEnvFromCommand("echo $LETTA_API_KEY", AGENT_A)).toEqual(
      { LETTA_API_KEY: SECRET_A },
    );
  });

  test("injects and scrubs an unreferenced secret in a real child process", async () => {
    seedSecret(AGENT_A, SECRET_A);
    const runtimeScript = createTempRuntimeScriptCommand(
      `process.stdout.write(process.env.${SECRET_KEY} ?? '')`,
    );
    const originalManagedCloudMarker = process.env.LETTA_MANAGED_CLOUD_SANDBOX;
    process.env.LETTA_MANAGED_CLOUD_SANDBOX = "1";
    let prepared: Awaited<
      ReturnType<typeof prepareToolExecutionContextForSpecificTools>
    > | null = null;

    try {
      prepared = await prepareToolExecutionContextForSpecificTools(["Bash"], {
        runtimeContext: {
          agentId: AGENT_A,
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
      });
      const result = await executeTool(
        "Bash",
        { command: runtimeScript.command, timeout: 5000 },
        { toolContextId: prepared.contextId },
      );
      const text = asText(result.toolReturn);
      expect(text).toContain(`${SECRET_KEY}=<REDACTED>`);
      expect(text).not.toContain(SECRET_A);
    } finally {
      if (prepared) releaseToolExecutionContext(prepared.contextId);
      runtimeScript.cleanup();
      if (originalManagedCloudMarker === undefined) {
        delete process.env.LETTA_MANAGED_CLOUD_SANDBOX;
      } else {
        process.env.LETTA_MANAGED_CLOUD_SANDBOX = originalManagedCloudMarker;
      }
    }
  });

  test("cacheless ephemeral scope scrubs its inherited environment snapshot", async () => {
    clearSecretsCache(null);
    const runtimeScript = createTempRuntimeScriptCommand(
      `process.stdout.write(process.env.${SECRET_KEY} ?? '')`,
    );
    const originalEnv = {
      marker: process.env.LETTA_MANAGED_CLOUD_SANDBOX,
      names: process.env[INHERITED_SECRET_NAMES_ENV],
      secret: process.env[SECRET_KEY],
    };
    process.env.LETTA_MANAGED_CLOUD_SANDBOX = "1";
    process.env[INHERITED_SECRET_NAMES_ENV] = JSON.stringify([SECRET_KEY]);
    process.env[SECRET_KEY] = SECRET_A;
    let prepared: Awaited<
      ReturnType<typeof prepareToolExecutionContextForSpecificTools>
    > | null = null;

    try {
      prepared = await prepareToolExecutionContextForSpecificTools(["Bash"], {
        runtimeContext: { workingDirectory: process.cwd() },
        workingDirectory: process.cwd(),
      });
      const result = await executeTool(
        "Bash",
        { command: runtimeScript.command, timeout: 5000 },
        { toolContextId: prepared.contextId },
      );
      const text = asText(result.toolReturn);
      expect(text).toContain(`${SECRET_KEY}=<REDACTED>`);
      expect(text).not.toContain(SECRET_A);
    } finally {
      if (prepared) releaseToolExecutionContext(prepared.contextId);
      runtimeScript.cleanup();
      for (const [name, value] of [
        ["LETTA_MANAGED_CLOUD_SANDBOX", originalEnv.marker],
        [INHERITED_SECRET_NAMES_ENV, originalEnv.names],
        [SECRET_KEY, originalEnv.secret],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("scoped shell secret execution", () => {
  const stringShellTools: Array<{
    name: string;
    toolNames: string[];
    buildArgs: (command: string) => Record<string, unknown>;
  }> = [
    {
      name: "Bash",
      toolNames: ["Bash"],
      buildArgs: (command) => ({ command, timeout: 5000 }),
    },
    {
      name: "shell_command",
      toolNames: ["shell_command"],
      buildArgs: (command) => ({ command, login: false, timeout_ms: 5000 }),
    },
    {
      name: "ShellCommand",
      toolNames: ["ShellCommand"],
      buildArgs: (command) => ({ command, login: false, timeout_ms: 5000 }),
    },
  ];

  for (const tool of stringShellTools) {
    test(`${tool.name} injects and scrubs secrets within a scoped agent context`, async () => {
      await seedSecret(AGENT_A, SECRET_A);
      const runtimeScript = createTempRuntimeScriptCommand(
        `process.stdout.write(process.env.${SECRET_KEY} ?? '')`,
      );
      const prepared = await prepareToolExecutionContextForSpecificTools(
        tool.toolNames,
        {
          runtimeContext: {
            agentId: AGENT_A,
            workingDirectory: process.cwd(),
          },
          workingDirectory: process.cwd(),
        },
      );

      try {
        const result = await executeTool(
          tool.name,
          tool.buildArgs(`${runtimeScript.command} $${SECRET_KEY}`),
          { toolContextId: prepared.contextId },
        );

        const text = asText(result.toolReturn);
        expect(result.status).toBe("success");
        expect(text).toContain(`${SECRET_KEY}=<REDACTED>`);
        expect(text).not.toContain(SECRET_A);
      } finally {
        releaseToolExecutionContext(prepared.contextId);
        runtimeScript.cleanup();
      }
    });
  }

  for (const toolName of ["shell", "Shell"] as const) {
    test(`${toolName} injects secrets for command arrays within a scoped agent context`, async () => {
      await seedSecret(AGENT_A, SECRET_A);
      const prepared = await prepareToolExecutionContextForSpecificTools(
        [toolName],
        {
          runtimeContext: {
            agentId: AGENT_A,
            workingDirectory: process.cwd(),
          },
          workingDirectory: process.cwd(),
        },
      );

      try {
        const result = await executeTool(
          toolName,
          {
            command: [
              process.execPath,
              "-e",
              `process.stdout.write(process.env.${SECRET_KEY} ?? '')`,
              `$${SECRET_KEY}`,
            ],
            timeout_ms: 5000,
          },
          { toolContextId: prepared.contextId },
        );

        const text = asText(result.toolReturn);
        expect(result.status).toBe("success");
        expect(text).toContain(`${SECRET_KEY}=<REDACTED>`);
        expect(text).not.toContain(SECRET_A);
      } finally {
        releaseToolExecutionContext(prepared.contextId);
      }
    });
  }
});
