import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend } from "@/backend";
import { notifyConversationCompacted } from "@/backend/compaction-events";
import { parseSkillDeltaReminder } from "@/test-utils/skill-delta-reminder";
import {
  planClientSkillsRequest,
  resetClientSkillsBaselinesForTests,
} from "./client-skills-baseline";
import { configureClientSkillsBaselineStoreForTests } from "./client-skills-baseline-store";

const alpha = { name: "alpha", description: "A", location: "/alpha" };
const bravo = { name: "bravo", description: "B", location: "/bravo" };

describe("client_skills baseline", () => {
  test("an unaccepted plan neither freezes nor consumes the delta", () => {
    const backend = {} as Backend;
    const scope = { conversationId: "conv-1" };
    planClientSkillsRequest(backend, scope, [alpha]).accept();
    const rejected = planClientSkillsRequest(backend, scope, [alpha, bravo]);
    expect(rejected.clientSkills).toEqual([alpha]);
    const retry = planClientSkillsRequest(backend, scope, [alpha, bravo]);
    expect(retry.reminder).toBe(rejected.reminder);
    expect(parseSkillDeltaReminder(retry.reminder)?.added).toEqual(["bravo"]);
  });

  test("a default-conversation compaction re-baselines only that agent", () => {
    const backend = {} as Backend;
    const agentA = { conversationId: "default", agentId: "agent-a" };
    const agentB = { conversationId: "default", agentId: "agent-b" };
    planClientSkillsRequest(backend, agentA, [alpha]).accept();
    planClientSkillsRequest(backend, agentB, [alpha]).accept();
    notifyConversationCompacted({ backend, ...agentA });
    // Another backend instance's compaction is unrelated.
    notifyConversationCompacted({ backend: {}, ...agentB });
    const a = planClientSkillsRequest(backend, agentA, [alpha, bravo]);
    expect(a.clientSkills).toEqual([alpha, bravo]);
    expect(a.reminder).toBeNull();
    const b = planClientSkillsRequest(backend, agentB, [alpha, bravo]);
    expect(b.clientSkills).toEqual([alpha]);
    expect(parseSkillDeltaReminder(b.reminder)?.added).toEqual(["bravo"]);
  });

  test("a compaction before the first accepted request is a no-op", () => {
    const backend = {} as Backend;
    notifyConversationCompacted({ backend, conversationId: "conv-new" });
    const first = planClientSkillsRequest(
      backend,
      { conversationId: "conv-new" },
      [alpha],
    );
    expect(first.clientSkills).toEqual([alpha]);
    expect(first.reminder).toBeNull();
  });
});

describe("client_skills baseline persistence", () => {
  const backendIds = new WeakMap<object, string>();
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "client-skills-baseline-"));
    configureClientSkillsBaselineStoreForTests({
      rootDir: root,
      identify: (backend) => backendIds.get(backend) ?? null,
    });
  });

  afterEach(() => {
    configureClientSkillsBaselineStoreForTests(undefined);
    resetClientSkillsBaselinesForTests();
    rmSync(root, { recursive: true, force: true });
  });

  function backendFor(identity: string): Backend {
    const backend = {} as Backend;
    backendIds.set(backend, identity);
    return backend;
  }

  test("a restart reuses the frozen list and diffs against announced", () => {
    const scope = { conversationId: "conv-restart" };
    const before = backendFor("https://server-a.example");
    planClientSkillsRequest(before, scope, [alpha]).accept();
    planClientSkillsRequest(before, scope, [alpha, bravo]).accept();

    resetClientSkillsBaselinesForTests();
    const after = backendFor("https://server-a.example");
    const charlie = { name: "charlie", description: "C", location: "/c" };
    const plan = planClientSkillsRequest(after, scope, [alpha, bravo, charlie]);
    expect(plan.clientSkills).toEqual([alpha]);
    const delta = parseSkillDeltaReminder(plan.reminder);
    expect(delta?.added).toEqual(["charlie"]);
  });

  test("an unaccepted plan after a restart does not consume the delta", () => {
    const scope = { conversationId: "conv-reject" };
    planClientSkillsRequest(backendFor("srv"), scope, [alpha]).accept();
    resetClientSkillsBaselinesForTests();
    planClientSkillsRequest(backendFor("srv"), scope, [alpha, bravo]);
    resetClientSkillsBaselinesForTests();
    const retry = planClientSkillsRequest(backendFor("srv"), scope, [
      alpha,
      bravo,
    ]);
    expect(parseSkillDeltaReminder(retry.reminder)?.added).toEqual(["bravo"]);
  });

  test("compaction's re-baseline flag survives a restart", () => {
    const scope = { conversationId: "default", agentId: "agent-compact" };
    const before = backendFor("srv");
    planClientSkillsRequest(before, scope, [alpha]).accept();
    notifyConversationCompacted({ backend: before, ...scope });

    resetClientSkillsBaselinesForTests();
    const plan = planClientSkillsRequest(backendFor("srv"), scope, [
      alpha,
      bravo,
    ]);
    expect(plan.clientSkills).toEqual([alpha, bravo]);
    expect(plan.reminder).toBeNull();
  });

  test("a compaction seen only after a restart still re-baselines", () => {
    const scope = { conversationId: "conv-late-compact" };
    planClientSkillsRequest(backendFor("srv"), scope, [alpha]).accept();
    resetClientSkillsBaselinesForTests();
    const resumed = backendFor("srv");
    notifyConversationCompacted({ backend: resumed, ...scope });
    resetClientSkillsBaselinesForTests();
    const plan = planClientSkillsRequest(backendFor("srv"), scope, [bravo]);
    expect(plan.clientSkills).toEqual([bravo]);
    expect(plan.reminder).toBeNull();
  });

  test("corrupt data falls back to a fresh baseline", () => {
    const scope = { conversationId: "conv-corrupt" };
    planClientSkillsRequest(backendFor("srv"), scope, [alpha]).accept();
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files).toHaveLength(1);
    writeFileSync(files[0] as string, "{not json");

    resetClientSkillsBaselinesForTests();
    const plan = planClientSkillsRequest(backendFor("srv"), scope, [bravo]);
    expect(plan.clientSkills).toEqual([bravo]);
    expect(plan.reminder).toBeNull();
    plan.accept();
    resetClientSkillsBaselinesForTests();
    const next = planClientSkillsRequest(backendFor("srv"), scope, [bravo]);
    expect(next.clientSkills).toEqual([bravo]);
  });

  test("different backend identities do not share a baseline", () => {
    const scope = { conversationId: "conv-shared-id" };
    planClientSkillsRequest(backendFor("https://a.example"), scope, [
      alpha,
    ]).accept();
    resetClientSkillsBaselinesForTests();
    const other = planClientSkillsRequest(
      backendFor("https://b.example"),
      scope,
      [bravo],
    );
    expect(other.clientSkills).toEqual([bravo]);
    expect(other.reminder).toBeNull();
  });
});
