import { afterEach, describe, expect, test } from "bun:test";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import {
  createOutputRedactor,
  createStreamingSecretScrubber,
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

describe("streaming secret scrubber", () => {
  function streamChunks(
    chunks: readonly string[],
    secrets: Readonly<Record<string, string>>,
  ): string[] {
    const scrubber = createStreamingSecretScrubber(secrets);
    return [...chunks.map((chunk) => scrubber.push(chunk)), scrubber.flush()];
  }

  /** Every way to cut `text` into two or three chunks. */
  function allSplits(text: string): string[][] {
    const splits: string[][] = [];
    for (let first = 0; first <= text.length; first++) {
      splits.push([text.slice(0, first), text.slice(first)]);
      for (let second = first; second <= text.length; second++) {
        splits.push([
          text.slice(0, first),
          text.slice(first, second),
          text.slice(second),
        ]);
      }
    }
    return splits;
  }

  test("redacts a secret written across two chunks", () => {
    const secrets = { PASSWORD: "he$$o-very-secret" };

    expect(streamChunks(["PASSWORD=he$$", "o-very-secret\n"], secrets)).toEqual(
      ["PASSWORD=", "PASSWORD=<REDACTED>\n", ""],
    );
  });

  test("matches whole-text redaction however the output is chunked", () => {
    const cases: Array<{
      text: string;
      secrets: Record<string, string>;
    }> = [
      {
        text: "token=s3cr3t-value done; again s3cr3t-value\n",
        secrets: { TOKEN: "s3cr3t-value" },
      },
      {
        // One secret is a prefix of another.
        text: "short abc, long abcdef, short again abc.",
        secrets: { SHORT: "abc", LONG: "abcdef" },
      },
      {
        // The end of one secret begins another.
        text: "abcdzz cdxy abcdxy",
        secrets: { FIRST: "abcd", SECOND: "cdxy" },
      },
      {
        // The secret repeats its own prefix.
        text: "aaab aaaab aab",
        secrets: { REPEAT: "aaab" },
      },
    ];

    for (const { text, secrets } of cases) {
      const expected = scrubSecretsFromString(text, secrets);
      for (const chunks of allSplits(text)) {
        const output = streamChunks(chunks, secrets).join("");
        expect({ chunks, output }).toEqual({ chunks, output: expected });
      }
    }
  });

  test("never emits part of a secret before the rest arrives", () => {
    const secret = "abcdef";
    const scrubber = createStreamingSecretScrubber({ KEY: secret });

    let emitted = "";
    for (const char of "xx abcdef yy") {
      emitted += scrubber.push(char);
      expect(emitted).not.toContain("abc");
    }
    emitted += scrubber.flush();

    expect(emitted).toBe("xx KEY=<REDACTED> yy");
  });

  test("holds a possible secret prefix until the next chunk settles it", () => {
    const scrubber = createStreamingSecretScrubber({ TOKEN: "secret-value" });

    expect(scrubber.push("wrote sec")).toBe("wrote ");
    expect(scrubber.push("ond line\n")).toBe("second line\n");
    expect(scrubber.push("")).toBe("");
    expect(scrubber.flush()).toBe("");
  });

  test("emits a dangling secret prefix unchanged when the stream ends", () => {
    const scrubber = createStreamingSecretScrubber({ TOKEN: "secret-value" });

    expect(scrubber.push("done: secr")).toBe("done: ");
    expect(scrubber.flush()).toBe("secr");
    expect(scrubber.flush()).toBe("");
  });

  test("redacts stdout and stderr as separate streams", () => {
    const recorded: Array<[string, "stdout" | "stderr"]> = [];
    const redactor = createOutputRedactor(
      { PASSWORD: "he$$o-very-secret" },
      (text, stream) => recorded.push([text, stream]),
    );

    redactor.push("out he$$", "stdout");
    redactor.push("err he$$", "stderr");
    // The second half on the other stream does not complete either secret.
    redactor.push("o-very-secret\n", "stderr");
    redactor.push("o-very-secret\n", "stdout");
    redactor.flush();

    expect(recorded).toEqual([
      ["out ", "stdout"],
      ["err ", "stderr"],
      ["PASSWORD=<REDACTED>\n", "stderr"],
      ["PASSWORD=<REDACTED>\n", "stdout"],
    ]);
  });

  test("records what each stream still holds when flushed", () => {
    const recorded: Array<[string, "stdout" | "stderr"]> = [];
    const redactor = createOutputRedactor(
      { TOKEN: "secret-value" },
      (text, stream) => recorded.push([text, stream]),
    );

    redactor.push("secr", "stdout");
    redactor.push("sec", "stderr");
    expect(recorded).toEqual([]);
    redactor.flush();

    expect(recorded).toEqual([
      ["secr", "stdout"],
      ["sec", "stderr"],
    ]);
  });

  test("passes chunks through unchanged without secrets", () => {
    const scrubber = createStreamingSecretScrubber({ EMPTY: "" });

    expect(scrubber.push("partial ")).toBe("partial ");
    expect(scrubber.push("")).toBe("");
    expect(scrubber.flush()).toBe("");
  });
});
