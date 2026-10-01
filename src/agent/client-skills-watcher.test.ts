import { afterEach, describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { type FSWatcher, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";
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
  test("real filesystem notifications refresh a late symlinked skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "letta-live-skill-watch-"));
    tempRoots.push(root);
    // Production watcher registration is intentionally disabled in bun:test.
    // Run discovery in its own process rather than bypassing that wiring with
    // manual cache invalidation or a test watcher.
    const script = `
      import assert from 'node:assert/strict';
      import { mkdir, writeFile, symlink } from 'node:fs/promises';
      import { join } from 'node:path';
      import { buildClientSkillsPayload, buildClientSkillsUpdateReminder } from ${JSON.stringify(join(import.meta.dir, "client-skills.ts"))};
      const root = ${JSON.stringify(root)};
      const skillsDirectory = join(root, 'managed-skills');
      const target = join(root, 'repo', '.agents', 'skills', 'late-skill');
      await mkdir(skillsDirectory);
      await mkdir(target, { recursive: true });
      const options = { workingDirectory: root, skillsDirectory, skillSources: ['project'] };
      const initial = await buildClientSkillsPayload(options);
      assert.deepEqual(initial.clientSkills, []);
      async function writeSkill(description) {
        await writeFile(join(target, 'SKILL.md'), '---\\nname: late-skill\\ndescription: ' + description + '\\n---\\nBODY_STAYS_LAZY');
      }
      async function waitForDescription(description) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const snapshot = await buildClientSkillsPayload(options);
          if (snapshot.clientSkills[0]?.description === description) return snapshot;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error('Production watcher did not refresh: ' + description);
      }
      await writeSkill('Late repository skill');
      await symlink(target, join(skillsDirectory, 'late-skill'), process.platform === 'win32' ? 'junction' : 'dir');
      const added = await waitForDescription('Late repository skill');
      assert.match(buildClientSkillsUpdateReminder(initial.clientSkills, added.clientSkills), /Late repository skill/);
      // Discovery must rearm the watcher and follow the new symlink target.
      await writeSkill('Updated linked skill');
      const updated = await waitForDescription('Updated linked skill');
      assert.match(buildClientSkillsUpdateReminder(added.clientSkills, updated.clientSkills), /Updated linked skill/);
      console.log('production watcher passed');
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["-e", script],
      {
        env: createIsolatedCliTestEnv({
          NODE_ENV: "development",
          LETTA_DISABLE_SKILL_WATCHERS: "0",
          LETTA_CODE_TELEM: "0",
        }),
        timeout: 8000,
      },
    );
    expect(stdout).toContain("production watcher passed");
  }, 10000);

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
