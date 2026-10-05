import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
} from "./mod-adapter";
import { emitListenerTurnStart } from "./turn-events";
import type { ListenerRuntime } from "./types";

const root = mkdtempSync(join(tmpdir(), "letta-turn-start-cancel-"));

afterEach(() => {
  __listenerModAdapterTestUtils.resetForTests();
  rmSync(root, { force: true, recursive: true });
});

test("turn_start cancel notice names the cancelling mod and /reload", async () => {
  const modsDir = join(root, "mods");
  mkdirSync(modsDir, { recursive: true });
  writeFileSync(
    join(modsDir, "guard.ts"),
    `export default function(letta) {
      letta.events.on("turn_start", () => ({ cancel: { reason: "Guard offline." } }));
    }`,
  );
  __listenerModAdapterTestUtils.setAgentModsDirectoryResolverForTests(
    () => null,
  );
  __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
    async () => true,
  );
  const modAdapter = createListenerModAdapter({
    cacheDirectory: join(root, "cache"),
    globalModsDirectory: modsDir,
    workingDirectory: root,
  });
  await modAdapter.reload();
  const runtime = { modAdapter } as unknown as ListenerRuntime;

  const emission = await emitListenerTurnStart({
    agentId: "agent-1",
    conversationId: "conv-1",
    input: [{ role: "user", content: "hi" }],
    runtime,
    workingDirectory: root,
  });

  modAdapter.dispose();
  expect(emission).toMatchObject({ cancelled: true });
  expect(emission.cancelled && emission.reason).toMatch(
    /^Guard offline\.\n\nCancelled by mod `[^`]*guard\.ts`\. Edit or remove it, then run \/reload\.$/,
  );
});
