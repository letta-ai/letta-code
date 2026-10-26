import { afterEach, describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { resolveAgentForModel } from "@/websocket/app-server-openai-common";

interface TestAgent {
  id: string;
  name?: string | null;
}

function setLookupBackend(options: {
  retrieveAgent?: (agentId: string) => Promise<TestAgent>;
  listAgents?: (body?: Record<string, unknown>) => Promise<unknown>;
}): void {
  __testSetBackend({
    retrieveAgent:
      options.retrieveAgent ??
      (async (agentId: string) => {
        throw Object.assign(new Error(`Agent ${agentId} not found`), {
          name: "LocalBackendNotFoundError",
        });
      }),
    listAgents: options.listAgents ?? (async () => []),
  } as unknown as Backend);
}

afterEach(() => {
  __testSetBackend(null);
});

describe("OpenAI model agent resolution", () => {
  test("retrieves agent-shaped model IDs without listing agents", async () => {
    const calls = { retrieve: 0, list: 0 };
    const agent = { id: "agent-local-direct", name: "Direct" };
    setLookupBackend({
      retrieveAgent: async (agentId) => {
        calls.retrieve += 1;
        expect(agentId).toBe(agent.id);
        return agent;
      },
      listAgents: async () => {
        calls.list += 1;
        return [];
      },
    });

    await expect(resolveAgentForModel(agent.id)).resolves.toEqual(agent);
    expect(calls).toEqual({ retrieve: 1, list: 0 });
  });

  test("preserves agent-shaped names as aliases after an ID miss", async () => {
    const alias = { id: "agent-local-owner", name: "agent-missing-alias" };
    const calls = { retrieve: 0, list: 0 };
    setLookupBackend({
      retrieveAgent: async () => {
        calls.retrieve += 1;
        throw Object.assign(new Error("not found"), { status: 404 });
      },
      listAgents: async () => {
        calls.list += 1;
        return [alias];
      },
    });

    await expect(resolveAgentForModel(alias.name)).resolves.toEqual(alias);
    expect(calls).toEqual({ retrieve: 1, list: 1 });
  });

  test("resolves an exact model name from a bounded server-side search", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const agent = { id: "agent-local-named", name: "Memo" };
    setLookupBackend({
      listAgents: async (body) => {
        calls.push(body);
        return [{ id: "agent-local-case", name: "memo" }, agent];
      },
    });

    await expect(resolveAgentForModel("Memo")).resolves.toEqual(agent);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query_text).toBe("Memo");
    expect(typeof calls[0]?.limit).toBe("number");
  });

  test("keeps duplicate model names ambiguous across search pages", async () => {
    const first = { id: "agent-local-first", name: "duplicate" };
    const second = { id: "agent-local-second", name: "duplicate" };
    const secondPage = {
      items: [second],
      hasNextPage: () => false,
    };
    setLookupBackend({
      listAgents: async () => ({
        items: [first],
        hasNextPage: () => true,
        getNextPage: async () => secondPage,
      }),
    });

    await expect(resolveAgentForModel("duplicate")).resolves.toBeNull();
  });

  test("keeps filtered name lookup complete across plain local pages", async () => {
    const target = { id: "agent-local-target", name: "needle" };
    const calls: Array<Record<string, unknown> | undefined> = [];
    setLookupBackend({
      listAgents: async (body) => {
        calls.push(body);
        if (body?.after) return { items: [target] };
        const limit = body?.limit as number;
        return {
          items: Array.from({ length: limit }, (_, index) => ({
            id: `agent-local-decoy-${index}`,
            name: `needle-${index}`,
          })),
        };
      },
    });

    await expect(resolveAgentForModel("needle")).resolves.toEqual(target);
    expect(calls).toHaveLength(2);
    expect(calls.every((body) => body?.query_text === "needle")).toBe(true);
  });

  test("propagates direct lookup permission errors to the request boundary", async () => {
    const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });
    setLookupBackend({
      retrieveAgent: async () => {
        throw forbidden;
      },
    });

    await expect(resolveAgentForModel("agent-cloud-secret")).rejects.toBe(
      forbidden,
    );
  });
});
