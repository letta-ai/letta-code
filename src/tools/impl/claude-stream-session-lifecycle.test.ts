import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetClaudeSessionsForTests,
  hasActiveClaudeTurn,
  runClaudeTurn,
  sendClaudeMessage,
} from "./claude-stream-session";
import {
  awaitWithLiveLoop,
  BACKGROUND_TEST_TIMEOUT_MS,
  base,
  parseWrite,
  SESSION_ID,
  teardownOpenFixtures,
  trackedFixture,
} from "./claude-stream-session.test-helpers";

afterEach(() => {
  teardownOpenFixtures();
  __resetClaudeSessionsForTests();
});

describe("Claude stream session lifecycle", () => {
  test(
    "cancellation still reaches a settled session whose process is alive",
    async () => {
      const fixture = trackedFixture({ exitOnStdinEnd: false });
      let killed = false;
      const controller = new AbortController();
      const result = await (async () => {
        const running = runClaudeTurn(
          {
            ...base,
            prompt: "work",
            sessionId: SESSION_ID,
            signal: controller.signal,
          },
          {
            createTransport: (options) => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  killed = true;
                  fixture.transport.wasAborted = () => true;
                  fixture.finish({ exitCode: null, exitSignal: "SIGTERM" });
                },
                { once: true },
              );
              return fixture.transport;
            },
          },
        );
        await Bun.sleep(0);
        fixture.emit({ type: "result", is_error: false, result: "done" });
        return running;
      })();
      expect(result).toMatchObject({ success: true, report: "done" });
      expect(fixture.ended()).toBe(true);
      expect(hasActiveClaudeTurn(SESSION_ID)).toBe(false);

      controller.abort(new Error("stopped"));
      expect(killed).toBe(true);
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "resume waits for a settled session's live process instead of spawning a second",
    async () => {
      const first = trackedFixture({ exitOnStdinEnd: false });
      const running = runClaudeTurn(
        { ...base, prompt: "work", sessionId: SESSION_ID },
        { createTransport: () => first.transport },
      );
      await Bun.sleep(0);
      first.emit({ type: "result", is_error: false, result: "done" });
      expect(await running).toMatchObject({ success: true, report: "done" });

      const second = trackedFixture();
      let creates = 0;
      const sending = sendClaudeMessage(
        { ...base, prompt: "next", sessionId: SESSION_ID },
        {
          createTransport: () => {
            creates++;
            return second.transport;
          },
        },
      );
      await Bun.sleep(10);
      expect(creates).toBe(0);

      first.finish({ exitCode: 0, exitSignal: null });
      const receipt = await sending;
      expect(receipt.mode).toBe("resumed");
      expect(creates).toBe(1);
      second.emit({ type: "result", is_error: false, result: "next" });
      expect(await receipt.completion).toMatchObject({
        success: true,
        report: "next",
      });
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "resume stops a settled process that outlives the exit grace period",
    async () => {
      const first = trackedFixture({ exitOnStdinEnd: false });
      let killed = false;
      const running = runClaudeTurn(
        { ...base, prompt: "work", sessionId: SESSION_ID },
        {
          createTransport: (options) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                killed = true;
                first.finish({ exitCode: null, exitSignal: "SIGTERM" });
              },
              { once: true },
            );
            return first.transport;
          },
        },
      );
      await Bun.sleep(0);
      first.emit({ type: "result", is_error: false, result: "done" });
      await running;

      const second = trackedFixture();
      let creates = 0;
      const receipt = await awaitWithLiveLoop(
        sendClaudeMessage(
          { ...base, prompt: "next", sessionId: SESSION_ID },
          {
            settledExitGraceMs: 10,
            createTransport: () => {
              creates++;
              expect(killed).toBe(true);
              return second.transport;
            },
          },
        ),
      );
      expect(receipt.mode).toBe("resumed");
      expect(creates).toBe(1);
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "concurrent resumes behind an exiting process start only one",
    async () => {
      const first = trackedFixture({ exitOnStdinEnd: false });
      const running = runClaudeTurn(
        { ...base, prompt: "work", sessionId: SESSION_ID },
        { createTransport: () => first.transport },
      );
      await Bun.sleep(0);
      first.emit({ type: "result", is_error: false, result: "done" });
      await running;

      const next = trackedFixture();
      let creates = 0;
      const deps = {
        createTransport: () => {
          creates++;
          return next.transport;
        },
      };
      const one = sendClaudeMessage(
        { ...base, prompt: "one", sessionId: SESSION_ID },
        deps,
      );
      const two = sendClaudeMessage(
        { ...base, prompt: "two", sessionId: SESSION_ID },
        deps,
      );
      await Bun.sleep(0);
      first.finish({ exitCode: 0, exitSignal: null });
      expect((await one).mode).toBe("resumed");
      next.emit({ type: "stream_event", event: { type: "message_start" } });
      await Bun.sleep(0);
      const control = parseWrite(next, 1);
      next.emit({
        type: "control_response",
        response: { subtype: "success", request_id: control.request_id },
      });
      expect((await two).mode).toBe("steered");
      expect(creates).toBe(1);
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "a background-completion result does not settle a newer input",
    async () => {
      const fixture = trackedFixture();
      let completed = false;
      const running = runClaudeTurn(
        { ...base, prompt: "work", sessionId: SESSION_ID },
        { createTransport: () => fixture.transport },
      ).then((result) => {
        completed = true;
        return result;
      });
      await Bun.sleep(0);
      fixture.echo(0);
      fixture.emit({ type: "stream_event", event: { type: "message_start" } });
      fixture.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "bg1", task_type: "local_bash" }],
      });
      fixture.emit({ type: "result", is_error: false, result: "STARTED" });
      await Bun.sleep(0);

      const receipt = await sendClaudeMessage({
        ...base,
        prompt: "FOLLOW-UP",
        sessionId: SESSION_ID,
      });
      expect(receipt.mode).toBe("steered");

      // The background task finishes and Claude runs its own wake-up turn
      // before it picks up the follow-up.
      fixture.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
      });
      fixture.emit({ type: "stream_event", event: { type: "message_start" } });
      fixture.emit({ type: "result", is_error: false, result: "" });
      await Bun.sleep(10);
      expect(completed).toBe(false);
      expect(fixture.ended()).toBe(false);

      fixture.echo(1);
      fixture.emit({ type: "stream_event", event: { type: "message_start" } });
      fixture.emit({ type: "result", is_error: false, result: "ANSWER" });
      expect(await running).toMatchObject({ success: true, report: "ANSWER" });
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );

  test(
    "a stray result before a resumed input starts does not settle it empty",
    async () => {
      const fixture = trackedFixture();
      const receipt = await sendClaudeMessage(
        { ...base, prompt: "first", sessionId: SESSION_ID },
        { createTransport: () => fixture.transport },
      );
      expect(receipt.mode).toBe("resumed");
      fixture.emit({
        type: "command_lifecycle",
        command_uuid: parseWrite(fixture, 0).uuid,
        state: "started",
      });
      fixture.emit({ type: "stream_event", event: { type: "message_start" } });
      fixture.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "bg1", task_type: "local_bash" }],
      });
      fixture.emit({ type: "result", is_error: false, result: "WAITING" });
      await Bun.sleep(0);
      await sendClaudeMessage({
        ...base,
        prompt: "second",
        sessionId: SESSION_ID,
      });
      let completed = false;
      void receipt.completion?.then(() => {
        completed = true;
      });
      fixture.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
      });
      fixture.emit({ type: "result", is_error: false, result: "" });
      await Bun.sleep(10);
      expect(completed).toBe(false);
      fixture.emit({
        type: "command_lifecycle",
        command_uuid: parseWrite(fixture, 1).uuid,
        state: "started",
      });
      fixture.emit({ type: "result", is_error: false, result: "second" });
      expect(await receipt.completion).toMatchObject({
        success: true,
        report: "second",
      });
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );
  test(
    "a result after settle does not rewrite the settled report",
    async () => {
      const fixture = trackedFixture({ exitOnStdinEnd: false });
      const running = runClaudeTurn(
        { ...base, prompt: "work", sessionId: SESSION_ID },
        { createTransport: () => fixture.transport },
      );
      await Bun.sleep(0);
      fixture.emit({ type: "result", is_error: false, result: "done" });
      const result = await running;
      fixture.emit({ type: "result", is_error: true, result: "late" });
      await Bun.sleep(10);
      expect(result).toMatchObject({ success: true, report: "done" });
      fixture.finish({ exitCode: 0, exitSignal: null });
      expect(await running).toMatchObject({ success: true, report: "done" });
    },
    BACKGROUND_TEST_TIMEOUT_MS,
  );
});
