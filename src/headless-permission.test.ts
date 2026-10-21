import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { waitForHeadlessPermissionResponse } from "@/headless-permission";
import runtimeModelCatalog from "@/test-utils/fixtures/runtime-model-catalog.json";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

const childProcesses = new Set<ChildProcessWithoutNullStreams>();
const tempRoots: string[] = [];

afterAll(async () => {
  for (const child of childProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

function responseLine(
  requestId: string,
  response: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: "control_response",
    response: { request_id: requestId, response },
  });
}

function lineReader(lines: Array<string | null>): () => Promise<string | null> {
  return async () => lines.shift() ?? null;
}

describe("waitForHeadlessPermissionResponse", () => {
  test("keeps ordinary deny behavior without interrupting the turn", async () => {
    let interrupted = false;
    const result = await waitForHeadlessPermissionResponse({
      requestId: "perm-current",
      getNextLine: lineReader([
        responseLine("perm-current", {
          behavior: "deny",
          message: "Not this tool",
        }),
      ]),
      restoreDeferredLines: () => {},
      interruptTurn: () => {
        interrupted = true;
      },
    });

    expect(result).toEqual({
      decision: "deny",
      reason: "Not this tool",
    });
    expect(interrupted).toBe(false);
  });

  test("interrupts the active turn before returning an interrupting deny", async () => {
    const events: string[] = [];
    const result = await waitForHeadlessPermissionResponse({
      requestId: "perm-current",
      getNextLine: lineReader([
        responseLine("perm-current", {
          behavior: "deny",
          message: "Stop this turn",
          interrupt: true,
        }),
      ]),
      restoreDeferredLines: () => {},
      interruptTurn: () => events.push("aborted"),
    });
    events.push("returned");

    expect(result).toEqual({
      decision: "deny",
      reason: "Stop this turn",
      interrupted: true,
    });
    expect(events).toEqual(["aborted", "returned"]);
  });

  test("defers stale responses without allowing them to interrupt a newer turn", async () => {
    const stale = responseLine("perm-old", {
      behavior: "deny",
      message: "Stale stop",
      interrupt: true,
    });
    const malformed = "{not-json";
    const restored: string[] = [];
    let interruptCount = 0;

    const result = await waitForHeadlessPermissionResponse({
      requestId: "perm-current",
      getNextLine: lineReader([
        stale,
        malformed,
        responseLine("perm-current", {
          behavior: "allow",
          updatedInput: { path: "current" },
        }),
      ]),
      restoreDeferredLines: (lines) => restored.push(...lines),
      interruptTurn: () => {
        interruptCount += 1;
      },
    });

    expect(result).toEqual({
      decision: "allow",
      updatedInput: { path: "current" },
    });
    expect(interruptCount).toBe(0);
    expect(restored).toEqual([stale, malformed]);
  });
});

interface HeadlessEvent {
  type?: string;
  subtype?: string;
  message_type?: string;
  request_id?: string;
  request?: { subtype?: string };
}

describe("headless can_use_tool deny interruption", () => {
  test("continues after an ordinary deny and terminates once after an interrupting deny", async () => {
    const events = await runDenyLifecycleScenario();
    const results = events.filter((event) => event.type === "result");
    const resultSubtypes = results.map((result) => result.subtype);

    if (resultSubtypes[1] !== "interrupted") {
      throw new Error(`Unexpected deny lifecycle: ${JSON.stringify(events)}`);
    }
    expect(resultSubtypes).toEqual(["success", "interrupted"]);

    const requests = events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.type === "control_request" &&
          event.request?.subtype === "can_use_tool",
      );
    expect(requests).toHaveLength(2);

    const ordinaryTurnEvents = events.slice(
      requests[0]?.index,
      requests[1]?.index,
    );
    expect(
      ordinaryTurnEvents.some(
        (event) => event.message_type === "tool_return_message",
      ),
    ).toBe(true);
    expect(
      ordinaryTurnEvents.some(
        (event) => event.message_type === "assistant_message",
      ),
    ).toBe(true);

    const interruptingTurnEvents = events.slice(requests[1]?.index);
    expect(
      interruptingTurnEvents.filter((event) => event.type === "result"),
    ).toHaveLength(1);
    expect(
      interruptingTurnEvents.some(
        (event) => event.message_type === "tool_return_message",
      ),
    ).toBe(false);
    expect(
      interruptingTurnEvents.some(
        (event) => event.message_type === "assistant_message",
      ),
    ).toBe(false);
  }, 30_000);
});

async function runDenyLifecycleScenario(): Promise<HeadlessEvent[]> {
  const tempRoot = await mkdtemp(join(tmpdir(), "letta-deny-interrupt-"));
  tempRoots.push(tempRoot);
  const homeDir = join(tempRoot, "home");
  const cacheDir = join(homeDir, ".letta", "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(homeDir, ".letta", "settings.json"),
    JSON.stringify({ permissions: { alwaysAsk: ["Bash"] } }),
  );
  writeFileSync(
    join(cacheDir, "model-catalog.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: LETTA_CLOUD_API_URL,
      fetchedAt: Date.now(),
      models: runtimeModelCatalog.models,
    }),
  );

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(
    process.execPath,
    [
      "--loader=.md:text",
      "--loader=.mdx:text",
      "--loader=.txt:text",
      "run",
      join(repoRoot, "src", "index.ts"),
      "--dev-backend",
      "fake-headless-tool-call",
      "--new-agent",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--memfs-startup",
      "skip",
    ],
    {
      cwd: repoRoot,
      env: createIsolatedCliTestEnv({
        HOME: homeDir,
        LETTA_FS_SANDBOX: "0",
        NO_COLOR: "1",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  childProcesses.add(child);

  return new Promise((resolvePromise, reject) => {
    const events: HeadlessEvent[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let requestCount = 0;
    let resultCount = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      if (error) reject(error);
      else resolvePromise(events);
    };

    const sendUser = () => {
      child.stdin.write(
        `${JSON.stringify({ type: "user", message: { content: "use tool" } })}\n`,
      );
    };

    const onEvent = (event: HeadlessEvent) => {
      events.push(event);
      if (event.type === "system" && event.subtype === "init") {
        sendUser();
        return;
      }
      if (
        event.type === "control_request" &&
        event.request?.subtype === "can_use_tool" &&
        event.request_id
      ) {
        requestCount += 1;
        child.stdin.write(
          `${responseLine(event.request_id, {
            behavior: "deny",
            message:
              requestCount === 1 ? "Deny only this tool" : "Stop this turn",
            ...(requestCount === 2 ? { interrupt: true } : {}),
          })}\n`,
        );
        return;
      }
      if (event.type === "result") {
        resultCount += 1;
        if (resultCount === 1) sendUser();
        else setTimeout(() => finish(), 100);
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as HeadlessEvent);
        } catch {
          // Ignore non-protocol output.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      childProcesses.delete(child);
      if (!settled) {
        finish(
          new Error(
            `Headless fixture exited before both results (code=${code}): ${stderr}`,
          ),
        );
      }
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        new Error(
          `Timed out waiting for deny lifecycle; events=${JSON.stringify(events)} stderr=${stderr}`,
        ),
      );
    }, 25_000);
  });
}
