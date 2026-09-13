import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

async function runStartup(args: string[]) {
  const home = await mkdtemp(join(tmpdir(), "letta-cloud-startup-"));
  const requestLog = join(home, "requests.jsonl");
  try {
    await mkdir(join(home, ".letta"));
    await writeFile(
      join(home, ".letta", "settings.json"),
      JSON.stringify({
        agents: [{ agentId: "agent-named-target", pinned: true }],
      }),
    );
    await writeFile(requestLog, "");
    const child = Bun.spawn(
      [
        process.execPath,
        `--config=${resolve(import.meta.dir, "..", "bunfig.toml")}`,
        "--preload",
        resolve(import.meta.dir, "test-utils/fixtures/cloud-send-startup.ts"),
        resolve(import.meta.dir, "index.ts"),
        "-p",
        "startup target check",
        "--backend",
        "api",
        ...args,
      ],
      {
        cwd: home,
        env: createIsolatedCliTestEnv({
          HOME: home,
          LETTA_MODEL_CATALOG_CACHE_DIR: join(home, "cache"),
          LETTA_SKIP_KEYCHAIN_CHECK: "1",
          LETTA_API_KEY: "test-only-no-network",
          LETTA_BASE_URL: "https://api.letta.com",
          CLI_STARTUP_REQUEST_LOG: requestLog,
          LETTA_SUBAGENT_LAUNCH: undefined,
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => child.kill(), 20_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const requests = (await readFile(requestLog, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { method: string; path: string; body?: string },
        );
      return { code, stdout, stderr, requests };
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test.each(
  ["--computer", "--environment", "--env"].flatMap((selector) =>
    ["--name", "-n"].map((nameFlag) => ({ selector, nameFlag })),
  ),
)(
  "startup resolves the named recipient before Cloud delivery: %j",
  async ({ selector, nameFlag }) => {
    const result = await runStartup([
      nameFlag,
      "nAmEd ReCiPiEnT",
      selector,
      "My laptop",
      "--no-wait",
      "--output-format",
      "json",
    ]);
    expect(result.stderr).not.toContain("Choose a destination");
    expect(result.code, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.agent_id).toBe("agent-named-target");
    const send = result.requests.find((request) =>
      request.path.endsWith("/messages/enqueue"),
    );
    expect(JSON.parse(send?.body ?? "{}")).toMatchObject({
      agent_id: "agent-named-target",
      computer: "My laptop",
    });
    expect(
      result.requests.some(
        (request) => request.path === "/v1/agents/agent-named-target",
      ),
    ).toBe(true);
  },
  25_000,
);

test.each([
  { flag: "--model", value: "test-model" },
  { flag: "--tools", value: "Read" },
  { flag: "--allowedTools", value: "Read" },
  { flag: "--disallowedTools", value: "Bash" },
  { flag: "--permission-mode", value: "strict" },
])(
  "startup rejects unsupported recipient restrictions before submission: %j",
  async ({ flag, value }) => {
    const result = await runStartup([
      "--name",
      "Named Recipient",
      "--computer",
      "My laptop",
      "--no-wait",
      "--output-format",
      "json",
      flag,
      value,
    ]);
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "submission_failed",
    });
    expect(JSON.parse(result.stdout).error).toContain(
      `${flag} configures local execution`,
    );
    expect(
      result.requests.filter(
        (request) =>
          request.method === "POST" && request.path.includes("/conversations"),
      ),
    ).toEqual([]);
  },
  25_000,
);

test.each([
  {
    destination: [],
    error: "--from-agent requires --agent <id> or --conversation <id>",
  },
  {
    destination: ["--conversation", "default"],
    error: "--from-agent cannot be used with --new-agent",
  },
])(
  "startup still rejects --new-agent plus --from-agent after skipping enqueue: %j",
  async ({ destination, error }) => {
    const result = await runStartup([
      "--new-agent",
      "--from-agent",
      "agent-sender",
      ...destination,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(error);
    expect(
      result.requests.filter(
        (request) =>
          request.method === "POST" &&
          (request.path.replace(/\/$/, "") === "/v1/agents" ||
            request.path.includes("/conversations")),
      ),
    ).toEqual([]);
  },
  25_000,
);
