const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, readFileSync } = require("node:fs");
const { dirname, join, delimiter } = require("node:path");

const scenarios = ["normal", "busy", "accepted-own-otid"];
const requestOtid = "33333333-3333-4333-8333-333333333333";
const userText = "Keep this new input after the blocking run finishes.";

function parseExpectation(args) {
  if (args.length === 0) return "fixed";
  if (args.length === 2 && args[0] === "--expect" && ["fixed", "broken"].includes(args[1])) return args[1];
  throw new Error("Usage: node scripts/verify-busy-recovery.cjs [--expect fixed|broken]");
}

function childEnvironment(input = process.env) {
  // Allow only OS/process-location variables, not arbitrary provider credentials.
  const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|commonprogramfiles|number_of_processors|processor_architecture|lang|lc_all|term)$/i;
  const env = {};
  let pathValue = "";
  for (const [key, value] of Object.entries(input)) {
    if (key.toLowerCase() === "path") { pathValue = value; continue; }
    if (allowed.test(key)) env[key] = value;
  }
  env.PATH = `${dirname(process.execPath)}${delimiter}${pathValue}`;
  return Object.assign(env, { CI: "true", LETTA_CODE_TELEM: "0", DO_NOT_TRACK: "1", BUN_TELEMETRY_DISABLE: "1" });
}

function parseResult(stdout, scenario) {
  const marker = "TUI_BUSY_RESULT=";
  const lines = stdout.split(/\r?\n/).filter((line) => line.includes(marker));
  assert.equal(lines.length, 1, `${scenario}: expected exactly one result marker`);
  const result = JSON.parse(lines[0].slice(lines[0].indexOf(marker) + marker.length));
  assert.equal(result.scenario, scenario, "scenario mismatch");
  assert.equal(result.source, "useConversationLoop", "unexpected fixture source");
  assert.equal(result.bun, null, "fixture must execute under Node, not Bun");
  for (const field of ["sentPayloads", "acceptedPayloads", "resumeBodies", "errors"]) assert.ok(Array.isArray(result[field]), `${scenario}: invalid ${field}`);
  for (const field of ["virtualElapsedMs", "blockerCompletesAt", "runPolls"]) assert.ok(Number.isFinite(result[field]) && result[field] >= 0, `${scenario}: invalid ${field}`);
  return result;
}

function containsValue(value, expected) {
  if (value === expected) return true;
  return value !== null && typeof value === "object" && Object.values(value).some((item) => containsValue(item, expected));
}

function assertInput(result) {
  assert.ok(result.sentPayloads.length >= 1, "no original POST");
  assert.equal(result.acceptedPayloads.length, 1, "expected exactly one accepted input");
  assert.deepEqual(result.acceptedPayloads[0], result.sentPayloads[0], "accepted input differs from first POST");
  assert.ok(containsValue(result.acceptedPayloads[0], userText), "input text lost");
  assert.ok(containsValue(result.acceptedPayloads[0], requestOtid), "input OTID lost");
}

function assertFixed(result) {
  assertInput(result);
  assert.equal(result.lastStopReason, "end_turn", "turn did not finish");
  assert.deepEqual(result.errors, [], "unexpected UI errors");
  if (result.scenario === "busy") {
    assert.ok(result.runPolls > 0, "blocker was not polled");
    assert.equal(result.blockerCompletesAt, 90000);
    assert.ok(result.virtualElapsedMs >= 90000, "blocker not allowed to settle");
  } else {
    assert.equal(result.sentPayloads.length, 1, "unexpected duplicate POST");
    if (result.scenario === "accepted-own-otid") assert.ok(result.resumeBodies.some((body) => body.otid === requestOtid), "own OTID not resumed");
  }
}

function verifyResults(results, expectation) {
  assert.ok(["fixed", "broken"].includes(expectation), "invalid expectation");
  assert.equal(results.length, 3);
  for (const scenario of scenarios) assert.equal(results.filter((result) => result.scenario === scenario).length, 1);
  const normal = results.find((result) => result.scenario === "normal");
  assertFixed(normal); // A failed control can never count as an expected RED.
  if (expectation === "fixed") { for (const result of results) assertFixed(result); return; }
  const busy = results.find((result) => result.scenario === "busy");
  const own = results.find((result) => result.scenario === "accepted-own-otid");
  assert.throws(() => assertFixed(busy), "busy recovery unexpectedly passed");
  assert.throws(() => assertFixed(own), "own-OTID recovery unexpectedly passed");
  assert.equal(busy.acceptedPayloads.length, 0, "not the known baseline busy failure");
  assert.ok(busy.sentPayloads.length > 0);
  assert.ok(containsValue(busy.sentPayloads[0], userText));
  assert.ok(containsValue(busy.sentPayloads[0], requestOtid));
  assert.equal(busy.virtualElapsedMs, 70000, "not the known baseline retry horizon");
  assert.equal(busy.runPolls, 0, "baseline unexpectedly polled blocker");
  assert.notEqual(busy.lastStopReason, "end_turn");
  assertInput(own);
  assert.equal(own.sentPayloads.length, 1);
  assert.notEqual(own.lastStopReason, "end_turn", "baseline own request unexpectedly finished");
}

function runCommand(executable, args, env) {
  const child = spawnSync(executable, args, { cwd: process.cwd(), env, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `${executable} exited ${child.status} (${child.signal ?? "no signal"})\n${child.stderr}\n${child.stdout}`);
  return child.stdout;
}

function main() {
  const expectation = parseExpectation(process.argv.slice(2));
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 19), "Node >=22.19 required");
  assert.equal(process.versions.bun, undefined, "Invoke with Node, not Bun");
  const env = childEnvironment();
  console.log(`Node ${process.version} (${process.execPath}); Bun ${runCommand("bun", ["--version"], env).trim()}`);
  const root = process.cwd(); // The script can be copied across checkouts.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const output = join(root, ".letta", "busy-repro", "scenario.mjs");
  mkdirSync(dirname(output), { recursive: true });
  const externals = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), "bun:sqlite", "bun:test"])];
  runCommand("bun", ["build", join(root, "src", "test-utils", "TuiBusyRunScenario.tsx"), "--target=node", `--outfile=${output}`, ...externals.flatMap((name) => ["--external", name])], env);
  const results = scenarios.map((scenario) => {
    const result = parseResult(runCommand(process.execPath, [output, scenario], env), scenario);
    console.log(JSON.stringify(result));
    return result;
  });
  verifyResults(results, expectation);
  console.log(`PASS: expected ${expectation}; normal control and both recovery observations verified. Bundle retained: ${output}`);
}

module.exports = { parseExpectation, childEnvironment, parseResult, verifyResults };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
