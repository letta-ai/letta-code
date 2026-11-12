import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearNativeSessionCaptureForTests,
  findNativeSessionPath,
  getNativeSessionOwner,
  rememberNativeSession,
} from "./native-session-capture";

import {
  persistNativeSessionOwner,
  readNativeSessionOwner,
} from "./native-session-owner";

test("native owner survives listener state loss and cannot be reassigned", async () => {
  const directory = mkdtempSync(join(tmpdir(), "session-owner-"));
  const previous = process.env.LETTA_CONFIG_DIR;
  process.env.LETTA_CONFIG_DIR = directory;
  const scope = { agentId: "agent-parent", conversationId: "conv-parent" };
  const sessionId = "11111111-1111-4111-8111-111111111111";
  try {
    await clearNativeSessionCaptureForTests();
    for (const source of ["codex", "claude_code"] as const) {
      const nativeDir =
        source === "codex"
          ? join(directory, ".codex", "sessions", "2026", "11", "11")
          : join(directory, ".claude", "projects", "repo");
      mkdirSync(nativeDir, { recursive: true });
      const path = join(
        nativeDir,
        source === "codex"
          ? `rollout-2026-11-11-${sessionId}.jsonl`
          : `${sessionId}.jsonl`,
      );
      writeFileSync(path, "{}\n");
      persistNativeSessionOwner(source, sessionId, scope);
      expect(readNativeSessionOwner(source, sessionId)).toEqual(scope);
      expect(getNativeSessionOwner(source, sessionId)).toEqual(scope);
      expect(
        await findNativeSessionPath(source, sessionId, { HOME: directory }),
      ).toBe(path);
      rememberNativeSession(
        source,
        sessionId,
        { ...scope, conversationId: "conv-other" },
        "http://localhost:8283",
      );
      expect(getNativeSessionOwner(source, sessionId)).toEqual(scope);
      expect(getNativeSessionOwner(source, "missing")).toBeUndefined();
    }
  } finally {
    await clearNativeSessionCaptureForTests();
    if (previous === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
