import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { createFileCommandSession } from "./file-commands";

function createHarness() {
  const sent: unknown[] = [];
  const tasks: Promise<void>[] = [];
  const session = createFileCommandSession({
    socket: {} as WebSocket,
    safeSocketSend: (_socket, payload) => {
      sent.push(payload);
      return true;
    },
    runDetachedListenerTask: (_commandName, task) => {
      tasks.push(task());
    },
  });

  return {
    sent,
    session,
    async flush() {
      await Promise.all(tasks);
    },
  };
}

describe("listener file commands without file index", () => {
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(async () => {
    process.env.HOME = originalHome;
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("list_in_directory reads a single directory directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "letta-file-list-"));
    tempDirs.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "README.md"), "hello");

    const harness = createHarness();
    expect(
      harness.session.handle({
        type: "list_in_directory",
        path: root,
        include_files: true,
        request_id: "req-1",
      }),
    ).toBe(true);
    await harness.flush();

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({
      type: "list_in_directory_response",
      request_id: "req-1",
      folders: ["src"],
      files: ["README.md"],
      success: true,
    });
  });

  test("get_tree obeys requested depth without a global index", async () => {
    const root = await mkdtemp(join(tmpdir(), "letta-file-tree-"));
    tempDirs.push(root);
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export {};\n");
    await writeFile(join(root, "src", "nested", "deep.ts"), "export {};\n");

    const harness = createHarness();
    expect(
      harness.session.handle({
        type: "get_tree",
        path: root,
        depth: 1,
        request_id: "req-2",
      }),
    ).toBe(true);
    await harness.flush();

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({
      type: "get_tree_response",
      request_id: "req-2",
      entries: [{ path: "src", type: "dir" }],
      has_more_depth: true,
      success: true,
    });
  });

  test("search_files is scoped, path-only, and skips protected home dirs", async () => {
    const home = await mkdtemp(join(tmpdir(), "letta-file-home-"));
    tempDirs.push(home);
    process.env.HOME = home;

    await mkdir(join(home, "Pictures", "Photos Library.photoslibrary"), {
      recursive: true,
    });
    await mkdir(join(home, "dev", "project", "src"), { recursive: true });
    await writeFile(
      join(home, "Pictures", "Photos Library.photoslibrary", "secret.txt"),
      "nope",
    );
    await writeFile(join(home, "dev", "project", "src", "target.ts"), "ok");

    const homeListHarness = createHarness();
    expect(
      homeListHarness.session.handle({
        type: "list_in_directory",
        path: home,
        include_files: true,
        request_id: "req-home-list",
      }),
    ).toBe(true);
    await homeListHarness.flush();
    expect(homeListHarness.sent[0]).toMatchObject({
      type: "list_in_directory_response",
      request_id: "req-home-list",
      folders: ["dev"],
      success: true,
    });

    const protectedHarness = createHarness();
    expect(
      protectedHarness.session.handle({
        type: "search_files",
        cwd: home,
        query: "secret",
        max_results: 10,
        request_id: "req-3",
      }),
    ).toBe(true);
    await protectedHarness.flush();
    expect(protectedHarness.sent[0]).toMatchObject({
      type: "search_files_response",
      request_id: "req-3",
      files: [],
      success: true,
    });

    const projectHarness = createHarness();
    expect(
      projectHarness.session.handle({
        type: "search_files",
        cwd: join(home, "dev", "project"),
        query: "target",
        max_results: 10,
        request_id: "req-4",
      }),
    ).toBe(true);
    await projectHarness.flush();
    expect(projectHarness.sent[0]).toMatchObject({
      type: "search_files_response",
      request_id: "req-4",
      files: [{ path: "src/target.ts", type: "file" }],
      success: true,
    });
  });
});
