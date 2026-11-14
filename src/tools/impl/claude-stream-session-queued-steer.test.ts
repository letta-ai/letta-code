import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetClaudeSessionsForTests,
  runClaudeTurn,
  sendClaudeMessage,
} from "./claude-stream-session";
import {
  awaitWithLiveLoop,
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

/** Starts a turn that is mid tool call and steers it; Claude never acks. */
async function steerWithoutAck(options: { acknowledgesInputs: boolean }) {
  const fixture = trackedFixture();
  let completed = false;
  const running = runClaudeTurn(
    { ...base, prompt: "old", sessionId: SESSION_ID },
    {
      createTransport: () => fixture.transport,
      controlResponseTimeoutMs: 20,
    },
  ).then((result) => {
    completed = true;
    return result;
  });
  await Bun.sleep(0);
  if (options.acknowledgesInputs) fixture.echo(0);
  fixture.emit({ type: "stream_event", event: { type: "message_start" } });
  const receipt = await awaitWithLiveLoop(
    sendClaudeMessage({ ...base, prompt: "new", sessionId: SESSION_ID }),
  );
  return { fixture, running, receipt, completed: () => completed };
}

function inputText(fixture: ReturnType<typeof trackedFixture>, index: number) {
  const message = parseWrite(fixture, index).message as {
    content: Array<{ text?: string }>;
  };
  return message.content[0]?.text;
}

describe("Claude steer queued behind an unacknowledged interrupt", () => {
  test("still writes the prompt and reports it as queued", async () => {
    const { fixture, receipt } = await steerWithoutAck({
      acknowledgesInputs: true,
    });
    expect(receipt).toEqual({
      mode: "steered",
      sessionId: SESSION_ID,
      queued: true,
    });
    expect(parseWrite(fixture, 1).type).toBe("control_request");
    expect(inputText(fixture, 2)).toBe("new");
  });

  test("a late ack writes nothing more and the queued turn is reported", async () => {
    const { fixture, running, completed } = await steerWithoutAck({
      acknowledgesInputs: true,
    });
    const control = parseWrite(fixture, 1);
    fixture.emit({
      type: "control_response",
      response: { subtype: "success", request_id: control.request_id },
    });
    // The late interrupt stops the long tool call and ends the old turn.
    fixture.emit({
      type: "result",
      is_error: true,
      subtype: "error_during_execution",
      result: "interrupted",
    });
    await Bun.sleep(0);
    expect(completed()).toBe(false);
    expect(fixture.writes).toHaveLength(3);
    // Claude then dequeues the steer and runs it as the next turn.
    fixture.echo(2);
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    fixture.emit({ type: "result", is_error: false, result: "new" });
    expect(await running).toMatchObject({ success: true, report: "new" });
    expect(fixture.writes.filter((w) => w.includes('"new"'))).toHaveLength(1);
  });

  test("reports the turn that picked the queued prompt up mid-turn", async () => {
    const { fixture, running } = await steerWithoutAck({
      acknowledgesInputs: true,
    });
    // The tool call finished first and Claude folded the prompt into the turn.
    fixture.echo(2);
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    fixture.emit({ type: "result", is_error: false, result: "new" });
    expect(await running).toMatchObject({ success: true, report: "new" });
  });

  test("without input acks, suppresses one result then reports the next", async () => {
    const { fixture, running, completed } = await steerWithoutAck({
      acknowledgesInputs: false,
    });
    fixture.emit({ type: "result", is_error: true, result: "interrupted" });
    await Bun.sleep(0);
    expect(completed()).toBe(false);
    fixture.emit({ type: "stream_event", event: { type: "message_start" } });
    fixture.emit({ type: "result", is_error: false, result: "new" });
    expect(await running).toMatchObject({ success: true, report: "new" });
  });
});
