// Bundled for Node and run by the OpenCode integration CI job.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  closeOpenCodeSessions,
  runOpenCodeTurn,
  sendOpenCodeMessage,
} from "./opencode-session";

test(
  "Node resumes native OpenCode sessions across server restarts",
  { timeout: 180_000 },
  async () => {
    assert.ok(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required");
    const root = await mkdtemp(join(tmpdir(), "opencode-node-"));
    const env = { ...process.env };
    for (const key of [
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ])
      env[key] = join(root, key);
    env.HOME = root;
    try {
      const first = await runOpenCodeTurn(
        {
          prompt:
            "Remember the word NODE_PROOF_681. Reply with exactly that word.",
          parentAgentId: "agent-test",
          cwd: root,
          model: process.env.OPENCODE_TEST_MODEL ?? "openai/gpt-5.6-luna",
        },
        env,
      );
      assert.equal(first.success, true, first.error);
      assert.match(first.report, /NODE_PROOF_681/);
      assert.ok(first.runtimeSessionId);
      // Repeat to exercise HTTP pooling when OpenCode reuses the same listen port.
      for (let i = 0; i < 2; i++) {
        await closeOpenCodeSessions();
        const receipt = await sendOpenCodeMessage(
          {
            sessionId: first.runtimeSessionId,
            prompt:
              "What was the word I asked you to remember? Reply with only that word.",
            parentAgentId: "agent-test",
            cwd: root,
          },
          env,
        );
        assert.equal(receipt.mode, "new_turn");
        const result = await receipt.completion;
        assert.equal(result?.success, true, result?.error);
        assert.equal(result?.runtimeSessionId, first.runtimeSessionId);
        assert.match(result?.report ?? "", /NODE_PROOF_681/);
      }
    } finally {
      await closeOpenCodeSessions();
      await rm(root, { recursive: true, force: true });
    }
  },
);
