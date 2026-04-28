import { afterEach, describe, expect, test } from "bun:test";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "../../tools/manager";
import {
  scrubSecretsFromString,
  substituteSecretsInArgs,
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

describe("secret substitution", () => {
  test("uses the explicitly scoped agent id", async () => {
    await seedSecret(AGENT_A, SECRET_A);
    await seedSecret(AGENT_B, SECRET_B);

    expect(
      substituteSecretsInArgs({ command: `echo $${SECRET_KEY}` }, AGENT_A),
    ).toEqual({ command: `echo ${SECRET_A}` });
    expect(
      substituteSecretsInArgs({ command: `echo $${SECRET_KEY}` }, AGENT_B),
    ).toEqual({ command: `echo ${SECRET_B}` });

    expect(scrubSecretsFromString(SECRET_A, AGENT_A)).toBe(
      `${SECRET_KEY}=<REDACTED>`,
    );
    expect(scrubSecretsFromString(SECRET_B, AGENT_A)).toBe(SECRET_B);
  });

  test("substitutes strings recursively in arrays and plain objects", async () => {
    await seedSecret(AGENT_A, SECRET_A);

    expect(
      substituteSecretsInArgs(
        {
          command: [process.execPath, "-e", `console.log('$${SECRET_KEY}')`],
          env_overrides: {
            TOKEN: `$${SECRET_KEY}`,
            nested: [`prefix-$${SECRET_KEY}`],
          },
        },
        AGENT_A,
      ),
    ).toEqual({
      command: [process.execPath, "-e", `console.log('${SECRET_A}')`],
      env_overrides: {
        TOKEN: SECRET_A,
        nested: [`prefix-${SECRET_A}`],
      },
    });
  });
});

describe("shell tool secret substitution", () => {
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
    test(`${tool.name} substitutes and scrubs scoped secrets`, async () => {
      await seedSecret(AGENT_A, SECRET_A);
      const runtimeScript = createTempRuntimeScriptCommand(
        "process.stdout.write(process.argv[2] ?? '')",
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

  for (const toolName of ["shell", "Shell"]) {
    test(`${toolName} substitutes secrets inside command arrays`, async () => {
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
              "process.stdout.write(process.argv[1] ?? '')",
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
