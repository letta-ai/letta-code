import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

interface SigintScenarioSummary {
  code: number | null;
  signal: NodeJS.Signals | null;
  markerValue: string | null;
  stdout: string;
  stderr: string;
  telemetryRequests: number;
}

const cliProcesses = new Set<ChildProcess>();
const tempRoots: string[] = [];

afterAll(async () => {
  for (const child of cliProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("headless SIGINT cancellation", () => {
  test("cancels a delayed one-shot tool call and exits interrupted", async () => {
    const summary = await runDelayedToolSigintScenario();

    expect(summary.code, formatSummary(summary)).toBe(130);
    expect(summary.signal, formatSummary(summary)).toBeNull();
    expect(summary.markerValue, formatSummary(summary)).toBeNull();
    expect(summary.stdout, formatSummary(summary)).toContain(
      '"message":"Interrupted by SIGINT"',
    );
    expect(summary.stdout, formatSummary(summary)).toContain(
      '"stop_reason":"cancelled"',
    );
    expect(summary.stdout, formatSummary(summary)).not.toContain(
      "tool_return_message",
    );
  }, 15_000);
});

async function runDelayedToolSigintScenario(): Promise<SigintScenarioSummary> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "letta-headless-sigint-"));
  tempRoots.push(tmpRoot);
  const homeDir = join(tmpRoot, "home");
  const backendDir = join(tmpRoot, "backend");
  const markerPath = join(tmpRoot, "late-tool-marker.txt");
  mkdirSync(join(homeDir, ".letta"), { recursive: true });

  let telemetryRequests = 0;
  const telemetryServer = http.createServer((req, res) => {
    req.resume();
    if (req.url?.includes("/v1/metadata/telemetry")) {
      telemetryRequests += 1;
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  await new Promise<void>((resolve) => {
    telemetryServer.listen(0, "127.0.0.1", resolve);
  });
  const address = telemetryServer.address();
  if (!address || typeof address === "string") {
    telemetryServer.close();
    throw new Error("Failed to start telemetry test server");
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cliEntry = join(repoRoot, "src", "index.ts");
  const child = spawn(
    process.execPath,
    [
      "--loader=.md:text",
      "--loader=.mdx:text",
      "--loader=.txt:text",
      "run",
      cliEntry,
      "-p",
      "trigger a delayed tool call",
      "--dev-backend",
      "fake-headless-tool-call",
      "--permission-mode",
      "unrestricted",
      "--output-format",
      "stream-json",
      "--no-mods",
    ],
    {
      cwd: repoRoot,
      env: createIsolatedCliTestEnv({
        HOME: homeDir,
        LETTA_API_KEY: "test-key",
        LETTA_BASE_URL: `http://127.0.0.1:${address.port}`,
        LETTA_CODE_DEV_BACKEND_DIR: backendDir,
        LETTA_CODE_FAKE_HEADLESS_TOOL_COMMAND: `printf late-after-sigint > '${markerPath}'`,
        LETTA_CODE_FAKE_HEADLESS_TOOL_DELAY_MS: "1000",
        LETTA_CODE_FAKE_HEADLESS_TOOL_DESCRIPTION: "write SIGINT marker",
        LETTA_DESKTOP_MODE: "1",
        LETTA_FS_SANDBOX: "0",
        NO_COLOR: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  cliProcesses.add(child);

  let stdout = "";
  let stderr = "";
  let sigintSent = false;
  const sendSigint = () => {
    if (sigintSent || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    sigintSent = true;
    child.kill("SIGINT");
  };

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (!sigintSent && stdout.includes('"subtype":"init"')) {
      setTimeout(sendSigint, 250);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const fallbackSigint = setTimeout(sendSigint, 3000);
  const hardTimeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 10_000);

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(fallbackSigint);
  clearTimeout(hardTimeout);
  telemetryServer.close();
  cliProcesses.delete(child);

  return {
    code,
    signal,
    markerValue: existsSync(markerPath)
      ? await readFile(markerPath, "utf8")
      : null,
    stdout,
    stderr,
    telemetryRequests,
  };
}

function formatSummary(summary: SigintScenarioSummary): string {
  return JSON.stringify(
    {
      ...summary,
      stdout: summary.stdout.slice(-2000),
      stderr: summary.stderr.slice(-2000),
    },
    null,
    2,
  );
}
