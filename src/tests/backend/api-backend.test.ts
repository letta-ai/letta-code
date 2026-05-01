import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentMessageListBody,
  AgentUpdateBody,
  APIClient,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  ConversationMessageStreamBody,
  ConversationUpdateBody,
  RunMessageStreamBody,
} from "../../backend";

const retrieveAgentMock = mock(
  async (_agentId: string, _options?: unknown) => ({ id: "agent-1" }),
);
const updateAgentMock = mock(
  async (_agentId: string, _body: unknown, _options?: unknown) => ({
    id: "agent-1",
  }),
);
const retrieveConversationMock = mock(
  async (_conversationId: string, _options?: unknown) => ({ id: "conv-1" }),
);
const createConversationMock = mock(
  async (_body: unknown, _options?: unknown) => ({
    id: "conv-1",
  }),
);
const updateConversationMock = mock(
  async (_conversationId: string, _body: unknown, _options?: unknown) => ({
    id: "conv-1",
  }),
);
const listConversationMessagesMock = mock(
  async (_conversationId: string, _body?: unknown, _options?: unknown) => ({
    getPaginatedItems: () => [],
  }),
);
const listAgentMessagesMock = mock(
  async (_agentId: string, _body?: unknown, _options?: unknown) => ({
    getPaginatedItems: () => [],
  }),
);
const retrieveMessageMock = mock(
  async (_messageId: string, _options?: unknown) => [],
);
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
  agents: {
    retrieve: retrieveAgentMock,
    update: updateAgentMock,
    messages: {
      list: listAgentMessagesMock,
    },
  },
  conversations: {
    retrieve: retrieveConversationMock,
    create: createConversationMock,
    update: updateConversationMock,
    messages: {
      list: listConversationMessagesMock,
      create: createMessageStreamMock,
      stream: streamConversationMessagesMock,
    },
    cancel: cancelConversationMock,
  },
  messages: {
    retrieve: retrieveMessageMock,
  },
  runs: {
    retrieve: retrieveRunMock,
    messages: {
      stream: streamRunMessagesMock,
    },
  },
}));

import { APIBackend } from "../../backend";

describe("APIBackend", () => {
  beforeEach(() => {
    getClientMock.mockClear();
    retrieveAgentMock.mockClear();
    updateAgentMock.mockClear();
    retrieveConversationMock.mockClear();
    createConversationMock.mockClear();
    updateConversationMock.mockClear();
    listConversationMessagesMock.mockClear();
    listAgentMessagesMock.mockClear();
    retrieveMessageMock.mockClear();
    createMessageStreamMock.mockClear();
    streamConversationMessagesMock.mockClear();
    cancelConversationMock.mockClear();
    retrieveRunMock.mockClear();
    streamRunMessagesMock.mockClear();
    forkConversationMock.mockClear();
  });

  test("delegates core conversation and run operations to the Letta API", async () => {
    const backend = new APIBackend({
      getClient: getClientMock as unknown as () => Promise<APIClient>,
      forkConversation: forkConversationMock,
    });
    const agentUpdateBody = { system: "system" } as AgentUpdateBody;
    const conversationCreateBody = {
      agent_id: "agent-1",
    } as ConversationCreateBody;
    const conversationUpdateBody = {
      summary: "summary",
    } as ConversationUpdateBody;
    const conversationListBody = {
      limit: 1,
    } as ConversationMessageListBody;
    const agentListBody = {
      conversation_id: "default",
      limit: 1,
    } as AgentMessageListBody;
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

    await backend.retrieveAgent("agent-1", { include: ["agent.tools"] });
    await backend.updateAgent("agent-1", agentUpdateBody);
    await backend.retrieveConversation("conv-1");
    await backend.createConversation(conversationCreateBody);
    await backend.updateConversation("conv-1", conversationUpdateBody);
    await backend.listConversationMessages("conv-1", conversationListBody);
    await backend.listAgentMessages("agent-1", agentListBody);
    await backend.retrieveMessage("msg-1");
    await backend.createConversationMessageStream("conv-1", createBody, {
      maxRetries: 0,
    });
    await backend.streamConversationMessages("conv-1", streamBody);
    await backend.cancelConversation("conv-1");
    await backend.retrieveRun("run-1");
    await backend.streamRunMessages("run-1", runStreamBody);
    await backend.forkConversation("conv-1", { agentId: "agent-1" });

    expect(getClientMock).toHaveBeenCalledTimes(13);
    expect(retrieveAgentMock).toHaveBeenCalledWith("agent-1", {
      include: ["agent.tools"],
    });
    expect(updateAgentMock).toHaveBeenCalledWith(
      "agent-1",
      agentUpdateBody,
      undefined,
    );
    expect(retrieveConversationMock).toHaveBeenCalledWith("conv-1", undefined);
    expect(createConversationMock).toHaveBeenCalledWith(
      conversationCreateBody,
      undefined,
    );
    expect(updateConversationMock).toHaveBeenCalledWith(
      "conv-1",
      conversationUpdateBody,
      undefined,
    );
    expect(listConversationMessagesMock).toHaveBeenCalledWith(
      "conv-1",
      conversationListBody,
      undefined,
    );
    expect(listAgentMessagesMock).toHaveBeenCalledWith(
      "agent-1",
      agentListBody,
      undefined,
    );
    expect(retrieveMessageMock).toHaveBeenCalledWith("msg-1", undefined);
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
