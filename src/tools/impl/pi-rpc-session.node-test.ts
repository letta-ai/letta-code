// Bundled for Node and run by the pi integration CI job.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  fakePiModelsJson,
  startFakeOpenAiChatServer,
} from "@/test-utils/fake-openai-chat-server";
import { closePiSessions, runPiTurn, sendPiMessage } from "./pi-rpc-session";

test(
  "Node runs and resumes native pi sessions across processes",
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-node-"));
    const provider = await startFakeOpenAiChatServer();
    const agentDir = join(root, "pi-agent");
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "models.json"),
      fakePiModelsJson(provider.baseUrl),
    );
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    };
    try {
      const first = await runPiTurn(
        {
          prompt: "RUN_TOOL in node",
          parentAgentId: "agent-test",
          cwd: root,
          model: "fake/fake-1",
        },
        env,
      );
      assert.equal(first.success, true, first.error);
      assert.equal(first.report, "Tool said: tool-ran");
      assert.ok(first.runtimeSessionId);
      await closePiSessions();
      const receipt = await sendPiMessage(
        {
          sessionId: first.runtimeSessionId,
          prompt: "again",
          parentAgentId: "agent-test",
          cwd: root,
        },
        env,
      );
      assert.equal(receipt.mode, "new_turn");
      const result = await receipt.completion;
      assert.equal(result?.success, true, result?.error);
      assert.equal(result?.report, "Turns so far: 2");
    } finally {
      await closePiSessions();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
