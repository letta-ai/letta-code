import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { __testSetBackend, type Backend } from "@/backend";
import { runCronSubcommand } from "@/cli/subcommands/cron";
import { listTasks } from "@/cron";

const TEST_DIR = path.join(import.meta.dir, "__cron_cli_test_tmp__");

const createConversationMock = mock(
  async (_body: { agent_id: string; summary: string }) => ({
    id: "conv-dedicated-1",
  }),
);

const backendMock = {
  capabilities: {
    remoteMemfs: false,
    serverSideToolManagement: false,
    serverSecrets: false,
    agentFileImportExport: false,
    promptRecompile: false,
    byokProviderRefresh: false,
    localModelCatalog: false,
    localMemfs: false,
  },
  createConversation: createConversationMock,
} as unknown as Backend;

function captureConsole() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation(
    (...args: unknown[]) => {
      stdout.push(args.map((arg) => String(arg)).join(" "));
    },
  );
  const errorSpy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      stderr.push(args.map((arg) => String(arg)).join(" "));
    },
  );

  return {
    stdout,
    stderr,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

describe("cron add --dedicated", () => {
  let origHome: string | undefined;
  let origAgentId: string | undefined;
  let origConversationId: string | undefined;

  beforeEach(() => {
    origHome = process.env.LETTA_HOME;
    origAgentId = process.env.LETTA_AGENT_ID;
    origConversationId = process.env.LETTA_CONVERSATION_ID;

    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    process.env.LETTA_HOME = TEST_DIR;
    delete process.env.LETTA_AGENT_ID;
    delete process.env.LETTA_CONVERSATION_ID;

    createConversationMock.mockClear();
    createConversationMock.mockResolvedValue({ id: "conv-dedicated-1" });
    __testSetBackend(backendMock);
  });

  afterEach(() => {
    __testSetBackend(null);

    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }

    if (origHome === undefined) delete process.env.LETTA_HOME;
    else process.env.LETTA_HOME = origHome;
    if (origAgentId === undefined) delete process.env.LETTA_AGENT_ID;
    else process.env.LETTA_AGENT_ID = origAgentId;
    if (origConversationId === undefined)
      delete process.env.LETTA_CONVERSATION_ID;
    else process.env.LETTA_CONVERSATION_ID = origConversationId;
  });

  test("creates a stable conversation and stores its id on the task", async () => {
    const capture = captureConsole();
    try {
      const code = await runCronSubcommand([
        "add",
        "--name",
        "bi-hourly-status-report",
        "--description",
        "Bi-hourly status report",
        "--cron",
        "0 */2 * * *",
        "--agent",
        "agent-1",
        "--dedicated",
        "--prompt",
        "write the report",
      ]);

      expect(code).toBe(0);
      expect(createConversationMock).toHaveBeenCalledTimes(1);
      expect(createConversationMock.mock.calls[0]?.[0]).toEqual({
        agent_id: "agent-1",
        summary: "[Schedule] bi-hourly-status-report",
      });

      const output = JSON.parse(capture.stdout[0] ?? "{}");
      expect(output).toMatchObject({
        status: "active",
        cron: "0 */2 * * *",
        recurring: true,
        agent_id: "agent-1",
        conversation_id: "conv-dedicated-1",
      });

      const tasks = listTasks({ agent_id: "agent-1" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.conversation_id).toBe("conv-dedicated-1");

      const listCode = await runCronSubcommand(["list", "--agent", "agent-1"]);
      expect(listCode).toBe(0);
      const listOutput = JSON.parse(capture.stdout[1] ?? "[]");
      expect(listOutput).toEqual([
        expect.objectContaining({ conversation_id: "conv-dedicated-1" }),
      ]);
    } finally {
      capture.restore();
    }
  });

  test("rejects --dedicated with --conversation before creating anything", async () => {
    const capture = captureConsole();
    try {
      const code = await runCronSubcommand([
        "add",
        "--name",
        "conflict",
        "--description",
        "Invalid conflict",
        "--cron",
        "0 * * * *",
        "--agent",
        "agent-1",
        "--conversation",
        "conv-existing",
        "--dedicated",
        "--prompt",
        "do not add",
      ]);

      expect(code).toBe(1);
      expect(createConversationMock).not.toHaveBeenCalled();
      expect(listTasks()).toHaveLength(0);
      expect(capture.stderr.join("\n")).toContain(
        "--dedicated cannot be used with --conversation",
      );
    } finally {
      capture.restore();
    }
  });

  test("preserves explicit new conversation target without creating one now", async () => {
    const capture = captureConsole();
    try {
      const code = await runCronSubcommand([
        "add",
        "--name",
        "new-each-fire",
        "--description",
        "Create a new conversation per fire",
        "--cron",
        "0 * * * *",
        "--agent",
        "agent-1",
        "--conversation",
        "new",
        "--prompt",
        "start fresh",
      ]);

      expect(code).toBe(0);
      expect(createConversationMock).not.toHaveBeenCalled();
      const output = JSON.parse(capture.stdout[0] ?? "{}");
      expect(output.conversation_id).toBe("new");
      expect(listTasks()[0]?.conversation_id).toBe("new");
    } finally {
      capture.restore();
    }
  });
});
