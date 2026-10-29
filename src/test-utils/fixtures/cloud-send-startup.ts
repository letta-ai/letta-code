import { appendFileSync } from "node:fs";

// Only HTTP is replaced. The test runs index.ts, settings, pinned-name lookup,
// argument forwarding, and the enqueue path unchanged in a separate process.
const agent = {
  id: "agent-named-target",
  name: "Named Recipient",
  tags: [],
  blocks: [],
  tools: [],
  llm_config: { model: "test-model", context_window: 32000 },
};
const logPath = process.env.CLI_STARTUP_REQUEST_LOG;
if (!logPath) throw new Error("Missing startup fixture request log");

globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
    const url = new URL(request.url);
    const body = request.method === "GET" ? undefined : await request.text();
    appendFileSync(
      logPath,
      `${JSON.stringify({ method: request.method, path: url.pathname, body })}\n`,
    );
    if (url.pathname === "/v1/models/catalog")
      return Response.json({
        models: [
          {
            id: "test-model",
            handle: "test/model",
            label: "Test model",
            brand: "test",
            maxContextWindow: 32000,
            isDefault: true,
          },
        ],
      });
    if (
      request.method === "GET" &&
      url.pathname.replace(/\/$/, "") === "/v1/agents"
    )
      return Response.json([agent]);
    if (request.method === "GET" && url.pathname === `/v1/agents/${agent.id}`)
      return Response.json(agent);
    if (
      request.method === "POST" &&
      url.pathname.replace(/\/$/, "") === "/v1/conversations"
    ) {
      if (url.searchParams.get("agent_id") !== agent.id)
        throw new Error("Wrong named target");
      return Response.json({ id: "conv-created", agent_id: agent.id });
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/conversations/conv-created/messages/enqueue"
    ) {
      const message = JSON.parse(body ?? "{}");
      return Response.json(
        {
          client_message_id: message.client_message_id,
          workflow_id: "workflow-test",
          super_run_id: "super-run-test",
        },
        { status: 202 },
      );
    }
    // No network fallback, particularly for unexpected writes or model calls.
    return Response.json(
      { message: `Unimplemented fixture endpoint: ${url.pathname}` },
      { status: 404 },
    );
  },
  { preconnect: () => {} },
);
