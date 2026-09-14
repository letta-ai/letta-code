import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTING_USER_ID_HEADER } from "@/agent/acting-user";
import {
  runOutsideRuntimeContext,
  runWithRuntimeContext,
  updateRuntimeContext,
} from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { type TelemetryEvent, telemetry } from "@/telemetry";
import {
  captureToolExecutionContext,
  clearExternalTools,
  executeTool,
  registerExternalTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { trackListenerUserInput } from "@/websocket/listener/turn-transcript";

type Submission = {
  actingUserId: string | null;
  headers: Headers;
  body: { service: string; events: TelemetryEvent[] };
};

const envKeys = [
  "HOME",
  "LETTA_BASE_URL",
  "LETTA_API_KEY",
  "LETTA_DESKTOP_MODE",
  "LETTA_LOCAL_BACKEND_EXPERIMENTAL",
  "LETTA_ACTING_USER_ID",
  "LETTA_CODE_TELEM",
  "DO_NOT_TRACK",
] as const;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("telemetry acting-user HTTP attribution", () => {
  let server: ReturnType<typeof Bun.serve>;
  let home: string;
  let savedEnv: Record<string, string | undefined>;
  const submissions: Submission[] = [];
  let respond: (submission: Submission) => Response | Promise<Response>;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(
      envKeys.map((key) => [key, process.env[key]]),
    );
    home = await mkdtemp(join(tmpdir(), "telemetry-acting-user-"));
    process.env.HOME = home;
    process.env.LETTA_API_KEY = "test-runtime-key";
    process.env.LETTA_DESKTOP_MODE = "1";
    process.env.LETTA_CODE_TELEM = "1";
    delete process.env.DO_NOT_TRACK;
    delete process.env.LETTA_ACTING_USER_ID;
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    respond = () => new Response(null, { status: 200 });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/channel") {
          return Response.json({
            content: [{ type: "text", text: "sent" }],
            isError: false,
          });
        }
        expect(new URL(request.url).pathname).toBe("/v1/metadata/telemetry");
        const submission = {
          actingUserId: request.headers.get(ACTING_USER_ID_HEADER),
          headers: request.headers,
          body: (await request.json()) as Submission["body"],
        };
        submissions.push(submission);
        return respond(submission);
      },
    });
    process.env.LETTA_BASE_URL = server.url.toString().replace(/\/$/, "");
    await settingsManager.reset();
    await settingsManager.initialize();
    await telemetry.drain();
    submissions.length = 0;
  });

  afterEach(async () => {
    respond = () => new Response(null, { status: 200 });
    await telemetry.drain();
    server.stop(true);
    clearExternalTools();
    await settingsManager.reset();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(home, { recursive: true, force: true });
  });

  test("snapshots concurrent turns and sends only the acting-user header, never JSON identity", async () => {
    const firstCreated = deferred();
    const secondCreated = deferred();
    await Promise.all([
      runWithRuntimeContext({ actingUserId: "customer-a" }, async () => {
        telemetry.trackUserInput("first", "user", "model-a");
        firstCreated.resolve();
        await secondCreated.promise;
        telemetry.trackToolUsage("Read", true, 1);
        updateRuntimeContext({ actingUserId: "replacement-turn" });
      }),
      runWithRuntimeContext({ actingUserId: "customer-b" }, async () => {
        await firstCreated.promise;
        telemetry.trackUserInput("second", "user", "model-b");
        secondCreated.resolve();
      }),
    ]);
    runOutsideRuntimeContext(() =>
      telemetry.trackUserInput("local", "user", "model-local"),
    );
    await runWithRuntimeContext({ actingUserId: "flush-caller" }, () =>
      telemetry.drain(),
    );

    expect(submissions.map((request) => request.actingUserId).sort()).toEqual([
      "customer-a",
      "customer-b",
      null,
    ]);
    // Requests run concurrently: only ordering within an identity is defined.
    for (const actingUserId of ["customer-a", "customer-b", null]) {
      const request = submissions.find(
        (row) => row.actingUserId === actingUserId,
      );
      expect(request?.body.events.map((event) => event.type)).toEqual(
        actingUserId === "customer-a"
          ? ["user_input", "tool_usage"]
          : ["user_input"],
      );
    }
    for (const { headers, body } of submissions) {
      expect(headers.get("authorization")).toBe("Bearer test-runtime-key");
      expect(headers.get("X-Letta-Source")).toBe("letta-code");
      expect(headers.get("user-agent")).toStartWith("letta-code/");
      expect(headers.get("X-Letta-Code-Device-ID")).toBeTruthy();
      expect(body.service).toBe("letta-code");
      for (const event of body.events) {
        expect(Object.keys(event).sort()).toEqual([
          "data",
          "timestamp",
          "type",
        ]);
      }
      expect(JSON.stringify(body)).not.toMatch(
        /customer-|acting.?user|flush-caller|replacement-turn/i,
      );
    }
  });

  test("retries only failed groups while late events keep their own identity", async () => {
    const received = deferred();
    const release = deferred();
    respond = async ({ actingUserId }) => {
      if (actingUserId === "customer-a") {
        received.resolve();
        await release.promise;
      }
      return new Response(null, {
        status: actingUserId === "customer-b" ? 503 : 200,
      });
    };
    for (const actingUserId of ["customer-a", "customer-b"]) {
      runWithRuntimeContext({ actingUserId }, () =>
        telemetry.trackUserInput("input", "user", actingUserId),
      );
    }
    const first = telemetry.flush();
    const concurrent = telemetry.flush();
    // The server handshake makes the late-event race deterministic.
    await received.promise;
    runWithRuntimeContext({ actingUserId: "customer-c" }, () =>
      telemetry.trackToolUsage("Read", true, 1),
    );
    runOutsideRuntimeContext(() => telemetry.trackToolUsage("Write", true, 1));
    release.resolve();
    await Promise.all([first, concurrent]);
    expect(submissions.map((request) => request.actingUserId).sort()).toEqual([
      "customer-a",
      "customer-b",
    ]);

    respond = () => new Response(null, { status: 200 });
    await runWithRuntimeContext({ actingUserId: "retry-caller" }, () =>
      telemetry.drain(),
    );
    expect(submissions.map((request) => request.actingUserId).sort()).toEqual([
      "customer-a",
      "customer-b",
      "customer-b",
      "customer-c",
      null,
    ]);
    const failedGroupAttempts = submissions.filter(
      (request) => request.actingUserId === "customer-b",
    );
    expect(failedGroupAttempts).toHaveLength(2);
    expect(failedGroupAttempts[0]?.body.events).toEqual(
      failedGroupAttempts[1]?.body.events,
    );
    expect(submissions.map((request) => request.body.events.length)).toEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  test("resolves headless env identity at creation, not flush, and runtime wins", async () => {
    process.env.LETTA_ACTING_USER_ID = "headless-customer";
    telemetry.trackUserInput("headless", "user", "model");
    runWithRuntimeContext({ actingUserId: "turn-customer" }, () =>
      telemetry.trackToolUsage("Read", true, 1),
    );
    delete process.env.LETTA_ACTING_USER_ID;
    telemetry.trackUserInput("local", "user", "model");
    process.env.LETTA_ACTING_USER_ID = "later-env";
    await telemetry.drain();
    expect(submissions.map((request) => request.actingUserId).sort()).toEqual([
      "headless-customer",
      null,
      "turn-customer",
    ]);
  });

  test("listener input uses the inbound turn before its tool context exists", async () => {
    runWithRuntimeContext({ actingUserId: "unrelated-dispatch" }, () => {
      trackListenerUserInput(
        [{ role: "user", content: "hello" }],
        "model",
        "inbound-customer",
      );
      trackListenerUserInput(
        [{ role: "user", content: "direct" }],
        "model",
        undefined,
      );
    });
    await telemetry.drain();
    expect(submissions.map((request) => request.actingUserId).sort()).toEqual([
      "inbound-customer",
      null,
    ]);
  });

  test("external MessageChannel execution restores the captured turn context", async () => {
    registerExternalTools([
      {
        name: "MessageChannel",
        description: "HTTP channel transport",
        parameters: { type: "object", properties: {} },
        executor: async () =>
          (await (await fetch(new URL("/channel", server.url))).json()) as {
            content: { type: string; text: string }[];
            isError: boolean;
          },
      },
    ]);
    const context = runWithRuntimeContext(
      { actingUserId: "tool-customer", conversationId: "conversation-a" },
      () => captureToolExecutionContext(home),
    );
    try {
      const result = await runWithRuntimeContext(
        { actingUserId: "other-conversation" },
        () =>
          executeTool(
            "MessageChannel",
            { channel: "slack", action: "send" },
            { toolContextId: context.contextId },
          ),
      );
      expect(result.status).toBe("success");
      await telemetry.drain();
      expect(submissions.map((request) => request.actingUserId).sort()).toEqual(
        ["tool-customer"],
      );
      expect(submissions[0]?.body.events).toHaveLength(1);
      expect(submissions[0]?.body.events[0]?.data.channel).toBe("slack");
    } finally {
      releaseToolExecutionContext(context.contextId);
    }
  });
});
