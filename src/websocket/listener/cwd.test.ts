import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConversationWorkingDirectory,
  getWorkingDirectoryScopeKey,
  setConversationWorkingDirectory,
} from "./cwd";
import type { ListenerRuntime } from "./types";

const BOOT = "/boot/dir";
const AGENT = "agent-local-test";
const AGENT_DEFAULT = "/agent/default/dir";
const CONV = "local-conv-abc";

function makeRuntime(entries: Record<string, string> = {}): ListenerRuntime {
  return {
    bootWorkingDirectory: BOOT,
    workingDirectoryByConversation: new Map(Object.entries(entries)),
  } as unknown as ListenerRuntime;
}

const agentDefaultKey = getWorkingDirectoryScopeKey(AGENT, "default");
const convKey = getWorkingDirectoryScopeKey(AGENT, CONV);

describe("getConversationWorkingDirectory", () => {
  test("returns the explicit per-conversation override when present", () => {
    const runtime = makeRuntime({
      [convKey]: "/explicit/dir",
      [agentDefaultKey]: AGENT_DEFAULT,
    });
    expect(getConversationWorkingDirectory(runtime, AGENT, CONV)).toBe(
      "/explicit/dir",
    );
  });

  // Regression: a real conversation with no explicit override must inherit the
  // agent's saved default working directory, not silently fall back to boot.
  test("falls back to the per-agent default for a new conversation", () => {
    const runtime = makeRuntime({ [agentDefaultKey]: AGENT_DEFAULT });
    expect(getConversationWorkingDirectory(runtime, AGENT, CONV)).toBe(
      AGENT_DEFAULT,
    );
  });

  test("falls back to boot when no per-agent default is set", () => {
    const runtime = makeRuntime();
    expect(getConversationWorkingDirectory(runtime, AGENT, CONV)).toBe(BOOT);
  });

  test("resolves the agent-default scope to its stored value", () => {
    const runtime = makeRuntime({ [agentDefaultKey]: AGENT_DEFAULT });
    expect(getConversationWorkingDirectory(runtime, AGENT, "default")).toBe(
      AGENT_DEFAULT,
    );
  });

  test("agent-default scope inherits boot (no higher tier)", () => {
    const runtime = makeRuntime();
    expect(getConversationWorkingDirectory(runtime, AGENT, "default")).toBe(
      BOOT,
    );
  });
});

describe("setConversationWorkingDirectory", () => {
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "cwd-test-home-"));
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  });

  test("stores an override that differs from the inherited default", () => {
    const runtime = makeRuntime({ [agentDefaultKey]: AGENT_DEFAULT });
    setConversationWorkingDirectory(runtime, AGENT, CONV, "/picked/dir");
    expect(runtime.workingDirectoryByConversation.get(convKey)).toBe(
      "/picked/dir",
    );
  });

  test("drops a redundant override equal to the per-agent default", () => {
    const runtime = makeRuntime({
      [agentDefaultKey]: AGENT_DEFAULT,
      [convKey]: "/stale/dir",
    });
    setConversationWorkingDirectory(runtime, AGENT, CONV, AGENT_DEFAULT);
    expect(runtime.workingDirectoryByConversation.has(convKey)).toBe(false);
    // Resolution still yields the agent default after the redundant entry is dropped.
    expect(getConversationWorkingDirectory(runtime, AGENT, CONV)).toBe(
      AGENT_DEFAULT,
    );
  });

  test("preserves an explicit boot-dir choice when a different agent default exists", () => {
    const runtime = makeRuntime({ [agentDefaultKey]: AGENT_DEFAULT });
    setConversationWorkingDirectory(runtime, AGENT, CONV, BOOT);
    // Boot differs from the agent default, so the explicit choice is kept.
    expect(runtime.workingDirectoryByConversation.get(convKey)).toBe(BOOT);
    expect(getConversationWorkingDirectory(runtime, AGENT, CONV)).toBe(BOOT);
  });

  test("drops an override equal to boot when no agent default exists", () => {
    const runtime = makeRuntime({ [convKey]: "/stale/dir" });
    setConversationWorkingDirectory(runtime, AGENT, CONV, BOOT);
    expect(runtime.workingDirectoryByConversation.has(convKey)).toBe(false);
  });
});
