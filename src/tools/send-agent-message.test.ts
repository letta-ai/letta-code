import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend, type Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import {
  clearCapturedToolExecutionContexts,
  executeTool,
  prepareToolExecutionContextForSpecificTools,
} from "./manager";

const computers = [undefined, null, "", " \t", "desktop"];
test.each(computers)("HTTP send: computer %j", async (computer) => {
  const home = process.env.HOME;
  const root = mkdtempSync(join(tmpdir(), "send-agent-message-"));
  process.env.HOME = root;
  await settingsManager.reset();
  await settingsManager.initialize();
  const requests: Array<{
    user: string | null;
    body: Record<string, unknown>;
    path: string;
  }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({
        user: request.headers.get("X-Letta-Acting-User-Id"),
        body,
        path: new URL(request.url).pathname,
      });
      if (requests.length === 2) release();
      await gate;
      return Response.json(
        {
          client_message_id: body.client_message_id,
          workflow_id: "wf-1",
          super_run_id: "sr-1",
        },
        { status: 202 },
      );
    },
  });
  const env = {
    LETTA_BASE_URL: process.env.LETTA_BASE_URL,
    LETTA_API_KEY: process.env.LETTA_API_KEY,
    AGENT_ID: process.env.AGENT_ID,
    CONVERSATION_ID: process.env.CONVERSATION_ID,
  };
  const settings = spyOn(
    settingsManager,
    "getSettingsWithSecureTokens",
  ).mockImplementation(async () => settingsManager.getSettings());
  const lookups: unknown[] = [];
  __testSetBackend({
    capabilities: { environmentRouting: true },
    retrieveConversation: async (id: string, options: unknown) => {
      lookups.push(options);
      return {
        id,
        agent_id: id === "conv-first" ? "agent-first" : "agent-recipient",
      };
    },
  } as unknown as Backend);
  process.env.LETTA_BASE_URL = server.url.toString().replace(/\/$/, "");
  process.env.LETTA_API_KEY = "test-only";
  process.env.AGENT_ID = "agent-wrong-global";
  process.env.CONVERSATION_ID = "conv-wrong-global";
  try {
    const contexts = await Promise.all(
      ["first", "second"].map((id) =>
        prepareToolExecutionContextForSpecificTools(["SendAgentMessage"], {
          runtimeContext: {
            agentId: `agent-${id}`,
            conversationId: `conv-${id}`,
            actingUserId: `user-${id}`,
          },
        }),
      ),
    );
    const selfSend = await executeTool(
      "SendAgentMessage",
      {
        conversation_id: "conv-first",
        message: "Invoke myself",
        sender_agent_id: "agent-spoofed",
        parentScope: {
          agentId: "agent-spoofed",
          conversationId: "conv-spoofed",
        },
      },
      { toolContextId: contexts[0]?.contextId },
    );
    expect(selfSend.status).toBe("error");
    expect(JSON.parse(String(selfSend.toolReturn)).error).toBe(
      "Cannot message the current conversation. Use a Monitor or schedule for self-invocation.",
    );
    expect(requests).toHaveLength(0);
    const results = await Promise.all(
      contexts.map((context, index) =>
        executeTool(
          "SendAgentMessage",
          {
            conversation_id: "conv-recipient",
            message: `Message ${index}`,
            computer,
            sender_agent_id: "agent-spoofed",
            parentScope: {
              agentId: "agent-spoofed",
              conversationId: "conv-spoofed",
            },
          },
          { toolContextId: context.contextId },
        ),
      ),
    );
    for (const result of results) {
      expect(result.status).toBe("success");
      expect(JSON.parse(String(result.toolReturn))).toMatchObject({
        status: "queued",
        conversation_id: "conv-recipient",
      });
    }
    expect(requests).toHaveLength(2);
    for (const id of ["first", "second"]) {
      const request = requests.find((value) => value.user === `user-${id}`);
      expect(request?.path).toBe(
        "/v1/conversations/conv-recipient/messages/enqueue",
      );
      expect(request?.body).toMatchObject({
        agent_id: "agent-recipient",
      });
      if (computer?.trim()) {
        expect(request?.body.computer).toBe(computer.trim());
      } else {
        expect(request?.body).not.toHaveProperty("computer");
      }
      expect(request?.body.messages).toEqual([
        {
          role: "user",
          client_message_id: request?.body.client_message_id,
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                `agent-${id}, conversation conv-${id}`,
              ),
            },
            { type: "text", text: `Message ${id === "first" ? 0 : 1}` },
          ],
        },
      ]);
      expect(JSON.stringify(request?.body.messages)).toContain(
        `agent-${id}, conversation conv-${id}`,
      );
      expect(JSON.stringify(request?.body.messages)).not.toContain(
        "wrong-global",
      );
      expect(JSON.stringify(request?.body.messages)).not.toContain("spoofed");
      expect(lookups).toContainEqual(
        expect.objectContaining({
          headers: { "X-Letta-Acting-User-Id": `user-${id}` },
        }),
      );
    }
    expect(requests[0]?.body.client_message_id).not.toBe(
      requests[1]?.body.client_message_id,
    );
  } finally {
    release();
    server.stop(true);
    __testSetBackend(null);
    settings.mockRestore();
    clearCapturedToolExecutionContexts();
    await settingsManager.reset();
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
