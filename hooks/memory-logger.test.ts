import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("./memory_logger.py", import.meta.url),
);
const fixtureKey = "memory-logger-fixture-key";
const tempDirs: string[] = [];

// 只替换网络和钥匙串边界，执行真实的 stdin、配置、状态写入和 CLI 调用路径。
const harness = `
import importlib.util
import io
import json
import runpy
import subprocess
import sys
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("memory_logger", sys.argv[1])
logger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logger)
script_path = sys.argv[1]
options = json.loads(sys.argv[2])

def respond(request, timeout):
    assert timeout == 10
    kind = options.get("failure")
    if kind == "http401" or kind == "http503":
        code = 401 if kind == "http401" else 503
        raise urllib.error.HTTPError(request.full_url, code, "memory-logger-fixture-key", {}, io.BytesIO(b"memory-logger-fixture-key"))
    if kind == "network":
        raise urllib.error.URLError("memory-logger-fixture-key")
    if kind == "timeout":
        raise TimeoutError("memory-logger-fixture-key")
    if kind == "unexpected":
        raise RuntimeError("memory-logger-fixture-key")
    if kind == "no-request":
        raise AssertionError("This event must not fetch memory")
    if kind == "json":
        return io.BytesIO(b"not-json memory-logger-fixture-key")
    if kind == "encoding":
        return io.BytesIO(bytes([255]))
    return io.BytesIO(json.dumps(options.get("blocks", [])).encode("utf-8"))

sys.argv = [sys.argv[1]] + options.get("args", [])
sys.stdin = io.StringIO(json.dumps({
    "agent_id": options.get("agentId", "agent-memory-logger-test"),
    "working_directory": options["workingDirectory"],
    "tool_result": {"status": options.get("status", "success")},
}))
with patch("subprocess.run", return_value=subprocess.CompletedProcess(["bun"], 1, "", "")), patch.object(logger.urllib.request, "urlopen", side_effect=respond):
    if options.get("fetchOnly"):
        try:
            print(json.dumps({"blocks": logger.fetch_all_memory_blocks("agent-memory-logger-test")}))
        except Exception as error:
            print(json.dumps({"errorType": type(error).__name__}))
    else:
        runpy.run_path(script_path, run_name="__main__")
`;

type Options = {
  failure?: string;
  blocks?: unknown;
  args?: string[];
  agentId?: string;
  status?: string;
  fetchOnly?: boolean;
  missingKey?: boolean;
};

function createProject(): string {
  const project = mkdtempSync(join(tmpdir(), "letta-memory-logger-"));
  tempDirs.push(project);
  return project;
}

async function runLogger(project: string, options: Options = {}) {
  const env = { ...process.env };
  delete env.LETTA_API_KEY;
  if (!options.missingKey) env.LETTA_API_KEY = fixtureKey;
  env.LETTA_BASE_URL = "http://memory-logger.invalid";
  env.HOME = project;
  env.USERPROFILE = project;
  env.PYTHONDONTWRITEBYTECODE = "1";
  const proc = Bun.spawn({
    cmd: [
      "python3",
      "-c",
      harness,
      scriptPath,
      JSON.stringify({ ...options, workingDirectory: project }),
    ],
    cwd: project,
    env,
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

afterEach(() => {
  for (const project of tempDirs.splice(0)) {
    rmSync(project, { recursive: true, force: true });
  }
});

describe("memory logger fetch failures (#4784)", () => {
  const failures: Array<[string, Options, string]> = [
    ["missing credentials", { missingKey: true }, "API key"],
    ["unauthorized", { failure: "http401" }, "HTTP 401"],
    ["service unavailable", { failure: "http503" }, "HTTP 503"],
    ["network error", { failure: "network" }, "network"],
    ["timeout", { failure: "timeout" }, "timed out"],
    ["invalid JSON", { failure: "json" }, "JSON"],
    ["invalid encoding", { failure: "encoding" }, "UTF-8"],
    ["unexpected object", { blocks: {} }, "list of memory blocks"],
    [
      "invalid list entry",
      { blocks: [{ label: "persona", value: "must not write" }, null] },
      "list of memory blocks",
    ],
    ["unexpected exception", { failure: "unexpected" }, "RuntimeError"],
  ];

  for (const [name, options, diagnostic] of failures) {
    test(`${name} is observable without changing existing memory history`, async () => {
      const project = createProject();
      const initial = await runLogger(project, {
        blocks: [{ label: "persona", value: "before" }],
      });
      expect(initial.exitCode).toBe(0);
      const updated = await runLogger(project, {
        blocks: [{ label: "persona", value: "existing memory" }],
      });
      expect(updated.exitCode).toBe(0);
      const statePath = join(project, ".letta", "memory_logs", "persona.json");
      const historyPath = join(
        project,
        ".letta",
        "memory_logs",
        "persona.jsonl",
      );
      const state = readFileSync(statePath, "utf8");
      const history = readFileSync(historyPath, "utf8");

      const result = await runLogger(project, options);
      expect(result.stderr).toContain("Memory logger:");
      expect(result.stderr).toContain(diagnostic);
      expect(result.stderr).not.toContain(fixtureKey);
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
      expect(readFileSync(statePath, "utf8")).toBe(state);
      expect(readFileSync(historyPath, "utf8")).toBe(history);
    });
  }

  test("the fetch boundary distinguishes failure from a successful empty list", async () => {
    const project = createProject();
    const empty = await runLogger(project, { fetchOnly: true });
    expect(JSON.parse(empty.stdout)).toEqual({ blocks: [] });
    const failed = await runLogger(project, {
      fetchOnly: true,
      failure: "http401",
    });
    expect(JSON.parse(failed.stdout)).toEqual({
      errorType: "MemoryFetchError",
    });
  });

  test("an empty successful response is quiet and does not erase local state", async () => {
    const project = createProject();
    await runLogger(project, {
      blocks: [{ label: "persona", value: "existing memory" }],
    });
    const statePath = join(project, ".letta", "memory_logs", "persona.json");
    const state = readFileSync(statePath, "utf8");
    expect(await runLogger(project)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(readFileSync(statePath, "utf8")).toBe(state);
  });

  test("successful updates still persist state and a real unified diff", async () => {
    const project = createProject();
    await runLogger(project, {
      blocks: [{ label: "persona", value: "before" }],
    });
    const result = await runLogger(project, {
      blocks: [{ label: "persona", value: "after" }],
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const logs = join(project, ".letta", "memory_logs");
    expect(
      JSON.parse(readFileSync(join(logs, "persona.json"), "utf8")).content,
    ).toBe("after");
    const entry = JSON.parse(readFileSync(join(logs, "persona.jsonl"), "utf8"));
    expect(entry.diff).toContain("-before\n+after\n");
    expect(entry.agent_id).toBe("agent-memory-logger-test");
  });

  test("failed tools and missing agent ids still skip the fetch", async () => {
    const project = createProject();
    for (const options of [{ status: "error" }, { agentId: "" }]) {
      expect(
        await runLogger(project, { ...options, failure: "no-request" }),
      ).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
    }
  });

  test("debug distinguishes an empty success from a failed fetch", async () => {
    const project = createProject();
    const args = ["debug", "agent-memory-logger-test"];
    const empty = await runLogger(project, { args });
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("No memory blocks are attached");
    expect(empty.stdout).not.toContain("Possible issues");
    expect(empty.stderr).toBe("");
    const failed = await runLogger(project, { args, failure: "http401" });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("HTTP 401");
    expect(failed.stdout).not.toContain("Possible issues");
    expect(failed.stdout + failed.stderr).not.toContain(fixtureKey);
  });
});
