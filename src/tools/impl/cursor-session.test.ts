import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { runCursorTurn, sendCursorMessage } from "./cursor-session";
import {
  formatExternalCodingAgentId,
  parseExternalCodingAgentId,
} from "./external-coding-agent";

const options = {
  parentAgentId: "agent-cursor-test",
  cwd: tmpdir(),
  prompt: "Do not run",
};

test("Cursor sessions round-trip through local and computer-qualified handles", () => {
  const id = randomUUID();
  for (const computer of [undefined, "office-mac"]) {
    const handle = formatExternalCodingAgentId("cursor", id, computer);
    expect(parseExternalCodingAgentId(handle)).toEqual({
      type: "cursor",
      sessionId: id,
      ...(computer ? { computer } : {}),
    });
  }
  expect(parseExternalCodingAgentId("cursor_../../other-session")).toBeNull();
  expect(parseExternalCodingAgentId(`cursor_${id}@`)).toBeNull();
});

test("Cursor fails before spawning when credentials or a first-turn model are absent", async () => {
  const missingKey = await runCursorTurn(
    { ...options, model: "composer-2.5" },
    {},
  );
  expect(missingKey.success).toBe(false);
  expect(missingKey.error).toContain("CURSOR_API_KEY");
  const missingModel = await runCursorTurn(options, {
    CURSOR_API_KEY: "test-not-a-key",
  });
  expect(missingModel.success).toBe(false);
  expect(missingModel.error).toContain("explicit model");
  expect(missingModel.error).not.toContain("test-not-a-key");
});

test("Cursor rejects cancelled work and unsafe persisted-session paths", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runCursorTurn(
    { ...options, signal: controller.signal },
    {},
  );
  expect(cancelled.success).toBe(false);
  expect(cancelled.error).toMatch(/aborted/i);
  const invalid = await runCursorTurn(
    { ...options, resumeSessionId: "../escape" },
    {},
  );
  expect(invalid.success).toBe(false);
  expect(invalid.error).toContain("Invalid Cursor session");
  await expect(
    sendCursorMessage({ ...options, sessionId: "../escape" }, {}),
  ).rejects.toThrow("Invalid Cursor session");
});
