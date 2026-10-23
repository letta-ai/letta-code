const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  minimalEnv,
  assertTools,
  readMessages,
  messageKey,
  assertSum,
} = require("./scenario.cjs");

test("numeric results accept decimal notation but reject wrong values and commentary", () => {
  assertSum("64", 64);
  assertSum("64.0", 64);
  assert.throws(() => assertSum("65", 64));
  assert.throws(() => assertSum("The answer is 64", 64));
  assert.throws(() => assertSum("", 0));
});

test("message IDs are scoped to their conversation", () => {
  const first = {
    id: "ui-msg-1",
    metadata: { conversation_id: "local-conv-1" },
  };
  const second = {
    id: "ui-msg-1",
    metadata: { conversation_id: "local-conv-2" },
  };
  assert.notEqual(messageKey(first), messageKey(second));
  assert.equal(messageKey(first), messageKey({ ...first }));
});

test("TUI observations unwrap persisted transcript messages, not session records", () => {
  const store = fs.mkdtempSync(
    path.join(os.tmpdir(), "ollama-transcript-test-"),
  );
  try {
    const dir = path.join(store, "conversations", "fixture");
    fs.mkdirSync(dir, { recursive: true });
    const message = { id: "m1", role: "assistant", stopReason: "stop" };
    fs.writeFileSync(
      path.join(dir, "messages.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "c1" }),
        JSON.stringify({ type: "message", message }),
        '{"type":"message"', // A concurrent writer may not have finished its line.
      ].join("\n"),
    );
    assert.deepEqual(readMessages(store), [message]);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("agent environment excludes all ambient infrastructure and provider secrets", () => {
  const name = "TAILSCALE_ACCESS_TOKEN";
  const previous = process.env[name];
  process.env[name] = "test-secret";
  try {
    const env = minimalEnv("/tmp/isolated");
    assert.equal(env[name], undefined);
    assert.equal(env.LETTA_API_KEY, undefined);
    assert.equal(env.MODAL_TOKEN_SECRET, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.HOME, "/tmp/isolated");
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("a claimed success word or unpaired/failed tool result cannot pass", () => {
  assert.throws(() => assertTools([{ type: "result", result: "DONE" }]));
  const call = {
    message_type: "tool_call_message",
    tool_call: { tool_call_id: "a" },
  };
  assert.throws(() => assertTools([call]));
  assert.throws(() =>
    assertTools([
      call,
      {
        message_type: "tool_return_message",
        tool_call_id: "b",
        status: "success",
      },
    ]),
  );
  assert.throws(() =>
    assertTools([
      call,
      {
        message_type: "tool_return_message",
        tool_call_id: "a",
        status: "error",
      },
    ]),
  );
  assertTools([
    call,
    {
      message_type: "tool_return_message",
      tool_call_id: "a",
      status: "success",
    },
  ]);
});
