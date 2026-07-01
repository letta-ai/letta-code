import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { __testSetBackend, type Backend } from "@/backend";
import { runCronSubcommand } from "@/cli/subcommands/cron";
import { listTasks } from "@/cron";

const TEST_DIR = path.join(import.meta.dir, "__cron_subcommand_test_tmp__");

const retrieveConversationMock = mock(async (conversationId: string) => ({
  id: conversationId,
  agent_id: "agent-test",
}));

const backend = {
  capabilities: {
    remoteMemfs: true,
    serverSideToolManagement: true,
    serverSecrets: true,
    agentFileImportExport: true,
    promptRecompile: true,
    byokProviderRefresh: true,
    localModelCatalog: false,
    localMemfs: false,
  },
  retrieveConversation: retrieveConversationMock,
} as unknown as Backend;

type SavedEnv = {
  LETTA_HOME?: string;
  LETTA_AGENT_ID?: string;
  LETTA_CONVERSATION_ID?: string;
};

let savedEnv: SavedEnv;

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

function restoreEnv(): void {
  for (const key of Object.keys(savedEnv) as Array<keyof SavedEnv>) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function cronAddArgs(conversationId: string): string[] {
  return [
    "add",
    "--name",
    "memory-maintenance",
    "--description",
    "Memory hygiene",
    "--prompt",
    "run maintenance",
    "--every",
    "5m",
    "--agent",
    "agent-test",
    "--conversation",
    conversationId,
  ];
}

function parseCronAddOutput(stdout: string[]): Record<string, unknown> {
  return JSON.parse(stdout.join("\n")) as Record<string, unknown>;
}

describe("cron add conversation validation", () => {
  beforeEach(() => {
    savedEnv = {
      LETTA_HOME: process.env.LETTA_HOME,
      LETTA_AGENT_ID: process.env.LETTA_AGENT_ID,
      LETTA_CONVERSATION_ID: process.env.LETTA_CONVERSATION_ID,
    };
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.LETTA_HOME = TEST_DIR;
    delete process.env.LETTA_AGENT_ID;
    delete process.env.LETTA_CONVERSATION_ID;

    retrieveConversationMock.mockClear();
    retrieveConversationMock.mockImplementation(
      async (conversationId: string) => ({
        id: conversationId,
        agent_id: "agent-test",
      }),
    );
    __testSetBackend(backend);
  });

  afterEach(() => {
    __testSetBackend(null);
    rmSync(TEST_DIR, { recursive: true, force: true });
    restoreEnv();
  });

  test("accepts an existing conversation id for the selected agent", async () => {
    const capture = captureConsole();
    try {
      const code = await runCronSubcommand(cronAddArgs("conv-valid"));

      expect(code).toBe(0);
      expect(retrieveConversationMock).toHaveBeenCalledWith("conv-valid");
      expect(listTasks()).toHaveLength(1);
      const output = parseCronAddOutput(capture.stdout);
      expect(output.conversation_id).toBe("conv-valid");
    } finally {
      capture.restore();
    }
  });

  test("rejects an invalid conversation label without writing a task", async () => {
    retrieveConversationMock.mockImplementation(async () => {
      throw new Error("not found");
    });

    const capture = captureConsole();
    try {
      const code = await runCronSubcommand(cronAddArgs("cron-memory"));

      expect(code).toBe(1);
      expect(retrieveConversationMock).toHaveBeenCalledWith("cron-memory");
      expect(listTasks()).toHaveLength(0);
      const error = capture.stderr.join("\n");
      expect(error).toContain('Invalid conversation target "cron-memory"');
      expect(error).toContain(
        'expects "default", "new", or an existing conversation id',
      );
      expect(error).toContain("labels/names are not accepted");
    } finally {
      capture.restore();
    }
  });

  test("allows the default conversation sentinel without lookup", async () => {
    const capture = captureConsole();
    try {
      const code = await runCronSubcommand(cronAddArgs("default"));

      expect(code).toBe(0);
      expect(retrieveConversationMock).not.toHaveBeenCalled();
      expect(listTasks()).toHaveLength(1);
      const output = parseCronAddOutput(capture.stdout);
      expect(output.conversation_id).toBe("default");
    } finally {
      capture.restore();
    }
  });

  test("allows the new conversation sentinel without lookup", async () => {
    const capture = captureConsole();
    try {
      const code = await runCronSubcommand(cronAddArgs("new"));

      expect(code).toBe(0);
      expect(retrieveConversationMock).not.toHaveBeenCalled();
      expect(listTasks()).toHaveLength(1);
      const output = parseCronAddOutput(capture.stdout);
      expect(output.conversation_id).toBe("new");
    } finally {
      capture.restore();
    }
  });

  test("rejects a valid conversation id that belongs to another agent", async () => {
    retrieveConversationMock.mockImplementation(
      async (conversationId: string) => ({
        id: conversationId,
        agent_id: "agent-other",
      }),
    );

    const capture = captureConsole();
    try {
      const code = await runCronSubcommand(cronAddArgs("conv-other-agent"));

      expect(code).toBe(1);
      expect(retrieveConversationMock).toHaveBeenCalledWith("conv-other-agent");
      expect(listTasks()).toHaveLength(0);
      expect(capture.stderr.join("\n")).toContain(
        'Conversation "conv-other-agent" belongs to agent "agent-other", not selected agent "agent-test".',
      );
    } finally {
      capture.restore();
    }
  });
});
