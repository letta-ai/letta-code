import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type FSWatcher, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ClientSkillsWatcher,
  type SkillWatchFunction,
} from "./client-skills-watcher";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function createWatchHarness() {
  const calls: Array<{
    path: string;
    recursive: boolean;
    listener: (eventType: string, filename: string | Buffer | null) => void;
    close: ReturnType<typeof mock>;
  }> = [];
  const watchFunction: SkillWatchFunction = (path, options, listener) => {
    const emitter = new EventEmitter();
    const close = mock(() => {});
    calls.push({ path, recursive: options.recursive, listener, close });
    return Object.assign(emitter, {
      close,
      ref: () => emitter,
      unref: () => emitter,
    }) as unknown as FSWatcher;
  };
  return { calls, watchFunction };
}

describe("ClientSkillsWatcher", () => {
  test("watches a skill root and its symlinked directory targets", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "letta-skill-watch-"));
    tempRoots.push(tempRoot);
    const skillsRoot = join(tempRoot, "skills");
    const linkedSkills = join(tempRoot, "repository-skills");
    await mkdir(skillsRoot, { recursive: true });
    await mkdir(linkedSkills, { recursive: true });
    await symlink(linkedSkills, join(skillsRoot, "repository"));
    const onChange = mock(() => {});
    const { calls, watchFunction } = createWatchHarness();
    const watcher = new ClientSkillsWatcher(onChange, watchFunction);

    watcher.ensureRoots([skillsRoot]);

    expect(calls.map((call) => call.path).sort()).toEqual(
      [resolve(skillsRoot), realpathSync(linkedSkills)].sort(),
    );
    expect(calls.every((call) => call.recursive)).toBe(true);

    calls[1]?.listener("change", "SKILL.md");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(calls.every((call) => call.close.mock.calls.length === 1)).toBe(
      true,
    );
  });

  test("watches the next missing path segment without recursing", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "letta-skill-watch-missing-"),
    );
    tempRoots.push(tempRoot);
    const skillsRoot = join(tempRoot, ".agents", "skills");
    const onChange = mock(() => {});
    const { calls, watchFunction } = createWatchHarness();
    const watcher = new ClientSkillsWatcher(onChange, watchFunction);

    watcher.ensureRoots([skillsRoot]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(resolve(tempRoot));
    expect(calls[0]?.recursive).toBe(false);
    calls[0]?.listener("rename", "unrelated");
    expect(onChange).not.toHaveBeenCalled();
    calls[0]?.listener("rename", ".agents");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
