import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  ConversationMessageCreateBody,
  ConversationMessageStreamBody,
  RunMessageStreamBody,
} from "../../backend";

const createMessageStreamMock = mock(
  async (_conversationId: string, _body: unknown, _options?: unknown) => ({
    kind: "create-stream",
  }),
);
const streamConversationMessagesMock = mock(
  async (_conversationId: string, _body: unknown, _options?: unknown) => ({
    kind: "resume-stream",
  }),
);
const cancelConversationMock = mock(async (_conversationId: string) => ({
  status: "cancelled",
}));
const retrieveRunMock = mock(async (_runId: string) => ({
  id: "run-1",
  metadata: {},
}));
const streamRunMessagesMock = mock(
  async (_runId: string, _body: unknown, _options?: unknown) => ({
    kind: "run-stream",
  }),
);
const forkConversationMock = mock(
  async (_conversationId: string, _options?: unknown) => ({ id: "conv-fork" }),
);
const getClientMock = mock(async () => ({
  conversations: {
    messages: {
      create: createMessageStreamMock,
      stream: streamConversationMessagesMock,
    },
    cancel: cancelConversationMock,
  },
  runs: {
    retrieve: retrieveRunMock,
    messages: {
      stream: streamRunMessagesMock,
    },
  },
}));

mock.module("../../backend/api/client", () => ({
  getClient: getClientMock,
}));

mock.module("../../backend/api/conversations", () => ({
  forkConversation: forkConversationMock,
}));

const { APIBackend } = await import("../../backend");

describe("APIBackend", () => {
  beforeEach(() => {
    getClientMock.mockClear();
    createMessageStreamMock.mockClear();
    streamConversationMessagesMock.mockClear();
    cancelConversationMock.mockClear();
    retrieveRunMock.mockClear();
    streamRunMessagesMock.mockClear();
    forkConversationMock.mockClear();
  });

  afterAll(() => {
    mock.restore();
  });

  test("delegates core conversation and run operations to the Letta API", async () => {
    const backend = new APIBackend();
    const createBody = {
      messages: [{ role: "user", content: "hello" }],
      streaming: true,
    } as unknown as ConversationMessageCreateBody;
    const streamBody = {
      otid: "otid-1",
      starting_after: 0,
      batch_size: 1000,
    } as unknown as ConversationMessageStreamBody;
    const runStreamBody = {
      starting_after: 10,
      batch_size: 1000,
    } as unknown as RunMessageStreamBody;

    await backend.createConversationMessageStream("conv-1", createBody, {
      maxRetries: 0,
    });
    await backend.streamConversationMessages("conv-1", streamBody);
    await backend.cancelConversation("conv-1");
    await backend.retrieveRun("run-1");
    await backend.streamRunMessages("run-1", runStreamBody);
    await backend.forkConversation("conv-1", { agentId: "agent-1" });

    expect(getClientMock).toHaveBeenCalledTimes(5);
    expect(createMessageStreamMock).toHaveBeenCalledWith("conv-1", createBody, {
      maxRetries: 0,
    });
    expect(streamConversationMessagesMock).toHaveBeenCalledWith(
      "conv-1",
      streamBody,
      undefined,
    );
    expect(cancelConversationMock).toHaveBeenCalledWith("conv-1");
    expect(retrieveRunMock).toHaveBeenCalledWith("run-1");
    expect(streamRunMessagesMock).toHaveBeenCalledWith(
      "run-1",
      runStreamBody,
      undefined,
    );
    expect(forkConversationMock).toHaveBeenCalledWith("conv-1", {
      agentId: "agent-1",
    });
  });
});
