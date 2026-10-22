import { afterEach, describe, expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend, type Backend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { clearConversationRuntimeState } from "./runtime";
import {
  sendApprovalContinuationWithRetry,
  sendMessageStreamWithRetry,
} from "./send";

type StreamChunk = Awaited<
  ReturnType<Backend["streamConversationMessages"]>
> extends Stream<infer Chunk>
  ? Chunk
  : never;

const busy = (id: string) =>
  new APIError(
    409,
    {
      detail: `Another request is currently being processed for this conversation. run_id=${id}`,
    },
    "busy",
    new Headers(),
  );

afterEach(() => __testSetBackend(null));

function fixture(approval: boolean) {
  const backend: Backend = new FakeHeadlessBackend("agent-busy");
  __testSetBackend(backend);
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-busy",
    "conv-busy",
  );
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  const messages: Array<MessageCreate | ApprovalCreate> = approval
    ? [
        {
          type: "approval",
          approvals: [
            {
              type: "tool",
              tool_call_id: "own-call",
              tool_return: "already executed",
              status: "success",
            },
          ],
          otid: "own-otid",
        },
      ]
    : [{ role: "user", content: "retained input", otid: "own-otid" }];
  const socket = {
    kind: "local" as const,
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  const options = {
    skillSources: [],
    preparedToolContext: {
      contextId: "test-busy",
      clientTools: [],
      clientSkills: [],
      loadedToolNames: [],
    },
  };
  const stream = new Stream<StreamChunk>(
    async function* () {},
    new AbortController(),
  );
  let posts = 0;
  let resumes = 0;
  let reads = 0;
  const submitted: unknown[] = [];
  backend.createConversationMessageStream = async (_id, body) => {
    posts++;
    submitted.push(structuredClone(body.messages));
    if (posts === 1) throw busy("run-foreign");
    return stream;
  };
  backend.streamConversationMessages = async (_id, body) => {
    resumes++;
    expect(body).toMatchObject({ otid: "own-otid" });
    expect(body).not.toHaveProperty("run_id");
    throw new Error("Own request was not accepted");
  };
  backend.retrieveRun = async (id, options) => {
    reads++;
    expect(id).toBe("run-foreign");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    return { id, status: "completed" } as never;
  };
  const send = () =>
    approval
      ? sendApprovalContinuationWithRetry(
          "conv-busy",
          messages,
          options,
          socket,
          runtime,
          lease,
        )
      : sendMessageStreamWithRetry(
          "conv-busy",
          messages,
          options,
          socket,
          runtime,
          lease,
        );
  return {
    backend,
    runtime,
    lease,
    messages,
    stream,
    submitted,
    send,
    counts: () => ({ posts, resumes, reads }),
  };
}

describe.each([false, true])("busy listener send (approval=%s)", (approval) => {
  test("failed same-request resume waits for metadata then resends retained input", async () => {
    const f = fixture(approval);
    expect(await f.send()).toEqual(
      approval ? { kind: "stream", stream: f.stream } : f.stream,
    );
    expect(f.counts()).toEqual({ posts: 2, resumes: 1, reads: 1 });
    expect(f.submitted[1]).toEqual(f.submitted[0]);
    expect(JSON.stringify(f.messages)).toContain("own-otid");
  });

  test.each(["unknown", "unavailable"])(
    "%s metadata cannot authorize an immediate resend",
    async (status) => {
      const f = fixture(approval);
      let resetTimer: ReturnType<typeof setTimeout> | undefined;
      f.backend.retrieveRun = async () => {
        resetTimer = setTimeout(
          () => clearConversationRuntimeState(f.runtime),
          1,
        );
        if (status === "unavailable")
          throw new Error("Run retrieval unavailable");
        return { status: "unrecognized" } as never;
      };
      try {
        await expect(f.send()).rejects.toThrow();
        expect(f.counts().posts).toBe(1);
      } finally {
        clearTimeout(resetTimer);
      }
    },
  );

  test("accepted same-request recovery never retries or reads blocker metadata", async () => {
    const f = fixture(approval);
    f.backend.streamConversationMessages = async (_id, body) => {
      expect(body).toMatchObject({ otid: "own-otid" });
      return f.stream;
    };
    expect(await f.send()).toEqual(
      approval ? { kind: "stream", stream: f.stream } : f.stream,
    );
    expect(f.counts()).toEqual({ posts: 1, resumes: 0, reads: 0 });
  });

  test("rotating settled blockers cannot bypass the send retry budget", async () => {
    const f = fixture(approval);
    let posts = 0;
    f.backend.createConversationMessageStream = async () => {
      throw busy(`run-rotating-${++posts}`);
    };
    let reads = 0;
    f.backend.retrieveRun = async () => {
      reads++;
      return { status: "completed" } as never;
    };
    await expect(f.send()).rejects.toThrow();
    expect(posts).toBe(4);
    expect(reads).toBe(3);
  });

  test("reset during metadata lookup cannot retry or alter the replacement lease", async () => {
    const f = fixture(approval);
    let started!: () => void;
    const lookup = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (value: never) => void;
    f.backend.retrieveRun = async () => {
      started();
      return new Promise<never>((resolve) => {
        finish = resolve;
      });
    };
    const sending = f.send();
    await lookup;
    clearConversationRuntimeState(f.runtime);
    const replacement = f.runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    await expect(sending).rejects.toThrow();
    finish({ status: "completed" } as never);
    await Promise.resolve();
    expect(f.counts().posts).toBe(1);
    expect(f.runtime.turnLifecycle.isCurrent(replacement)).toBe(true);
  });
});
