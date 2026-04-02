import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("listen agent-info wiring", () => {
  test("listener turns fetch and pass real agent metadata into the shared reminder context", () => {
    const turnPath = fileURLToPath(
      new URL("../../websocket/listener/turn.ts", import.meta.url),
    );
    const listenContextPath = fileURLToPath(
      new URL("../../reminders/listenContext.ts", import.meta.url),
    );
    const turnSource = readFileSync(turnPath, "utf-8");
    const listenContextSource = readFileSync(listenContextPath, "utf-8");

    expect(turnSource).toContain(
      "if (!runtime.reminderState.hasSentAgentInfo && agentId)",
    );
    expect(turnSource).toContain(
      "const agent = await client.agents.retrieve(agentId);",
    );
    expect(turnSource).toContain("name: agent.name ?? null,");
    expect(turnSource).toContain("description: agent.description ?? null,");
    expect(turnSource).toContain("lastRunAt:");
    expect(turnSource).toContain(
      "agentName: listenAgentMetadata?.name ?? null",
    );
    expect(turnSource).toContain(
      "agentDescription: listenAgentMetadata?.description ?? null",
    );
    expect(turnSource).toContain(
      "agentLastRunAt: listenAgentMetadata?.lastRunAt ?? null",
    );

    expect(listenContextSource).toContain("agentName?: string | null;");
    expect(listenContextSource).toContain("agentDescription?: string | null;");
    expect(listenContextSource).toContain("agentLastRunAt?: string | null;");
    expect(listenContextSource).toContain("name: params.agentName ?? null,");
    expect(listenContextSource).toContain(
      "description: params.agentDescription ?? null,",
    );
    expect(listenContextSource).toContain(
      "lastRunAt: params.agentLastRunAt ?? null,",
    );
  });
});
