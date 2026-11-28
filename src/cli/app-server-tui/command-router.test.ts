import { describe, expect, test } from "bun:test";
import {
  type CommandContext,
  routeCommand,
  type SessionTarget,
  type TuiOverlay,
} from "./command-router";
import type { TuiSessionStore } from "./session-store";

interface Harness {
  context: CommandContext;
  serverCommands: Array<{ id: string; args?: string }>;
  requests: Array<Record<string, unknown>>;
  localInputs: string[];
  overlays: TuiOverlay[];
  switches: SessionTarget[];
  exits: number;
}

function harness(
  respond: (command: Record<string, unknown>) => unknown = () => ({
    success: true,
  }),
): Harness {
  const state: Harness = {
    serverCommands: [],
    requests: [],
    localInputs: [],
    overlays: [],
    switches: [],
    exits: 0,
    context: undefined as unknown as CommandContext,
  };
  const store = {
    getSnapshot: () => ({ hasOlder: false, device: null }),
    note: () => {},
    runServerCommand: async (id: string, args?: string) => {
      state.serverCommands.push({ id, args });
      return true;
    },
    runLocalCommand: async (
      input: string,
      run: () => Promise<{ output: string }>,
    ) => {
      state.localInputs.push(input);
      await run().catch(() => undefined);
    },
    request: async (command: Record<string, unknown>) => {
      state.requests.push(command);
      return respond(command);
    },
  } as unknown as TuiSessionStore;
  state.context = {
    store,
    agentId: "agent-1",
    conversationId: "conv-1",
    openOverlay: (overlay) => state.overlays.push(overlay),
    switchSession: (target) => state.switches.push(target),
    renameAgent: () => {},
    exit: () => {
      state.exits += 1;
    },
    logout: async () => "logged out",
    usage: async () => "usage",
    context: async () => "context",
    feedback: async () => "sent",
    setPinned: () => "pinned",
  };
  return state;
}

describe("TUI command router", () => {
  test("runtime-owned commands execute on the app server with their arguments", async () => {
    const state = harness();
    await routeCommand(state.context, "/compact");
    await routeCommand(state.context, "/context-limit 200000");
    await routeCommand(state.context, "/my-mod-command now");
    expect(state.serverCommands).toEqual([
      { id: "compact", args: "" },
      { id: "context-limit", args: "200000" },
      { id: "my-mod-command", args: "now" },
    ]);
    expect(state.requests).toEqual([]);
  });

  test("/new and /clear create a conversation for the agent and switch to it", async () => {
    const state = harness(() => ({
      success: true,
      conversation: { id: "conv-new" },
    }));
    await routeCommand(state.context, "/new");
    await routeCommand(state.context, "/clear");
    expect(state.requests).toEqual([
      { type: "conversation_create", body: { agent_id: "agent-1" } },
      { type: "conversation_create", body: { agent_id: "agent-1" } },
    ]);
    expect(state.switches).toEqual([
      { agentId: "agent-1", conversationId: "conv-new" },
      { agentId: "agent-1", conversationId: "conv-new" },
    ]);
  });

  test("a failed conversation create does not switch sessions", async () => {
    const state = harness(() => ({ success: false, conversation: null }));
    await routeCommand(state.context, "/new");
    expect(state.switches).toEqual([]);
  });

  test("pickers open as overlays and /resume with an id switches directly", async () => {
    const state = harness();
    await routeCommand(state.context, "/model");
    await routeCommand(state.context, "/agents");
    await routeCommand(state.context, "/resume conv-9");
    await routeCommand(state.context, "/exit");
    expect(state.overlays).toEqual(["model", "agents"]);
    expect(state.switches).toEqual([
      { agentId: "agent-1", conversationId: "conv-9" },
    ]);
    expect(state.exits).toBe(1);
  });

  test("/rename targets the agent or the conversation scope", async () => {
    const state = harness(() => ({
      success: true,
      agent: {},
      conversation: {},
    }));
    await routeCommand(state.context, "/rename agent Ada Lovelace");
    await routeCommand(state.context, "/rename convo Release notes");
    await routeCommand(state.context, "/rename nothing");
    expect(state.requests).toEqual([
      {
        type: "agent_update",
        agent_id: "agent-1",
        body: { name: "Ada Lovelace" },
      },
      {
        type: "conversation_update",
        conversation_id: "conv-1",
        body: { summary: "Release notes" },
      },
    ]);
  });
});
