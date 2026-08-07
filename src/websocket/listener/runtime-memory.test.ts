import { describe, expect, test } from "bun:test";
import {
  getConversationSkillSources,
  setConversationRuntimeStateless,
} from "./runtime-memory";
import type {
  ConversationRuntime,
  ListenerConnectionState,
  ListenerRuntime,
} from "./types";

function makeRuntime(): {
  runtime: ConversationRuntime;
  connection: ListenerConnectionState;
} {
  const connection = {} as ListenerConnectionState;
  const listener = {
    connections: new Map([["connection-1", connection]]),
    statelessByConversation: new Set<string>(),
  } as ListenerRuntime;
  const runtime = {
    key: "agent:agent-1::conversation:conv-1",
    listener,
    agentId: "agent-1",
    stateless: false,
    skillSources: undefined,
  } as ConversationRuntime;
  return { runtime, connection };
}

describe("stateless conversation runtime policy", () => {
  test("keeps the policy on the conversation runtime scope", () => {
    const { runtime } = makeRuntime();

    setConversationRuntimeStateless(runtime, true);

    expect(runtime.stateless).toBe(true);
    expect(runtime.listener.statelessByConversation?.has(runtime.key)).toBe(
      true,
    );

    setConversationRuntimeStateless(runtime, false);
    expect(runtime.stateless).toBe(false);
    expect(runtime.listener.statelessByConversation?.has(runtime.key)).toBe(
      false,
    );
  });

  test("removes agent-scoped skills without changing explicit global sources", () => {
    const { runtime } = makeRuntime();
    runtime.stateless = true;
    runtime.skillSources = ["bundled", "agent", "project"];

    expect(getConversationSkillSources(runtime)).toEqual([
      "bundled",
      "project",
    ]);
  });

  test("uses non-agent skill defaults for stateless sessions", () => {
    const { runtime } = makeRuntime();
    runtime.stateless = true;

    expect(getConversationSkillSources(runtime)).toEqual([
      "bundled",
      "global",
      "project",
    ]);
  });
});
