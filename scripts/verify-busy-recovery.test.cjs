const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseResult, verifyResults, childEnvironment, parseExpectation } = require("./verify-busy-recovery.cjs");

function snapshot(scenario) {
  const payload = [{ content: "Keep this new input after the blocking run finishes.", otid: "33333333-3333-4333-8333-333333333333" }];
  return { scenario, source: "useConversationLoop", runtime: process.version, bun: null,
    sentPayloads: [payload], acceptedPayloads: [payload], errors: [], lastStopReason: "end_turn",
    resumeBodies: scenario === "accepted-own-otid" ? [{ otid: payload[0].otid }] : [],
    runPolls: scenario === "busy" ? 90 : 0, virtualElapsedMs: scenario === "busy" ? 90000 : 0, blockerCompletesAt: 90000 };
}
function results() { return ["normal", "busy", "accepted-own-otid"].map(snapshot); }
function broken() {
  const values = results();
  Object.assign(values[1], { acceptedPayloads: [], runPolls: 0, virtualElapsedMs: 70000, lastStopReason: null, errors: ["busy"] });
  Object.assign(values[2], { lastStopReason: null, errors: ["busy"] });
  return values;
}
test("fixed contracts and default expectation", () => {
  assert.equal(parseExpectation([]), "fixed");
  assert.doesNotThrow(() => verifyResults(results(), "fixed"));
});
test("broken requires both specific recovery failures and passing control", () => {
  assert.doesNotThrow(() => verifyResults(broken(), "broken"));
  assert.throws(() => verifyResults(broken(), "fixed"));
  assert.throws(() => verifyResults(results(), "broken"));
  const values = broken(); values[0].acceptedPayloads = [];
  assert.throws(() => verifyResults(values, "broken"));
});
test("broken cannot hide arbitrary recovery corruption", () => {
  const values = broken(); values[1].virtualElapsedMs = 1;
  assert.throws(() => verifyResults(values, "broken"));
  const own = broken(); own[2].acceptedPayloads = [];
  assert.throws(() => verifyResults(own, "broken"));
});
test("parser rejects absent marker, bad JSON, wrong scenario and source", () => {
  assert.throws(() => parseResult("nothing", "normal"));
  assert.throws(() => parseResult("TUI_BUSY_RESULT={", "normal"));
  assert.throws(() => parseResult(`TUI_BUSY_RESULT=${JSON.stringify(snapshot("busy"))}`, "normal"));
  assert.throws(() => parseResult(`TUI_BUSY_RESULT=${JSON.stringify({ ...snapshot("normal"), source: "other" })}`, "normal"));
  assert.deepEqual(parseResult(`noise\nTUI_BUSY_RESULT=${JSON.stringify(snapshot("normal"))}\n`, "normal"), snapshot("normal"));
});
test("fixed rejects payload loss, duplicate posts and missing own resume", () => {
  for (const mutate of [
    (v) => { v[1].acceptedPayloads = []; },
    (v) => { v[0].sentPayloads.push(v[0].sentPayloads[0]); },
    (v) => { v[2].resumeBodies = []; },
    (v) => { v[1].runPolls = 0; },
    (v) => { v[1].virtualElapsedMs = 70000; },
  ]) { const values = results(); mutate(values); assert.throws(() => verifyResults(values, "fixed")); }
});
test("arguments are strict", () => {
  assert.equal(parseExpectation(["--expect", "broken"]), "broken");
  for (const args of [["--expect"], ["--expect", "anything"], ["--unknown"]]) assert.throws(() => parseExpectation(args));
});
test("child environment removes credentials and injected runtime options", () => {
  const env = childEnvironment({ Path: "wrong", PATH: "right", LETTA_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", NODE_OPTIONS: "bad", BUN_OPTIONS: "bad", HOME: "home" });
  assert.equal(env.LETTA_API_KEY, undefined); assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.BUN_OPTIONS, undefined);
  assert.equal(env.CI, "true"); assert.equal(env.LETTA_CODE_TELEM, "0");
  assert.equal(Object.keys(env).filter((key) => key.toLowerCase() === "path").length, 1);
});
