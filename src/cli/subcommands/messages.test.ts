import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { runMessagesSubcommand } from "@/cli/subcommands/messages";

const initializeSettingsMock = mock(() => Promise.resolve());
const searchMessagesForBackendMock = mock((_body: Record<string, unknown>) =>
  Promise.resolve([]),
);
const backendMock = {
  listAgentMessages: mock(() => Promise.resolve({ items: [] })),
  listConversationMessages: mock(() => Promise.resolve({ items: [] })),
};

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

function runMessages(argv: string[]) {
  return runMessagesSubcommand(argv, {
    initializeSettings: initializeSettingsMock,
    getBackend: () => backendMock as never,
    searchMessagesForBackend: searchMessagesForBackendMock as never,
  });
}

describe("messages subcommand conversation scoping", () => {
  let priorAgentId: string | undefined;

  beforeEach(() => {
    priorAgentId = process.env.LETTA_AGENT_ID;
    delete process.env.LETTA_AGENT_ID;
    initializeSettingsMock.mockClear();
    searchMessagesForBackendMock.mockClear();
    backendMock.listAgentMessages.mockClear();
    backendMock.listConversationMessages.mockClear();
  });

  afterEach(() => {
    if (priorAgentId === undefined) delete process.env.LETTA_AGENT_ID;
    else process.env.LETTA_AGENT_ID = priorAgentId;
  });

  test("search rejects default conversation without an agent", async () => {
    const capture = captureConsole();
    try {
      const code = await runMessages([
        "search",
        "--query",
        "needle",
        "--conversation",
        "default",
      ]);

      expect(code).toBe(1);
      expect(searchMessagesForBackendMock).not.toHaveBeenCalled();
      expect(capture.stderr.join("\n")).toContain(
        'Conversation "default" requires an agent id',
      );
    } finally {
      capture.restore();
    }
  });

  test("searching a non-default conversation does not add env agent scope", async () => {
    process.env.LETTA_AGENT_ID = "agent-current";
    const capture = captureConsole();
    try {
      const code = await runMessages([
        "search",
        "--query",
        "needle",
        "--conversation",
        "local-conv-1",
      ]);

      expect(code).toBe(0);
      expect(searchMessagesForBackendMock).toHaveBeenCalledTimes(1);
      expect(searchMessagesForBackendMock.mock.calls[0]?.[0]).toMatchObject({
        query: "needle",
        conversation_id: "local-conv-1",
      });
      expect(
        searchMessagesForBackendMock.mock.calls[0]?.[0],
      ).not.toHaveProperty("agent_id");
    } finally {
      capture.restore();
    }
  });

  test("searching default conversation uses the resolved agent", async () => {
    process.env.LETTA_AGENT_ID = "agent-current";
    const capture = captureConsole();
    try {
      const code = await runMessages([
        "search",
        "--query",
        "needle",
        "--conversation",
        "default",
      ]);

      expect(code).toBe(0);
      expect(searchMessagesForBackendMock).toHaveBeenCalledTimes(1);
      expect(searchMessagesForBackendMock.mock.calls[0]?.[0]).toMatchObject({
        query: "needle",
        agent_id: "agent-current",
        conversation_id: "default",
      });
    } finally {
      capture.restore();
    }
  });

  test("list allows non-default conversation without an agent", async () => {
    const capture = captureConsole();
    try {
      const code = await runMessages([
        "list",
        "--conversation",
        "local-conv-1",
      ]);

      expect(code).toBe(0);
      expect(backendMock.listConversationMessages).toHaveBeenCalledWith(
        "local-conv-1",
        expect.objectContaining({ limit: 20 }),
      );
      expect(backendMock.listAgentMessages).not.toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });

  test("list rejects default conversation without an agent", async () => {
    const capture = captureConsole();
    try {
      const code = await runMessages(["list"]);

      expect(code).toBe(1);
      expect(backendMock.listConversationMessages).not.toHaveBeenCalled();
      expect(backendMock.listAgentMessages).not.toHaveBeenCalled();
      expect(capture.stderr.join("\n")).toContain(
        'Conversation "default" requires an agent id',
      );
    } finally {
      capture.restore();
    }
  });
});
