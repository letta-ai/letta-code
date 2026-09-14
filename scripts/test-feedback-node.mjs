// Run after `bun run build`. Exercises the published Node CLI against a local
// Desktop metadata proxy, without contacting Cloud or loading user credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "feedback-node-"));
let response = { success: true };
let status = 200;
const submissions = [];
const server = createServer(async (req, res) => {
  assert.equal(req.url, "/v1/metadata/feedback");
  let body = "";
  for await (const chunk of req) body += chunk;
  submissions.push(JSON.parse(body));
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(response));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
async function run() {
  const child = spawn(
    process.execPath,
    ["letta.js", "feedback", "--message", "Fixture feedback"],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LETTA_HOME: join(home, ".letta"),
        LETTA_DESKTOP_MODE: "1",
        LETTA_BASE_URL: url,
        LETTA_API_KEY: "fixture-local-proxy",
        AGENT_ID: "fixture-agent",
        CONVERSATION_ID: "fixture-conversation",
        LETTA_DISABLE_TELEMETRY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}
try {
  let result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Feedback submitted/);
  response = {
    success: false,
    status: "rejected",
    message: "Fixture correction. Do not retry this report.",
  };
  result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, response.message);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].agent_id, "fixture-agent");
  assert.equal(submissions[1].conversation_id, "fixture-conversation");
  status = 503;
  response = { error: "fixture unavailable" };
  result = await run();
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, /submitted/);
  assert.match(result.stderr, /Could not submit feedback/);
  console.log(
    "PASS: built Node CLI preserves rejection, legacy acceptance, identifiers, and service failures",
  );
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}
