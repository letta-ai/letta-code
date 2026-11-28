import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend, type Backend } from "@/backend";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { truncateHookFeedback } from "@/hooks/executor";
import type { ModToolEndEvent } from "@/mods/types";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { monitor } from "@/tools/impl/monitor";
import { backgroundProcesses } from "@/tools/impl/process_manager";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import {
  createSecretStreamScrubber,
  extractSecretEnvFromCommand,
  getAmbientRedactionSecrets,
  scrubOutgoingMessageContent,
  scrubSecretsFromString,
} from "@/tools/secret-substitution";
import {
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
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

describe("subagent secret inheritance", () => {
  const PARENT_ONLY_KEY = "WS_PARENT_ONLY_TOKEN";
  const PARENT_ONLY_VALUE = "parentonlysecret";
  let lookups: string[] = [];

  beforeEach(() => {
    lookups = [];
    __testSetBackend({
      retrieveAgent: async (agentId: string) => {
        lookups.push(agentId);
        return agentId === AGENT_A
          ? { tags: ["role:subagent", `parent:${AGENT_B}`] }
          : { tags: [] };
      },
    } as unknown as Backend);
    __testSeedSecretsCache(AGENT_A, { [SECRET_KEY]: SECRET_A });
    __testSeedSecretsCache(AGENT_B, {
      [SECRET_KEY]: SECRET_B,
      [PARENT_ONLY_KEY]: PARENT_ONLY_VALUE,
    });
  });

  afterEach(() => {
    __testSetBackend(null);
  });

  async function runBash(script: string, subagent: boolean): Promise<string> {
    const runtimeScript = createTempRuntimeScriptCommand(script);
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
      {
        runtimeContext: {
          agentId: AGENT_A,
          workingDirectory: process.cwd(),
          executionSettings: {
            allowed_tools: [],
            disallowed_tools: [],
            disable_memory_guard: false,
            ...(subagent && {
              agent_role: "subagent" as const,
              parent_agent_id: AGENT_B,
            }),
          },
        },
        workingDirectory: process.cwd(),
      },
    );
    try {
      const result = await executeTool(
        "Bash",
        {
          command: `${runtimeScript.command} $${PARENT_ONLY_KEY} $${SECRET_KEY}`,
          timeout: 5000,
        },
        { toolContextId: prepared.contextId },
      );
      expect(result.status).toBe("success");
      return asText(result.toolReturn);
    } finally {
      releaseToolExecutionContext(prepared.contextId);
      runtimeScript.cleanup();
    }
  }

  test("a subagent resolves a parent-only secret and scrubs it from output", async () => {
    const text = await runBash(
      `const v = process.env.${PARENT_ONLY_KEY}; process.stdout.write((v === ${JSON.stringify(PARENT_ONLY_VALUE)} ? 'inherited ' : 'missing ') + (v ?? ''))`,
      true,
    );
    expect(text).toContain("inherited");
    expect(text).toContain(`${PARENT_ONLY_KEY}=<REDACTED>`);
    expect(text).not.toContain(PARENT_ONLY_VALUE);
  });

  test("the subagent's own secret overrides the parent's", async () => {
    const text = await runBash(
      `process.stdout.write(process.env.${SECRET_KEY} === ${JSON.stringify(SECRET_A)} ? 'own' : 'parent')`,
      true,
    );
    expect(text).toContain("own");
  });

  test("a non-subagent agent does not inherit secrets", async () => {
    const text = await runBash(
      `process.stdout.write(process.env.${PARENT_ONLY_KEY} ? 'inherited' : 'missing')`,
      false,
    );
    expect(text).toContain("missing");
    expect(lookups).toEqual([]);
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
      name: "exec_command",
      toolNames: ["exec_command"],
      buildArgs: (cmd) => ({ cmd, description: "Print scoped secret" }),
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
});

const AMBIENT_SENTINEL = "sk-lettatest-SENTINEL-credential-0123456789abcdef";
const AMBIENT_PLACEHOLDER = "LETTA_API_KEY=<REDACTED>";

const FAKE_ENV_PARSER_SCRIPT = `
const fs = require("node:fs");
const file = process.argv[2];
let content = "";
try {
  content = fs.readFileSync(file, "utf8");
} catch (err) {
  process.stderr.write("env-file parse failed: cannot read " + file + "\\n");
}
if (!content.includes("=")) {
  process.stderr.write(
    "env-file parse failed: invalid line; environment was LETTA_API_KEY=" +
      (process.env.LETTA_API_KEY ?? "") +
      "\\n",
  );
  process.exit(1);
}
process.stdout.write("parsed ok\\n");
`;

describe("ambient runtime credential redaction", () => {
  const originalKey = process.env.LETTA_API_KEY;

  beforeEach(() => {
    process.env.LETTA_API_KEY = AMBIENT_SENTINEL;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.LETTA_API_KEY;
    } else {
      process.env.LETTA_API_KEY = originalKey;
    }
  });

  test("ambient redaction set includes the runtime key even when unreferenced", () => {
    const ambient = getAmbientRedactionSecrets();
    expect(Object.values(ambient)).toContain(AMBIENT_SENTINEL);
  });

  test("scrubs the ambient runtime key with no invocation secrets", () => {
    const scrubbed = scrubSecretsFromString(
      `prefix ${AMBIENT_SENTINEL} suffix`,
      {},
    );
    expect(scrubbed).toBe(`prefix ${AMBIENT_PLACEHOLDER} suffix`);
  });

  test("ignores short placeholder credentials", () => {
    process.env.LETTA_API_KEY = "short";
    const scrubbed = scrubSecretsFromString("a short word stays", {});
    expect(scrubbed).toBe("a short word stays");
  });

  test("a same-named agent secret cannot shadow the runtime key", () => {
    const agentValue = "agent-owned-letta-api-key-value-987654";
    const scrubbed = scrubSecretsFromString(
      `${AMBIENT_SENTINEL} and ${agentValue}`,
      { LETTA_API_KEY: agentValue },
    );
    expect(scrubbed).not.toContain(AMBIENT_SENTINEL);
    expect(scrubbed).not.toContain(agentValue);
    expect(scrubbed).toContain("LETTA_API_KEY=<REDACTED>");
  });

  test("stream scrubber redacts a credential split at every chunk boundary", () => {
    const prefix = "noise before ";
    const suffix = " noise after";
    const full = prefix + AMBIENT_SENTINEL + suffix;
    const expected = scrubSecretsFromString(full, {});
    expect(expected).not.toContain(AMBIENT_SENTINEL);

    for (let i = 0; i <= full.length; i++) {
      const scrubber = createSecretStreamScrubber({});
      const streamed =
        scrubber.push(full.slice(0, i)) +
        scrubber.push(full.slice(i)) +
        scrubber.flush();
      expect(streamed).not.toContain(AMBIENT_SENTINEL);
      expect(streamed).toBe(expected);
    }
  });

  test("stream scrubber is a passthrough when no secrets exist", () => {
    process.env.LETTA_API_KEY = "short";
    const scrubber = createSecretStreamScrubber({});
    expect(scrubber.push("hello ")).toBe("hello ");
    expect(scrubber.push("world")).toBe("world");
    expect(scrubber.flush()).toBe("");
  });

  test("truncateHookFeedback scrubs the ambient key from excerpt and overflow file", () => {
    const oversized = `start ${AMBIENT_SENTINEL} ${"p".repeat(12000)} ${AMBIENT_SENTINEL}`;
    const excerpt = truncateHookFeedback(oversized, process.cwd());
    expect(excerpt).not.toContain(AMBIENT_SENTINEL);
    expect(excerpt).toContain(AMBIENT_PLACEHOLDER);
    const overflowPath = excerpt.match(
      /\[Full output written to: ([^\]]+)\]/,
    )?.[1];
    expect(overflowPath).toBeDefined();
    if (!overflowPath) throw new Error("Expected overflow file pointer");
    const overflowContent = readFileSync(overflowPath, "utf8");
    expect(overflowContent).not.toContain(AMBIENT_SENTINEL);
    expect(overflowContent).toContain(AMBIENT_PLACEHOLDER);
  });

  test("failing env-file parser never leaks the ambient key to the model or telemetry", async () => {
    const telemetryCalls: Array<{ errorType?: string; payload?: string }> = [];
    const originalTrackToolUsage = telemetry.trackToolUsage;
    telemetry.trackToolUsage = ((
      _toolName: string,
      _success: boolean,
      _duration: number,
      _responseLength?: number,
      errorType?: string,
      stderr?: string,
    ) => {
      telemetryCalls.push({ errorType, payload: stderr });
    }) as typeof telemetry.trackToolUsage;

    const parser = createTempRuntimeScriptCommand(FAKE_ENV_PARSER_SCRIPT);
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
      {
        runtimeContext: {
          agentId: AGENT_A,
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
      },
    );

    const streamedChunks: string[] = [];
    try {
      const result = await executeTool(
        "Bash",
        { command: `${parser.command} .env-letta-test-missing`, timeout: 5000 },
        {
          toolContextId: prepared.contextId,
          onOutput: (chunk) => streamedChunks.push(chunk),
        },
      );

      const text = asText(result.toolReturn);
      expect(result.status).toBe("error");
      expect(text).not.toContain(AMBIENT_SENTINEL);
      expect(text).toContain(AMBIENT_PLACEHOLDER);
      for (const chunk of streamedChunks) {
        expect(chunk).not.toContain(AMBIENT_SENTINEL);
      }
      for (const call of telemetryCalls) {
        expect(call.payload ?? "").not.toContain(AMBIENT_SENTINEL);
      }
    } finally {
      telemetry.trackToolUsage = originalTrackToolUsage;
      releaseToolExecutionContext(prepared.contextId);
      parser.cleanup();
    }
  });

  test("thrown execution errors never leak the ambient key", async () => {
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Read"],
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
        "Read",
        { file_path: join(process.cwd(), `${AMBIENT_SENTINEL}-no-such-file`) },
        { toolContextId: prepared.contextId },
      );

      const text = asText(result.toolReturn);
      expect(result.status).toBe("error");
      expect(text).not.toContain(AMBIENT_SENTINEL);
      expect(text).toContain("<REDACTED>");
    } finally {
      releaseToolExecutionContext(prepared.contextId);
    }
  });

  test("background output file and completion notification never leak the ambient key", async () => {
    const queued: QueuedMessage[] = [];
    setMessageQueueAdder((message) => {
      queued.push(message);
    });

    const parser = createTempRuntimeScriptCommand(FAKE_ENV_PARSER_SCRIPT);
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
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
        "Bash",
        {
          command: `${parser.command} .env-letta-test-missing`,
          run_in_background: true,
          timeout: 5000,
        },
        { toolContextId: prepared.contextId },
      );

      const text = asText(result.toolReturn);
      const bashId = text.match(/bash_\d+/)?.[0];
      expect(bashId).toBeDefined();
      if (!bashId) throw new Error("Expected background Bash id");

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (backgroundProcesses.get(bashId)?.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      for (
        let attempt = 0;
        attempt < 100 && queued.length === 0;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(backgroundProcesses.get(bashId)?.status).toBe("failed");
      const outputFile = backgroundProcesses.get(bashId)?.outputFile;
      expect(outputFile).toBeDefined();
      if (!outputFile) throw new Error("Expected output file path");
      const fileContent = readFileSync(outputFile, "utf8");
      expect(fileContent).not.toContain(AMBIENT_SENTINEL);
      expect(fileContent).toContain(AMBIENT_PLACEHOLDER);
      expect(queued.length).toBeGreaterThan(0);
      for (const message of queued) {
        expect(JSON.stringify(message)).not.toContain(AMBIENT_SENTINEL);
      }
    } finally {
      setMessageQueueAdder(null);
      releaseToolExecutionContext(prepared.contextId);
      parser.cleanup();
    }
  }, 15_000);

  test("overflow files never persist the ambient key", async () => {
    const parser = createTempRuntimeScriptCommand(
      `process.stdout.write("x".repeat(31000) + (process.env.LETTA_API_KEY ?? "") + "\\n");`,
    );
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
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
        "Bash",
        { command: parser.command, timeout: 5000 },
        { toolContextId: prepared.contextId },
      );

      const text = asText(result.toolReturn);
      expect(result.status).toBe("success");
      expect(text).not.toContain(AMBIENT_SENTINEL);
      const overflowPath = text.match(
        /\[Full output written to: ([^\]]+)\]/,
      )?.[1];
      expect(overflowPath).toBeDefined();
      if (!overflowPath) throw new Error("Expected overflow file pointer");
      const overflowContent = readFileSync(overflowPath, "utf8");
      expect(overflowContent).not.toContain(AMBIENT_SENTINEL);
      expect(overflowContent).toContain(AMBIENT_PLACEHOLDER);
    } finally {
      releaseToolExecutionContext(prepared.contextId);
      parser.cleanup();
    }
  }, 15_000);

  test("tool_end mod overrides retain the credential after rotation", async () => {
    const rotatedCredential = "sk-lettatest-ROTATED-credential-9876543210";
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Read"],
      {
        runtimeContext: {
          agentId: AGENT_A,
          workingDirectory: process.cwd(),
        },
        workingDirectory: process.cwd(),
        modEvents: {
          async emit(name, event) {
            if (name === "tool_start") {
              process.env.LETTA_API_KEY = rotatedCredential;
            }
            if (name === "tool_end") {
              process.env.LETTA_API_KEY =
                "sk-lettatest-THIRD-credential-abcdef9876543210";
              (
                event as ModToolEndEvent & {
                  result?: { status: "success" | "error"; output: string };
                }
              ).result = {
                status: "success",
                output: `mod replacement output: ${rotatedCredential}`,
              };
            }
            return { diagnostics: [], handlerCount: 0, name, results: [] };
          },
        },
      },
    );

    try {
      const result = await executeTool(
        "Read",
        { file_path: "package.json" },
        { toolContextId: prepared.contextId },
      );

      const text = asText(result.toolReturn);
      expect(result.status).toBe("success");
      expect(text).not.toContain(rotatedCredential);
      expect(text).toContain("<REDACTED>");
      expect(text).toContain("mod replacement output:");
    } finally {
      releaseToolExecutionContext(prepared.contextId);
    }
  });

  test.skipIf(process.platform === "win32")(
    "monitor events include a final unterminated tail held back as a secret prefix",
    async () => {
      const previousBackendMode = resolveBackendMode();
      setConfiguredBackendMode("local");
      const queued: QueuedMessage[] = [];
      setMessageQueueAdder((message) => {
        queued.push(message);
      });

      try {
        const result = await monitor({
          description: "tail test",
          timeout_ms: 30_000,
          persistent: false,
          command: "printf 'ready-sk'",
        });

        for (let attempt = 0; attempt < 100; attempt += 1) {
          const state = backgroundProcesses.get(result.taskId);
          if (state && state.status !== "running") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const texts = queued.map((message) => JSON.stringify(message));
        expect(
          texts.some((text) => text.includes("ready-sk")),
          `expected an event containing the held-back tail; got: ${texts.join(" | ")}`,
        ).toBe(true);
        for (const text of texts) {
          expect(text).not.toContain(AMBIENT_SENTINEL);
        }
      } finally {
        setConfiguredBackendMode(previousBackendMode);
        setMessageQueueAdder(null);
      }
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "PostToolUse hook feedback never reintroduces the ambient key",
    async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "letta-hook-redaction-"));
      const fakeHome = join(baseDir, "home");
      const projectDir = join(baseDir, "project");
      mkdirSync(fakeHome, { recursive: true });
      mkdirSync(join(projectDir, ".letta"), { recursive: true });
      writeFileSync(
        join(projectDir, ".letta", "settings.json"),
        JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: 'echo "$LETTA_API_KEY" >&2 && exit 2',
                  },
                ],
              },
            ],
          },
        }),
      );

      const originalHome = process.env.HOME;
      await settingsManager.reset();
      process.env.HOME = fakeHome;
      await settingsManager.initialize();

      let prepared:
        | Awaited<
            ReturnType<typeof prepareToolExecutionContextForSpecificTools>
          >
        | undefined;
      try {
        prepared = await prepareToolExecutionContextForSpecificTools(["Bash"], {
          runtimeContext: { agentId: AGENT_A, workingDirectory: projectDir },
          workingDirectory: projectDir,
        });
        const result = await executeTool(
          "Bash",
          { command: "echo tool-output", timeout: 5000 },
          { toolContextId: prepared.contextId },
        );

        const text = asText(result.toolReturn);
        expect(result.status).toBe("success");
        expect(text).toContain("[Hook feedback]:");
        expect(text).not.toContain(AMBIENT_SENTINEL);
        expect(text).toContain(AMBIENT_PLACEHOLDER);
      } finally {
        if (prepared) releaseToolExecutionContext(prepared.contextId);
        process.env.HOME = originalHome;
        await settingsManager.reset();
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "oversized hook feedback never persists the ambient key in its overflow file",
    async () => {
      const baseDir = mkdtempSync(
        join(tmpdir(), "letta-hook-overflow-redaction-"),
      );
      const fakeHome = join(baseDir, "home");
      const projectDir = join(baseDir, "project");
      mkdirSync(fakeHome, { recursive: true });
      mkdirSync(join(projectDir, ".letta"), { recursive: true });
      writeFileSync(
        join(projectDir, ".letta", "settings.json"),
        JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command:
                      "{ echo \"$LETTA_API_KEY\"; head -c 12000 /dev/zero | tr '\\0' 'p'; echo \"$LETTA_API_KEY\"; } >&2 && exit 2",
                  },
                ],
              },
            ],
          },
        }),
      );

      const originalHome = process.env.HOME;
      await settingsManager.reset();
      process.env.HOME = fakeHome;
      await settingsManager.initialize();

      let prepared:
        | Awaited<
            ReturnType<typeof prepareToolExecutionContextForSpecificTools>
          >
        | undefined;
      try {
        prepared = await prepareToolExecutionContextForSpecificTools(["Bash"], {
          runtimeContext: { agentId: AGENT_A, workingDirectory: projectDir },
          workingDirectory: projectDir,
        });
        const result = await executeTool(
          "Bash",
          { command: "echo tool-output", timeout: 5000 },
          { toolContextId: prepared.contextId },
        );

        const text = asText(result.toolReturn);
        expect(text).toContain("[Hook feedback]:");
        expect(text).not.toContain(AMBIENT_SENTINEL);
        expect(text).toContain(AMBIENT_PLACEHOLDER);
        const overflowPath = text.match(
          /\[Full output written to: ([^\]]+)\]/,
        )?.[1];
        expect(overflowPath).toBeDefined();
        if (!overflowPath) {
          throw new Error("Expected hook feedback overflow pointer");
        }
        const overflowContent = readFileSync(overflowPath, "utf8");
        expect(overflowContent).not.toContain(AMBIENT_SENTINEL);
        expect(overflowContent).toContain(AMBIENT_PLACEHOLDER);
      } finally {
        if (prepared) releaseToolExecutionContext(prepared.contextId);
        process.env.HOME = originalHome;
        await settingsManager.reset();
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

describe("always-on vault secret redaction", () => {
  const VAULT_KEY = SECRET_KEY;
  const VAULT_VALUE = "vault-value-abcdef-0123456789-secret";

  afterEach(() => {
    clearSecretsCache(AGENT_A);
    clearSecretsCache(AGENT_B);
  });

  test("vault secret is redacted even when the command never references it", async () => {
    seedSecret(AGENT_A, VAULT_VALUE);
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
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
        "Bash",
        { command: `printf '%s' "$${VAULT_KEY}"`, timeout: 5000 },
        { toolContextId: prepared.contextId },
      );

      const text = asText(result.toolReturn);
      expect(text).not.toContain(VAULT_VALUE);
      expect(text).toContain(`${VAULT_KEY}=<REDACTED>`);
    } finally {
      releaseToolExecutionContext(prepared.contextId);
    }
  });

  test("vault secret read via a file tool is redacted from the return", async () => {
    seedSecret(AGENT_A, VAULT_VALUE);
    const baseDir = mkdtempSync(join(tmpdir(), "vault-scrub-"));
    const filePath = join(baseDir, "secret-file.txt");
    writeFileSync(filePath, `token=${VAULT_VALUE}\n`);

    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Read"],
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
        "Read",
        { file_path: filePath },
        { toolContextId: prepared.contextId },
      );

      const text = asText(result.toolReturn);
      expect(text).not.toContain(VAULT_VALUE);
      expect(text).toContain(`${VAULT_KEY}=<REDACTED>`);
    } finally {
      releaseToolExecutionContext(prepared.contextId);
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test("vault redaction is scoped to the executing agent", () => {
    seedSecret(AGENT_A, VAULT_VALUE);
    seedSecret(AGENT_B, "other-agent-vault-value-xyz-0123456789");

    const scrubbedA = scrubSecretsFromString(
      `${VAULT_VALUE} stays`,
      {},
      AGENT_A,
    );
    expect(scrubbedA).not.toContain(VAULT_VALUE);
    expect(scrubbedA).toContain(`${VAULT_KEY}=<REDACTED>`);

    const scrubbedB = scrubSecretsFromString(
      `${VAULT_VALUE} stays`,
      {},
      AGENT_B,
    );
    expect(scrubbedB).toContain(VAULT_VALUE);
  });

  test.each(["LETTA_AGENT_ID", "AGENT_ID"])(
    "keeps the scoped agent identifier stored under %s",
    (name) => {
      __testSeedSecretsCache(AGENT_A, {
        [name]: AGENT_A,
        [VAULT_KEY]: VAULT_VALUE,
      });
      expect(
        scrubSecretsFromString(`${AGENT_A} ${VAULT_VALUE}`, {}, AGENT_A),
      ).toBe(`${AGENT_A} ${VAULT_KEY}=<REDACTED>`);
    },
  );

  test("short vault values are not redacted", () => {
    __testSeedSecretsCache(AGENT_A, { [SECRET_KEY]: "short" });
    const scrubbed = scrubSecretsFromString("a short word stays", {}, AGENT_A);
    expect(scrubbed).toBe("a short word stays");
  });

  test("outgoing message content is scrubbed for the scoped agent", () => {
    seedSecret(AGENT_A, VAULT_VALUE);

    const stringContent = scrubOutgoingMessageContent(
      `here is my token ${VAULT_VALUE} ok`,
      AGENT_A,
    );
    expect(stringContent).not.toContain(VAULT_VALUE);
    expect(stringContent).toContain(`${VAULT_KEY}=<REDACTED>`);

    const partsContent = scrubOutgoingMessageContent(
      [
        { type: "text", text: `pasted: ${VAULT_VALUE}` },
        { type: "image_url", url: "https://example.com/img.png" },
      ],
      AGENT_A,
    ) as Array<{ type?: string; text?: string; url?: string }>;
    expect(partsContent[0]?.text).not.toContain(VAULT_VALUE);
    expect(partsContent[0]?.text).toContain(`${VAULT_KEY}=<REDACTED>`);
    expect(partsContent[1]?.url).toBe("https://example.com/img.png");
  });
});
