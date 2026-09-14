import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { settingsManager } from "@/settings-manager";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import {
  extractSecretEnvFromCommand,
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
  test("never injects an existing reserved key from strings or arrays", async () => {
    await initSecretsFromServer(AGENT_A, {
      secrets: [
        { key: "LETTA_API_KEY", value: "old-agent-secret" },
        { key: "LETTA_OTHER_KEY", value: "allowed" },
      ],
    });
    for (const command of [
      `$LETTA_API_KEY \${LETTA_API_KEY:-} $LETTA_OTHER_KEY`,
      ["$LETTA_API_KEY", `\${LETTA_API_KEY}`, "$LETTA_OTHER_KEY"],
    ]) {
      expect(extractSecretEnvFromCommand(command, AGENT_A)).toEqual({
        LETTA_OTHER_KEY: "allowed",
      });
    }
  });

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

  test("ignores text without a secret reference", async () => {
    await seedSecret(AGENT_A, SECRET_A);

    expect(
      extractSecretEnvFromCommand(`printenv ${SECRET_KEY}`, AGENT_A),
    ).toEqual({});
    expect(extractSecretEnvFromCommand(`echo \${lowercase}`, AGENT_A)).toEqual(
      {},
    );
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

describe("scoped shell secret execution", () => {
  const stringShellTools: Array<{
    name: string;
    toolNames: string[];
    buildArgs: (command: string) => Record<string, unknown>;
  }> = [
    {
      name: "exec_command",
      toolNames: ["exec_command"],
      buildArgs: (cmd) => ({ cmd, login: false, yield_time_ms: 1000 }),
    },
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
    {
      name: "run_shell_command",
      toolNames: ["run_shell_command"],
      buildArgs: (command) => ({ command, timeout_ms: 5000 }),
    },
    {
      name: "RunShellCommand",
      toolNames: ["RunShellCommand"],
      buildArgs: (command) => ({ command, timeout_ms: 5000 }),
    },
  ];

  for (const tool of stringShellTools) {
    test(`${tool.name} preserves runtime credentials over stored agent secrets`, async () => {
      const originalKey = process.env.LETTA_API_KEY;
      const settingsSpy = spyOn(settingsManager, "getSettings");
      await initSecretsFromServer(AGENT_A, {
        secrets: [{ key: "LETTA_API_KEY", value: "old-agent-secret" }],
      });
      const prepared = await prepareToolExecutionContextForSpecificTools(
        tool.toolNames,
        {
          runtimeContext: { agentId: AGENT_A, workingDirectory: process.cwd() },
          workingDirectory: process.cwd(),
        },
      );
      try {
        for (const source of ["environment", "settings", "absent"]) {
          delete process.env.LETTA_API_KEY;
          settingsSpy.mockReturnValue({
            lastAgent: null,
            tokenStreaming: false,
            reasoningTabCycleEnabled: false,
            sessionContextEnabled: false,
            autoConversationTitles: false,
            autoSwapOnQuotaLimit: false,
            includeWorktreeTool: false,
            recentModels: [],
            memoryReminderInterval: null,
            reflectionTrigger: "off",
            reflectionStepCount: 25,
            reflectionMerge: "auto",
            reflectionMergeInstructions: "",
            conversationSwitchAlertEnabled: false,
            env:
              source === "settings"
                ? { LETTA_API_KEY: "runtime-test-key" }
                : {},
          });
          if (source === "environment")
            process.env.LETTA_API_KEY = "runtime-test-key";
          const runtimeScript = createTempRuntimeScriptCommand(
            `process.stdout.write(process.env.LETTA_API_KEY === ${source === "absent" ? "undefined" : JSON.stringify("runtime-test-key")} ? 'credential-preserved' : 'wrong-credential')`,
          );
          try {
            const result = await executeTool(
              tool.name,
              tool.buildArgs(`${runtimeScript.command} $LETTA_API_KEY`),
              { toolContextId: prepared.contextId },
            );
            expect(result.status).toBe("success");
            expect(asText(result.toolReturn)).toContain("credential-preserved");
          } finally {
            runtimeScript.cleanup();
          }
        }
      } finally {
        settingsSpy.mockRestore();
        if (originalKey === undefined) delete process.env.LETTA_API_KEY;
        else process.env.LETTA_API_KEY = originalKey;
        releaseToolExecutionContext(prepared.contextId);
      }
    });

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
