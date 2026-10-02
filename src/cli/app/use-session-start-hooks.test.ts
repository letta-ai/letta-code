import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import type { runSessionStartHooks } from "@/hooks";
import { useSessionStartHooks } from "./use-session-start-hooks";

type RunHooks = typeof runSessionStartHooks;
type Context = Parameters<typeof useSessionStartHooks>[0];
type Result = Awaited<ReturnType<RunHooks>>;

function result(feedback: string[] = []): Result {
  return { blocked: false, errored: false, feedback, results: [] };
}

async function flushEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function harness(runHooks: RunHooks, overrides: Partial<Context> = {}) {
  const context: Context = {
    agentId: "agent-a",
    agentName: "Agent A",
    conversationId: "conversation-a",
    commandRunning: false,
    isNewSessionRef: { current: false },
    feedbackRef: { current: [] },
    ...overrides,
  };
  function Harness() {
    useSessionStartHooks({ ...context }, runHooks);
    return null;
  }
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const instance = render(createElement(Harness), {
    stdout: stdout as NodeJS.WriteStream,
    stderr: stdout as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    context,
    async update(updates: Partial<Context>) {
      Object.assign(context, updates);
      instance.rerender(createElement(Harness));
      await flushEffects();
    },
    close() {
      instance.unmount();
      instance.cleanup();
      stdout.destroy();
    },
  };
}

describe("SessionStart session identity", () => {
  test("emits once for startup, resume, and returning to a prior conversation", async () => {
    const calls: Parameters<RunHooks>[] = [];
    const mounted = harness(async (...args) => {
      calls.push(args);
      return result();
    });
    try {
      await flushEffects();
      await mounted.update({ conversationId: "conversation-b" });
      await mounted.update({ conversationId: "conversation-a" });
      await mounted.update({ agentName: "Renamed agent" });
      await mounted.update({ commandRunning: true });
      await mounted.update({ commandRunning: false });
      expect(calls).toEqual([
        [false, "agent-a", "Agent A", "conversation-a"],
        [false, "agent-a", "Agent A", "conversation-b"],
        [false, "agent-a", "Agent A", "conversation-a"],
      ]);
    } finally {
      mounted.close();
    }
  });

  test("waits for loading and an atomic agent/conversation handoff", async () => {
    const calls: Parameters<RunHooks>[] = [];
    const mounted = harness(
      async (...args) => {
        calls.push(args);
        return result();
      },
      { agentId: "loading" },
    );
    try {
      await flushEffects();
      expect(calls).toEqual([]);
      await mounted.update({ agentId: "agent-a" });
      await mounted.update({ commandRunning: true, agentId: "agent-b" });
      await mounted.update({
        conversationId: "conversation-b",
        agentName: "Agent B",
      });
      expect(calls).toHaveLength(1);
      await mounted.update({ commandRunning: false });
      expect(calls[1]).toEqual([false, "agent-b", "Agent B", "conversation-b"]);
      await mounted.update({ commandRunning: true });
      await mounted.update({ commandRunning: false });
      expect(calls).toHaveLength(2);
    } finally {
      mounted.close();
    }
  });

  test("reports a new session only when the producer marks the new conversation", async () => {
    const calls: Parameters<RunHooks>[] = [];
    const mounted = harness(
      async (...args) => {
        calls.push(args);
        return result();
      },
      { isNewSessionRef: { current: true } },
    );
    try {
      await flushEffects();
      mounted.context.isNewSessionRef.current = true;
      await mounted.update({ conversationId: "conversation-new" });
      await mounted.update({ conversationId: "conversation-a" });
      expect(calls.map((args) => args[0])).toEqual([true, true, false]);
      expect(mounted.context.isNewSessionRef.current).toBe(false);
    } finally {
      mounted.close();
    }
  });

  test("clears unused previous feedback even when the next hook returns no output", async () => {
    let call = 0;
    const mounted = harness(async () =>
      result(call++ === 0 ? ["previous context"] : []),
    );
    try {
      await flushEffects();
      expect(mounted.context.feedbackRef.current).toEqual(["previous context"]);
      await mounted.update({ conversationId: "conversation-b" });
      expect(mounted.context.feedbackRef.current).toEqual([]);
    } finally {
      mounted.close();
    }
  });

  test("does not accept late feedback across an A to B to A transition", async () => {
    const pending: Array<(value: Result) => void> = [];
    const mounted = harness(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    try {
      await flushEffects();
      await mounted.update({ conversationId: "conversation-b" });
      await mounted.update({ conversationId: "conversation-a" });
      expect(pending).toHaveLength(3);
      pending[2]?.(result(["current A"]));
      await flushEffects();
      pending[0]?.(result(["stale A"]));
      pending[1]?.(result(["stale B"]));
      await flushEffects();
      expect(mounted.context.feedbackRef.current).toEqual(["current A"]);
    } finally {
      mounted.close();
    }
  });

  test("a hook rejection does not prevent the next session event", async () => {
    let calls = 0;
    const mounted = harness(async () => {
      calls += 1;
      if (calls === 1) throw new Error("test-only hook failure");
      return result(["next context"]);
    });
    try {
      await flushEffects();
      await mounted.update({ conversationId: "conversation-b" });
      expect(calls).toBe(2);
      expect(mounted.context.feedbackRef.current).toEqual(["next context"]);
    } finally {
      mounted.close();
    }
  });
});
