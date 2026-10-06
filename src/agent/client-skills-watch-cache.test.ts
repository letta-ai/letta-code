import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import {
  buildClientSkillsPayload,
  invalidateClientSkillsPayloadCache,
} from "@/agent/client-skills";
import {
  ClientSkillsWatcher,
  type SkillWatchFunction,
} from "@/agent/client-skills-watcher";
import { getBundledSkillsPath } from "@/agent/skills";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";

const WATCHER_KEY = Symbol.for("@letta/clientSkillsWatcher");
const globalState = globalThis as unknown as Record<symbol, unknown>;

let restoreAmbientEnv: (() => void) | undefined;
let previousWatcher: unknown;
let previousNodeEnv: string | undefined;
let previousDisable: string | undefined;
const tempRoots: string[] = [];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/** Route production cache wiring through a test watch function. */
function installWatcher(watchFunction: SkillWatchFunction): void {
  globalState[WATCHER_KEY] = new ClientSkillsWatcher(
    () => invalidateClientSkillsPayloadCache(),
    watchFunction,
  );
  process.env.NODE_ENV = "development";
  process.env.LETTA_DISABLE_SKILL_WATCHERS = "0";
}

beforeEach(() => {
  restoreAmbientEnv = isolateAmbientLettaTestEnv();
  previousWatcher = globalState[WATCHER_KEY];
  previousNodeEnv = process.env.NODE_ENV;
  previousDisable = process.env.LETTA_DISABLE_SKILL_WATCHERS;
  invalidateClientSkillsPayloadCache();
});

afterEach(async () => {
  (globalState[WATCHER_KEY] as ClientSkillsWatcher | undefined)?.close();
  if (previousWatcher === undefined) {
    delete globalState[WATCHER_KEY];
  } else {
    globalState[WATCHER_KEY] = previousWatcher;
  }
  restoreEnv("NODE_ENV", previousNodeEnv);
  restoreEnv("LETTA_DISABLE_SKILL_WATCHERS", previousDisable);
  invalidateClientSkillsPayloadCache();
  restoreAmbientEnv?.();
  restoreAmbientEnv = undefined;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("client skills cache watcher coverage", () => {
  test("does not serve a cached catalog when a skill root cannot be watched", async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), "letta-cache-unwatched-"));
    tempRoots.push(tempRoot);
    const skillsDir = join(tempRoot, ".agents", "skills");
    const skillDir = join(skillsDir, "doomed-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: doomed-skill\ndescription: will be deleted\n---\nBody",
    );
    // Simulate watch() failing, e.g. when the inotify watch limit is hit.
    installWatcher(() => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
    const options = {
      workingDirectory: tempRoot,
      skillsDirectory: skillsDir,
      skillSources: ["project" as const],
    };

    const before = await buildClientSkillsPayload(options);
    expect(before.clientSkills.map((skill) => skill.name)).toEqual([
      "doomed-skill",
    ]);

    await rm(skillDir, { recursive: true, force: true });

    const after = await buildClientSkillsPayload(options);
    expect(after.clientSkills).toEqual([]);
  });

  test("watches the bundled skills directory when bundled skills are enabled", async () => {
    const watchedPaths: string[] = [];
    installWatcher((path) => {
      watchedPaths.push(path);
      return Object.assign(new EventEmitter(), {
        close: () => {},
      }) as unknown as FSWatcher;
    });

    await buildClientSkillsPayload({ skillSources: ["bundled"] });

    expect(watchedPaths).toContain(resolve(getBundledSkillsPath()));
  });
});
