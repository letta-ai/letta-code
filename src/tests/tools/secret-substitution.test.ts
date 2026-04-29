import { afterEach, describe, expect, test } from "bun:test";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "../../tools/manager";
import {
  extractSecretEnvFromCommand,
  scrubSecretsFromString,
} from "../../tools/secret-substitution";
import {
  clearSecretsCache,
  initSecretsFromServer,
} from "../../utils/secretsStore";
import { createTempRuntimeScriptCommand } from "./runtimeScript";

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

async function seedSecret(agentId: string, value: string): Promise<void> {
  await initSecretsFromServer(agentId, {
    secrets: [{ key: SECRET_KEY, value }],
  });
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

    expect(scrubSecretsFromString(SECRET_A, AGENT_A)).toBe(
      `${SECRET_KEY}=<REDACTED>`,
    );
    expect(scrubSecretsFromString(SECRET_B, AGENT_A)).toBe(SECRET_B);
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
