import { afterEach, expect, test } from "bun:test";
import {
  __testSeedSecretsCache,
  clearSecretsCache,
} from "@/utils/secrets-store";
import {
  __testOverrideVariablesBackend,
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
  __testOverrideVariablesBackend(null);
  clearSecretsCache(id);
});

test.skipIf(process.platform === "win32")(
  "variables enter the shell environment without redacting output or user messages",
  async () => {
    __testOverrideVariablesBackend({
      retrieveAgent: async () => ({
        variables: [{ key: "USERNAME", value: "example-account" }],
      }),
    });
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
  __testOverrideVariablesBackend({
    retrieveAgent: async () => ({
      variables: [{ key: "USERNAME", value: "plain-account" }],
    }),
  });
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
        cmd: 'printf "%s %s" "$AGENT_USERNAME" "$PASSWORD"',
        login: false,
        variableEnv: { AGENT_USERNAME: "example-account" },
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

test("subagents inherit parent variables with secret precedence", async () => {
  const { __testSetBackend } = await import("@/backend");
  const { resolveShellEnvironment } = await import("./secret-substitution");
  const parent = "agent-variable-parent";
  const child = "agent-variable-child";
  const previousRole = process.env.LETTA_CODE_AGENT_ROLE;
  const previousParent = process.env.LETTA_PARENT_AGENT_ID;
  process.env.LETTA_CODE_AGENT_ROLE = "subagent";
  process.env.LETTA_PARENT_AGENT_ID = parent;
  __testSetBackend({
    retrieveAgent: async (id: string) => ({
      tags: id === child ? ["role:subagent", `parent:${parent}`] : [],
    }),
  } as unknown as import("@/backend").Backend);
  __testSeedSecretsCache(child, {});
  __testSeedSecretsCache(parent, { PASSWORD: "parent-credential" });
  __testOverrideVariablesBackend({
    retrieveAgent: async (agentId: string) => ({
      variables:
        agentId === parent
          ? [{ key: "USERNAME", value: "parent-account" }]
          : [{ key: "PASSWORD", value: "plain-password" }],
    }),
  });
  try {
    const environment = await resolveShellEnvironment(
      "$USERNAME $PASSWORD",
      child,
    );
    expect({ ...environment.variableEnv, ...environment.secretEnv }).toEqual({
      USERNAME: "parent-account",
      PASSWORD: "parent-credential",
    });
    expect(environment.secretEnv).not.toHaveProperty("USERNAME");
  } finally {
    __testSetBackend(null);
    clearSecretsCache(child);
    clearSecretsCache(parent);
    if (previousRole === undefined) delete process.env.LETTA_CODE_AGENT_ROLE;
    else process.env.LETTA_CODE_AGENT_ROLE = previousRole;
    if (previousParent === undefined) delete process.env.LETTA_PARENT_AGENT_ID;
    else process.env.LETTA_PARENT_AGENT_ID = previousParent;
  }
});

test("variable discovery failure does not block shell secrets or ordinary commands", async () => {
  const { resolveShellEnvironment } = await import("./secret-substitution");
  let calls = 0;
  __testOverrideVariablesBackend({
    retrieveAgent: async () => {
      calls++;
      throw new Error("Variable discovery unavailable");
    },
  });
  __testSeedSecretsCache(id, { PASSWORD: "secret-credential" });
  expect(await resolveShellEnvironment("echo ordinary-text", id)).toEqual({
    secretEnv: {},
    variableEnv: {},
  });
  expect(calls).toBe(0);
  expect(await resolveShellEnvironment("echo $PASSWORD $UNKNOWN", id)).toEqual({
    secretEnv: { PASSWORD: "secret-credential" },
    variableEnv: {},
  });
});
