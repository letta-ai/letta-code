import { expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import type { Backend, ConversationUpdateBody } from "@/backend";
import { consumeSubagentLaunch } from "@/utils/subagent-launch-marker";
import { tagSubagentConversation } from "./conversation-tags";

function fixture(tags?: string[]) {
  const reads: string[] = [];
  const writes: {
    id: string;
    body: ConversationUpdateBody & { tags?: string[] };
  }[] = [];
  const backend = {
    retrieveConversation: async (id: string) => {
      reads.push(id);
      return { id, agent_id: "agent-child", tags } as Awaited<
        ReturnType<Backend["retrieveConversation"]>
      >;
    },
    updateConversation: async (id: string, body: ConversationUpdateBody) => {
      writes.push({ id, body });
      tags = (body as ConversationUpdateBody & { tags: string[] }).tags;
      return { id, agent_id: "agent-child", tags } as Awaited<
        ReturnType<Backend["updateConversation"]>
      >;
    },
  };
  return { backend, reads, writes };
}

test.each(["conv-fork", "conv-existing", "conv-resumed"])(
  "tags the resolved Agent destination %s and preserves existing tags",
  async (id) => {
    const f = fixture(["project:demo", "purpose:review"]);
    await tagSubagentConversation(f.backend, id, true);
    expect(f.reads).toEqual([id]);
    expect(f.writes).toEqual([
      {
        id,
        body: { tags: ["project:demo", "purpose:review", "role:subagent"] },
      },
    ]);
    await tagSubagentConversation(f.backend, id, true);
    expect(f.writes).toHaveLength(1);
  },
);

test("tags an untagged conversation", async () => {
  const f = fixture();
  await tagSubagentConversation(f.backend, "conv-new", true);
  expect(f.writes[0]?.body).toEqual({ tags: ["role:subagent"] });
});

test("inherited subagent role does not mark ordinary shell invocations", async () => {
  const f = fixture();
  const env = { LETTA_CODE_AGENT_ROLE: "subagent", LETTA_SUBAGENT_LAUNCH: "1" };
  await tagSubagentConversation(
    f.backend,
    "conv-child",
    consumeSubagentLaunch(env),
  );
  await tagSubagentConversation(
    f.backend,
    "conv-ordinary",
    consumeSubagentLaunch(env),
  );
  expect(f.reads).toEqual(["conv-child"]);
  expect(f.writes.map((write) => write.id)).toEqual(["conv-child"]);
});

test.each([true, false])(
  "never reads or patches virtual default (Agent launch=%s)",
  async (launch) => {
    const f = fixture();
    await tagSubagentConversation(f.backend, "default", launch);
    expect(f.reads).toEqual([]);
    expect(f.writes).toEqual([]);
  },
);

test("a provenance lookup failure does not stop launch or write fabricated tags", async () => {
  const f = fixture();
  f.backend.retrieveConversation = async () => {
    throw new Error("not found");
  };
  await expect(
    tagSubagentConversation(f.backend, "conv-missing", true),
  ).resolves.toBeUndefined();
  expect(f.writes).toEqual([]);
});

test("a provenance write failure does not stop launch", async () => {
  const f = fixture();
  f.backend.updateConversation = async () => {
    throw new Error("unavailable");
  };
  await expect(
    tagSubagentConversation(f.backend, "conv-child", true),
  ).resolves.toBeUndefined();
});

test("installed SDK transports tags on the existing conversation GET and PATCH", async () => {
  let tags = ["project:demo"];
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === "PATCH") {
        tags = ((await request.json()) as { tags: string[] }).tags;
      }
      return Response.json({ id: "conv-child", agent_id: "agent-child", tags });
    },
  });
  try {
    const client = new Letta({
      baseURL: server.url.toString(),
      apiKey: "test",
      maxRetries: 0,
    });
    const backend = {
      retrieveConversation: client.conversations.retrieve.bind(
        client.conversations,
      ),
      updateConversation: client.conversations.update.bind(
        client.conversations,
      ),
    };
    await tagSubagentConversation(backend, "conv-child", true);
    await tagSubagentConversation(backend, "conv-child", true);
    expect(tags).toEqual(["project:demo", "role:subagent"]);
    expect(calls).toEqual([
      "GET /v1/conversations/conv-child",
      "PATCH /v1/conversations/conv-child",
      "GET /v1/conversations/conv-child",
    ]);
  } finally {
    server.stop(true);
  }
});
