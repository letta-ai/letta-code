// Run against the bundled Node worker, not only Bun's source execution path.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCursorTurn, sendCursorMessage } from "./cursor-session";
import { resolveCursorTestModel } from "./cursor-test-model";

test(
  "Node runs and resumes a Cursor SDK session across worker exits",
  { timeout: 180_000 },
  async () => {
    assert.ok(process.env.CURSOR_API_KEY, "CURSOR_API_KEY is required");
    const root = await mkdtemp(join(tmpdir(), "cursor-node-"));
    const oldHome = process.env.HOME;
    process.env.HOME = root;
    const options = { parentAgentId: "agent-cursor-node", cwd: root };
    try {
      const model = await resolveCursorTestModel(root);
      const first = await runCursorTurn({
        ...options,
        model,
        prompt: "Remember NODE_PROOF_681. Reply with that phrase.",
      });
      assert.equal(first.success, true, first.error);
      assert.ok(first.runtimeSessionId);
      assert.match(first.report, /NODE_PROOF_681/);
      const receipt = await sendCursorMessage({
        ...options,
        sessionId: first.runtimeSessionId,
        prompt: "What phrase did I ask you to remember? Reply with it.",
      });
      assert.equal(receipt.mode, "new_turn");
      const result = await receipt.completion;
      assert.equal(result?.success, true, result?.error);
      assert.equal(result?.runtimeSessionId, first.runtimeSessionId);
      assert.match(result?.report ?? "", /NODE_PROOF_681/);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      await rm(root, { recursive: true, force: true });
    }
  },
);
