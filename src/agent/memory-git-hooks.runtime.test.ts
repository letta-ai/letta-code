import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  buildPreCommitHookScript,
  installPreCommitHook,
} from "./memory-git-hooks";

describe("MemFS hook runtime", () => {
  test("uses the bundled Electron executable in Git Bash on Windows", () => {
    const script = buildPreCommitHookScript({
      execPath: "C:\\Program Files\\Letta's Desktop\\Letta.exe",
      electron: true,
      platform: "win32",
    });

    expect(script).toContain(
      `ELECTRON_RUN_AS_NODE=1 '/c/Program Files/Letta'"'"'s Desktop/Letta.exe' "$@"`,
    );
    expect(script).toContain("run_memory_node -");
    expect(script).toContain('run_memory_node "$(git rev-parse');
  });

  test("validates and commits with the installed runtime when node on PATH fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "memfs-hook-runtime-"));
    const shimDir = join(repo, "fake runtime's directory");
    const runtime = join(shimDir, "Letta Electron");
    const env = {
      ...process.env,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      GIT_AUTHOR_NAME: "Test Agent",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test Agent",
      GIT_COMMITTER_EMAIL: "test@example.com",
      MEMFS_TEST_RUNTIME_MARKER: "runtime-called",
    };

    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      installPreCommitHook(repo, true);
      mkdirSync(shimDir);
      writeFileSync(
        runtime,
        '#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 91\nprintf "called\\n" >> "$MEMFS_TEST_RUNTIME_MARKER"\nexec bun "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
      writeFileSync(join(repo, "persona.md"), "Missing frontmatter\n");
      execFileSync("git", ["add", "MEMORY.md", "persona.md"], { cwd: repo });

      const hookPath = join(repo, ".git", "hooks", "pre-commit");
      if (process.platform !== "win32") {
        // The old hook calls bare node, so a failed PATH lookup blocks the
        // commit before it can even report the invalid frontmatter.
        writeFileSync(join(shimDir, "node"), "#!/bin/sh\nexit 92\n", {
          mode: 0o755,
        });
        writeFileSync(
          hookPath,
          buildPreCommitHookScript({ execPath: "node", electron: false }),
          { mode: 0o755 },
        );
        const missingNode = spawnSync("git", ["commit", "-m", "old hook"], {
          cwd: repo,
          env,
          encoding: "utf8",
        });
        expect(missingNode.status).not.toBe(0);
        expect(missingNode.stdout + missingNode.stderr).not.toContain(
          "persona.md: missing frontmatter",
        );
      }

      writeFileSync(
        hookPath,
        buildPreCommitHookScript({ execPath: runtime, electron: true }),
        { mode: 0o755 },
      );

      const invalid = spawnSync("git", ["commit", "-m", "invalid"], {
        cwd: repo,
        env,
        encoding: "utf8",
      });
      expect(invalid.status).not.toBe(0);
      expect(invalid.stdout + invalid.stderr).toContain(
        "persona.md: missing frontmatter",
      );
      expect(readFileSync(join(repo, "runtime-called"), "utf8")).toBe(
        "called\n",
      );

      writeFileSync(
        join(repo, "persona.md"),
        "---\nname: Persona\ndescription: Test identity\n---\nValid.\n",
      );
      execFileSync("git", ["add", "persona.md"], { cwd: repo });
      const valid = spawnSync("git", ["commit", "-m", "valid"], {
        cwd: repo,
        env,
        encoding: "utf8",
      });
      expect(valid.status).toBe(0);
      expect(readFileSync(join(repo, "persona.md"), "utf8")).toContain(
        "Valid.",
      );
      expect(
        readFileSync(join(repo, "runtime-called"), "utf8").split("called\n")
          .length,
      ).toBeGreaterThanOrEqual(4);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
