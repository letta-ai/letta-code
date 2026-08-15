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

  test("explicit projects inside protected home directories are allowed", async () => {
    const home = await mkdtemp(join(tmpdir(), "letta-file-protected-home-"));
    tempDirs.push(home);
    process.env.HOME = home;

    const project = join(home, "Documents", "my-project");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "README.md"), "hello");
    await writeFile(join(project, "src", "target.ts"), "ok");

    const listHarness = createHarness();
    expect(
      listHarness.session.handle({
        type: "list_in_directory",
        path: project,
        include_files: true,
        request_id: "req-protected-list",
      }),
    ).toBe(true);
    await listHarness.flush();
    expect(listHarness.sent[0]).toMatchObject({
      type: "list_in_directory_response",
      request_id: "req-protected-list",
      folders: ["src"],
      files: ["README.md"],
      success: true,
    });

    const treeHarness = createHarness();
    expect(
      treeHarness.session.handle({
        type: "get_tree",
        path: project,
        depth: 2,
        request_id: "req-protected-tree",
      }),
    ).toBe(true);
    await treeHarness.flush();
    expect(treeHarness.sent[0]).toMatchObject({
      type: "get_tree_response",
      request_id: "req-protected-tree",
      entries: [
        { path: "src", type: "dir" },
        { path: "README.md", type: "file" },
        { path: "src/target.ts", type: "file" },
      ],
      success: true,
    });

    const searchHarness = createHarness();
    expect(
      searchHarness.session.handle({
        type: "search_files",
        cwd: project,
        query: "target",
        max_results: 10,
        request_id: "req-protected-search",
      }),
    ).toBe(true);
    await searchHarness.flush();
    expect(searchHarness.sent[0]).toMatchObject({
      type: "search_files_response",
      request_id: "req-protected-search",
      files: [{ path: "src/target.ts", type: "file" }],
      success: true,
    });
  });

  test("read_file defaults to strict utf8 and rejects binary content", async () => {
    const root = await mkdtemp(join(tmpdir(), "letta-file-read-"));
    tempDirs.push(root);
    await writeFile(join(root, "note.txt"), "hello world");
    // A PNG header is invalid UTF-8 (0x89 lead byte).
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02,
    ]);
    await writeFile(join(root, "pixel.png"), pngBytes);

    const textHarness = createHarness();
    expect(
      textHarness.session.handle({
        type: "read_file",
        path: join(root, "note.txt"),
        request_id: "req-read-text",
      }),
    ).toBe(true);
    await textHarness.flush();
    expect(textHarness.sent[0]).toMatchObject({
      type: "read_file_response",
      request_id: "req-read-text",
      content: "hello world",
      encoding: "utf8",
      success: true,
    });

    const binaryHarness = createHarness();
    expect(
      binaryHarness.session.handle({
        type: "read_file",
        path: join(root, "pixel.png"),
        request_id: "req-read-binary",
      }),
    ).toBe(true);
    await binaryHarness.flush();
    expect(binaryHarness.sent[0]).toMatchObject({
      type: "read_file_response",
      request_id: "req-read-binary",
      content: null,
      success: false,
    });
  });

  test("read_file with base64 encoding returns raw bytes base64-encoded", async () => {
    const root = await mkdtemp(join(tmpdir(), "letta-file-read-b64-"));
    tempDirs.push(root);
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02,
    ]);
    await writeFile(join(root, "pixel.png"), pngBytes);

    const harness = createHarness();
    expect(
      harness.session.handle({
        type: "read_file",
        path: join(root, "pixel.png"),
        request_id: "req-read-b64",
        encoding: "base64",
      }),
    ).toBe(true);
    await harness.flush();
    expect(harness.sent[0]).toMatchObject({
      type: "read_file_response",
      request_id: "req-read-b64",
      content: pngBytes.toString("base64"),
      encoding: "base64",
      success: true,
    });
  });

  test("read_file rejects invalid encoding values at the protocol boundary", async () => {
    const harness = createHarness();
    expect(
      harness.session.handle({
        type: "read_file",
        path: "/tmp/whatever.png",
        request_id: "req-bad-encoding",
        encoding: "hex",
      }),
    ).toBe(false);
    expect(harness.sent).toHaveLength(0);
  });
});
