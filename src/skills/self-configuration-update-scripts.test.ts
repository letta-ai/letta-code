import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const scriptDir = join(
  repoRoot,
  "src",
  "skills",
  "builtin",
  "self-configuration",
  "scripts",
);
const updateAgentSettingsScript = join(scriptDir, "update-agent-settings.ts");
const updateCompactionPromptScript = join(
  scriptDir,
  "update-compaction-prompt.ts",
);
const tempDirs: string[] = [];

const isolatedEnvKeys = [
  "AGENT_ID",
  "CONVERSATION_ID",
  "LETTA_API_KEY",
  "LETTA_BASE_URL",
];

type RecordedRequest = {
  method: string;
  url: string;
  body: string;
};

type JsonHandler = (
  request: IncomingMessage,
  body: string,
) =>
  | Promise<{ status: number; json: unknown }>
  | { status: number; json: unknown };

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTempJson(prefix: string, name: string, value: unknown): string {
  const dir = makeTempDir(prefix);
  const filePath = join(dir, name);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function writeTempText(prefix: string, name: string, value: string): string {
  const dir = makeTempDir(prefix);
  const filePath = join(dir, name);
  writeFileSync(filePath, value, "utf8");
  return filePath;
}

async function runScript(
  scriptPath: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const childEnv: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const key of isolatedEnvKeys) delete childEnv[key];
  Object.assign(childEnv, env);

  const proc = Bun.spawn({
    cmd: ["bun", scriptPath, ...args],
    cwd: repoRoot,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function withJsonServer<T>(
  handler: JsonHandler,
  run: (baseUrl: string, requests: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      body,
    });

    try {
      const result = await handler(request, body);
      response.statusCode = result.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result.json));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  try {
    return await run(baseUrl, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function expectNoLeakedShowData(stdout: string): void {
  expect(stdout).not.toContain("compiled system prompt");
  expect(stdout).not.toContain("raw-provider-secret");
  expect(stdout).not.toContain("provider_secret");
  expect(stdout).not.toContain("irrelevant_server_field");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
  }
});

test("update-agent-settings agent show fetches and filters safe fields", async () => {
  await withJsonServer(
    (request) => {
      if (request.method === "GET" && request.url === "/v1/agents/agent-test") {
        return {
          status: 200,
          json: {
            id: "agent-test",
            agent_id: "agent-test",
            name: "Repo Maintainer",
            description: "Maintains repository settings",
            model: "openai/gpt-5.2",
            context_window_limit: 64000,
            llm_config: {
              context_window: 128000,
              provider_secret: "raw-provider-secret",
            },
            model_settings: {
              provider_type: "openai",
              api_key: "raw-provider-secret",
              nested: {
                token: "raw-provider-secret",
                keep: "safe",
              },
            },
            compaction_settings: {
              mode: "self_compact_sliding_window",
              prompt: "keep compacting",
              secret: "raw-provider-secret",
            },
            system: "compiled system prompt",
            irrelevant: "irrelevant_server_field",
          },
        };
      }
      return { status: 500, json: { error: "unexpected request" } };
    },
    async (baseUrl, requests) => {
      const result = await runScript(
        updateAgentSettingsScript,
        [
          "--target",
          "agent",
          "--agent-id",
          "agent-test",
          "--show",
          "--base-url",
          baseUrl,
        ],
        { LETTA_API_KEY: "test-key" },
      );

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(parseJsonOutput(result.stdout)).toEqual({
        id: "agent-test",
        name: "Repo Maintainer",
        description: "Maintains repository settings",
        model: "openai/gpt-5.2",
        context_window_limit: 64000,
        agent_id: "agent-test",
        llm_config: { context_window: 128000 },
        model_settings: {
          provider_type: "openai",
          api_key: "[redacted]",
          nested: {
            token: "[redacted]",
            keep: "safe",
          },
        },
        compaction_settings: {
          mode: "self_compact_sliding_window",
          prompt: "keep compacting",
          secret: "[redacted]",
        },
      });
      expectNoLeakedShowData(result.stdout);
      expect(requests.map((request) => request.method)).toEqual(["GET"]);
    },
  );
});

test("update-agent-settings conversation show includes agent_id and filters llm_config", async () => {
  await withJsonServer(
    (request) => {
      if (
        request.method === "GET" &&
        request.url === "/v1/conversations/conv-test"
      ) {
        return {
          status: 200,
          json: {
            id: "conv-test",
            agent_id: "agent-test",
            model: "anthropic/claude-sonnet-4-20250514",
            context_window_limit: null,
            llm_config: {
              context_window: 200000,
              credentials: { token: "raw-provider-secret" },
            },
            system: "compiled system prompt",
            irrelevant: "irrelevant_server_field",
          },
        };
      }
      return { status: 500, json: { error: "unexpected request" } };
    },
    async (baseUrl, requests) => {
      const result = await runScript(
        updateAgentSettingsScript,
        [
          "--target",
          "conversation",
          "--conversation-id",
          "conv-test",
          "--show",
          "--base-url",
          baseUrl,
        ],
        { LETTA_API_KEY: "test-key" },
      );

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(parseJsonOutput(result.stdout)).toEqual({
        id: "conv-test",
        model: "anthropic/claude-sonnet-4-20250514",
        context_window_limit: null,
        agent_id: "agent-test",
        llm_config: { context_window: 200000 },
      });
      expectNoLeakedShowData(result.stdout);
      expect(requests.map((request) => request.method)).toEqual(["GET"]);
    },
  );
});

test("update-agent-settings show rejects mutation combinations", async () => {
  const result = await runScript(updateAgentSettingsScript, [
    "--target",
    "agent",
    "--agent-id",
    "agent-test",
    "--show",
    "--model",
    "openai/gpt-5.2",
  ]);

  expect(result.stdout).toBe("");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--show cannot be combined with --model");
});

test("update-agent-settings merge model dry run fetches current state without patching", async () => {
  const modelSettingsFile = writeTempJson("self-config-model-", "model.json", {
    reasoning: { reasoning_effort: "high" },
  });

  await withJsonServer(
    (request) => {
      if (request.method === "GET" && request.url === "/v1/agents/agent-test") {
        return {
          status: 200,
          json: {
            id: "agent-test",
            model_settings: {
              provider_type: "openai",
              parallel_tool_calls: true,
              reasoning: { reasoning_effort: "medium" },
            },
          },
        };
      }
      return { status: 500, json: { error: "unexpected request" } };
    },
    async (baseUrl, requests) => {
      const result = await runScript(
        updateAgentSettingsScript,
        [
          "--target",
          "agent",
          "--agent-id",
          "agent-test",
          "--model-settings-file",
          modelSettingsFile,
          "--merge-model-settings",
          "--dry-run",
          "--base-url",
          baseUrl,
        ],
        { LETTA_API_KEY: "test-key" },
      );

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const output = parseJsonOutput(result.stdout);
      expect(output.preview).toBe("effective_merged_patch");
      expect(output.patch).toEqual({
        model_settings: {
          provider_type: "openai",
          parallel_tool_calls: true,
          reasoning: { reasoning_effort: "high" },
        },
      });
      expect(requests.map((request) => request.method)).toEqual(["GET"]);
    },
  );
});

test("update-agent-settings merge compaction dry run preserves fetched fields without patching", async () => {
  const compactionSettingsFile = writeTempJson(
    "self-config-compaction-",
    "compaction.json",
    {
      prompt: "new compact prompt",
    },
  );

  await withJsonServer(
    (request) => {
      if (request.method === "GET" && request.url === "/v1/agents/agent-test") {
        return {
          status: 200,
          json: {
            id: "agent-test",
            compaction_settings: {
              mode: "self_compact_sliding_window",
              clip_chars: 12345,
              prompt: "old prompt",
            },
          },
        };
      }
      return { status: 500, json: { error: "unexpected request" } };
    },
    async (baseUrl, requests) => {
      const result = await runScript(
        updateAgentSettingsScript,
        [
          "--target",
          "agent",
          "--agent-id",
          "agent-test",
          "--compaction-settings-file",
          compactionSettingsFile,
          "--merge-compaction-settings",
          "--dry-run",
          "--base-url",
          baseUrl,
        ],
        { LETTA_API_KEY: "test-key" },
      );

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const output = parseJsonOutput(result.stdout);
      expect(output.preview).toBe("effective_merged_patch");
      expect(output.patch).toEqual({
        compaction_settings: {
          mode: "self_compact_sliding_window",
          clip_chars: 12345,
          prompt: "new compact prompt",
        },
      });
      expect(requests.map((request) => request.method)).toEqual(["GET"]);
    },
  );
});

test("update-compaction-prompt dry run fetches current settings and avoids patching", async () => {
  const promptFile = writeTempText(
    "self-config-prompt-",
    "prompt.txt",
    "new compaction prompt\n",
  );

  await withJsonServer(
    (request) => {
      if (request.method === "GET" && request.url === "/v1/agents/agent-test") {
        return {
          status: 200,
          json: {
            id: "agent-test",
            compaction_settings: {
              mode: "self_compact_sliding_window",
              clip_chars: 50000,
              prompt: "old prompt",
            },
          },
        };
      }
      return { status: 500, json: { error: "unexpected request" } };
    },
    async (baseUrl, requests) => {
      const result = await runScript(
        updateCompactionPromptScript,
        [
          "--agent-id",
          "agent-test",
          "--prompt-file",
          promptFile,
          "--dry-run",
          "--base-url",
          baseUrl,
        ],
        { LETTA_API_KEY: "test-key" },
      );

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const output = parseJsonOutput(result.stdout);
      expect(output.preview).toBe("effective_merged_patch");
      expect(output.patch).toEqual({
        compaction_settings: {
          mode: "self_compact_sliding_window",
          clip_chars: 50000,
          prompt: "new compaction prompt\n",
        },
      });
      expect(requests.map((request) => request.method)).toEqual(["GET"]);
    },
  );
});

test("model settings replacement dry run remains offline and reports a partial patch preview", async () => {
  const modelSettingsFile = writeTempJson(
    "self-config-replacement-model-",
    "model.json",
    {
      provider_type: "openai",
      parallel_tool_calls: false,
    },
  );

  const result = await runScript(updateAgentSettingsScript, [
    "--target",
    "agent",
    "--agent-id",
    "agent-test",
    "--model-settings-file",
    modelSettingsFile,
    "--dry-run",
  ]);

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(parseJsonOutput(result.stdout)).toEqual({
    target: "agent",
    id: "agent-test",
    preview: "offline_partial_patch",
    patch: {
      model_settings: {
        provider_type: "openai",
        parallel_tool_calls: false,
      },
    },
  });
});

test("metadata dry run remains offline and reports a partial patch preview", async () => {
  const result = await runScript(updateAgentSettingsScript, [
    "--target",
    "agent",
    "--agent-id",
    "agent-test",
    "--name",
    "offline-name",
    "--dry-run",
  ]);

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(parseJsonOutput(result.stdout)).toEqual({
    target: "agent",
    id: "agent-test",
    preview: "offline_partial_patch",
    patch: { name: "offline-name" },
  });
});
