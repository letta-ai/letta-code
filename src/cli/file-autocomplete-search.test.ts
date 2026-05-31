import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchFileAutocomplete } from "@/cli/helpers/file-autocomplete-search";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "letta-file-ac-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function paths(results: Awaited<ReturnType<typeof searchFileAutocomplete>>) {
  return results.map((result) => result.path);
}

describe("searchFileAutocomplete", () => {
  test("bare @ lists only the current directory", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "README.md"), "# hello");
      await writeFile(join(dir, "src", "index.ts"), "export {};\n");

      const results = await searchFileAutocomplete("", {
        cwd: dir,
        homeDirectory: join(dir, "home"),
      });

      expect(paths(results)).toContain("README.md");
      expect(paths(results)).toContain("src");
      expect(paths(results)).not.toContain(join("src", "index.ts"));
    });
  });

  test("non-empty fuzzy query shells out to path-only recursive search", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src", "components"), { recursive: true });
      await writeFile(join(dir, "src", "components", "Button.tsx"), "button");
      await writeFile(join(dir, "src", "index.ts"), "export {};\n");

      const results = await searchFileAutocomplete("Button", {
        cwd: dir,
        homeDirectory: join(dir, "home"),
      });

      expect(paths(results)).toContain(join("src", "components", "Button.tsx"));
    });
  });

  test("path-like queries use shallow path completion", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src", "components"), { recursive: true });
      await writeFile(join(dir, "src", "components", "Button.tsx"), "button");

      const directoryResults = await searchFileAutocomplete("src/com", {
        cwd: dir,
        homeDirectory: join(dir, "home"),
      });
      expect(paths(directoryResults)).toEqual([join("src", "components")]);

      const childResults = await searchFileAutocomplete("src/components/", {
        cwd: dir,
        homeDirectory: join(dir, "home"),
      });
      expect(paths(childResults)).toEqual([
        join("src", "components", "Button.tsx"),
      ]);
    });
  });

  test("home-directory fuzzy queries stay shallow until the user enters a path", async () => {
    await withTempDir(async (homeDir) => {
      await mkdir(join(homeDir, "dev", "project"), { recursive: true });
      await writeFile(join(homeDir, "needle-top.ts"), "top");
      await writeFile(
        join(homeDir, "dev", "project", "needle-deep.ts"),
        "deep",
      );

      const homeResults = await searchFileAutocomplete("needle", {
        cwd: homeDir,
        homeDirectory: homeDir,
      });
      expect(paths(homeResults)).toContain("needle-top.ts");
      expect(paths(homeResults)).not.toContain(
        join("dev", "project", "needle-deep.ts"),
      );

      const explicitPathResults = await searchFileAutocomplete("dev/pro", {
        cwd: homeDir,
        homeDirectory: homeDir,
      });
      expect(paths(explicitPathResults)).toEqual([join("dev", "project")]);
    });
  });

  test("protected macOS home directories are skipped before traversal", async () => {
    await withTempDir(async (homeDir) => {
      await mkdir(join(homeDir, "Pictures"), { recursive: true });
      await mkdir(join(homeDir, "dev"), { recursive: true });
      await writeFile(join(homeDir, "Pictures", "photo.ts"), "photo");
      await writeFile(join(homeDir, "dev", "project.ts"), "project");

      const bareResults = await searchFileAutocomplete("", {
        cwd: homeDir,
        homeDirectory: homeDir,
      });
      expect(paths(bareResults)).not.toContain("Pictures");
      expect(paths(bareResults)).toContain("dev");

      const protectedResults = await searchFileAutocomplete("Pictures/photo", {
        cwd: homeDir,
        homeDirectory: homeDir,
      });
      expect(protectedResults).toEqual([]);
    });
  });

  test("respects .lettaignore without using the file index", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".letta"), { recursive: true });
      await mkdir(join(dir, "ignored-dir"), { recursive: true });
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(
        join(dir, ".letta", ".lettaignore"),
        "ignored-dir\n*.tmp\n",
      );
      await writeFile(join(dir, "ignored-dir", "secret.ts"), "secret");
      await writeFile(join(dir, "src", "visible-secret.ts"), "visible");
      await writeFile(join(dir, "src", "hidden.tmp"), "tmp");

      const secretResults = await searchFileAutocomplete("secret", {
        cwd: dir,
        homeDirectory: join(dir, "home"),
      });
      expect(paths(secretResults)).toContain(join("src", "visible-secret.ts"));
      expect(paths(secretResults)).not.toContain(
        join("ignored-dir", "secret.ts"),
      );

      const tmpResults = await searchFileAutocomplete("tmp", {
        cwd: dir,
        homeDirectory: join(dir, "home"),
      });
      expect(paths(tmpResults)).not.toContain(join("src", "hidden.tmp"));
    });
  });

  test("aborted fuzzy searches do not return stale results", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "target.ts"), "target");
      const controller = new AbortController();
      controller.abort();

      const results = await searchFileAutocomplete("target", {
        cwd: dir,
        homeDirectory: join(dir, "home"),
        signal: controller.signal,
      });

      expect(results).toEqual([]);
    });
  });
});
