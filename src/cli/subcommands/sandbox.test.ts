import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  resolveSandboxSession,
  runSandboxSubcommand,
} from "@/cli/subcommands/sandbox";

const CLOUD_ENV = {
  LETTA_AGENT_ID: "agent-1",
  LETTA_CONVERSATION_ID: "conv-1",
};

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("sandbox subcommand", () => {
  test("prefers the active shell conversation", () => {
    expect(
      resolveSandboxSession(CLOUD_ENV, {
        agentId: "agent-fallback",
        conversationId: "conv-fallback",
      }),
    ).toEqual({ agentId: "agent-1", conversationId: "conv-1" });
  });

  test("rejects local agents", () => {
    expect(() =>
      resolveSandboxSession(
        {
          LETTA_AGENT_ID: "agent-local-1",
          LETTA_CONVERSATION_ID: "conv-1",
        },
        null,
      ),
    ).toThrow("requires a Letta Cloud agent");
  });

  test("uploads a local file after ensuring the sandbox", async () => {
    const calls: string[] = [];
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runSandboxSubcommand(["upload", "note.txt"], {
          initializeSettings: async () => {},
          isCloud: async () => true,
          getLastSession: () => null,
          statLocalPath: async () => ({ isFile: () => true }),
          readLocalFile: async () => Buffer.from("hello"),
          ensureSandbox: async (agentId, conversationId) => {
            calls.push(`ensure:${agentId}:${conversationId}`);
            return {
              sandboxId: "sandbox-1",
              deviceId: "device-1",
              connectionName: "Cloud",
            };
          },
          uploadFile: async (sandboxId, file) => {
            calls.push(`upload:${sandboxId}:${file.name}:${file.blob.size}`);
            return {
              files: [
                {
                  path: "/root/downloads/upload/note.txt",
                  name: "note.txt",
                  mimeType: "text/plain",
                  size: 5,
                },
              ],
            };
          },
        }),
      );

      expect(exitCode).toBe(0);
      expect(calls).toEqual([
        "ensure:agent-1:conv-1",
        "upload:sandbox-1:note.txt:5",
      ]);
      expect(JSON.parse(output[0] ?? "{}").files[0].path).toBe(
        "/root/downloads/upload/note.txt",
      );
    } finally {
      console.log = originalLog;
    }
  });

  test("downloads a sandbox file to the requested path", async () => {
    const writes: Array<{ path: string; data: number[] }> = [];
    const originalLog = console.log;
    console.log = () => {};
    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runSandboxSubcommand(
          ["download", "/root/downloads/report.txt", "--to", "copy.txt"],
          {
            initializeSettings: async () => {},
            isCloud: async () => true,
            getLastSession: () => null,
            ensureSandbox: async () => ({
              sandboxId: "sandbox-1",
              deviceId: "device-1",
              connectionName: "Cloud",
            }),
            downloadFile: async () => new Uint8Array([1, 2, 3]),
            writeLocalFile: async (path, data) => {
              writes.push({
                path: String(path),
                data: [...(data as Uint8Array)],
              });
            },
          },
        ),
      );

      expect(exitCode).toBe(0);
      expect(writes).toEqual([{ path: resolve("copy.txt"), data: [1, 2, 3] }]);
    } finally {
      console.log = originalLog;
    }
  });

  test("loads project settings before production session resolution", async () => {
    const workingDirectory = await mkdtemp(
      `${tmpdir()}/letta-sandbox-settings-`,
    );
    const originalWorkingDirectory = process.cwd();
    const originalLog = console.log;
    console.log = () => {};
    process.chdir(workingDirectory);
    try {
      const exitCode = await withEnvironment(CLOUD_ENV, () =>
        runSandboxSubcommand(["upload", "note.txt"], {
          isCloud: async () => true,
          statLocalPath: async () => ({ isFile: () => true }),
          readLocalFile: async () => Buffer.from("hello"),
          ensureSandbox: async () => ({
            sandboxId: "sandbox-1",
            deviceId: "device-1",
            connectionName: "Cloud",
          }),
          uploadFile: async () => ({ files: [] }),
        }),
      );

      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalWorkingDirectory);
      console.log = originalLog;
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
