import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { __testOverrideNpmManagedModPackageInstaller } from "@/mods/package-installer";
import {
  deleteSkillDirectory,
  downloadDirectSkillFileSource,
  installSkillDirectory,
  listSkillDirectories,
  MAX_DIRECT_SKILL_FILE_BYTES,
  parseClawHubSpecifier,
  parseDirectSkillFileUrlSpecifier,
  parseGitHubSpecifier,
  runInstallSubcommand,
} from "./skills";

function createChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

function captureConsole(): {
  errors: string[];
  logs: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  console.error = (message?: unknown) => {
    errors.push(String(message));
  };
  return {
    errors,
    logs,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function writeLocalModPackage(params: {
  capabilities?: string[];
  packageRoot: string;
}): void {
  mkdirSync(join(params.packageRoot, "mods"), { recursive: true });
  writeFileSync(join(params.packageRoot, "mods", "index.ts"), "export {};\n");
  writeFileSync(
    join(params.packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@caren/my-mod",
        version: "0.1.0",
        letta: {
          manifestVersion: 1,
          mods: ["mods/index.ts"],
          ...(params.capabilities ? { capabilities: params.capabilities } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeInstalledNpmModPackage(params: {
  cwd: string;
  name?: string;
  version?: string;
}): void {
  const packageName = params.name ?? "@caren/my-mod";
  const packageRoot = join(
    params.cwd,
    "node_modules",
    ...packageName.split("/"),
  );
  mkdirSync(join(packageRoot, "mods"), { recursive: true });
  writeFileSync(join(packageRoot, "mods", "index.ts"), "export {};\n");
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: params.version ?? "0.1.0",
        repository: { url: "https://github.com/caren/my-mod.git" },
        letta: {
          manifestVersion: 1,
          mods: ["mods/index.ts"],
          capabilities: ["commands"],
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeGitModPackage(packageRoot: string): void {
  mkdirSync(join(packageRoot, "src"), { recursive: true });
  writeFileSync(join(packageRoot, "src", "mod.ts"), "export {};\n");
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "git-mod",
        version: "0.1.0",
      },
      null,
      2,
    )}\n`,
  );
}

describe("skills subcommand", () => {
  afterEach(() => {
    __testOverrideNpmManagedModPackageInstaller({});
  });

  test("parses GitHub tree URLs", () => {
    expect(
      parseGitHubSpecifier(
        "https://github.com/owner/repo/tree/main/path/to/skill",
      ),
    ).toEqual({
      repoUrl: "https://github.com/owner/repo.git",
      branch: null,
      subdir: "main/path/to/skill",
    });
  });

  test("parses GitHub blob SKILL.md URLs as their containing skill directory", () => {
    expect(
      parseGitHubSpecifier(
        "https://github.com/owner/repo/blob/main/path/to/skill/SKILL.md",
      ),
    ).toEqual({
      repoUrl: "https://github.com/owner/repo.git",
      branch: null,
      subdir: "main/path/to/skill",
    });
  });

  test("does not parse non-GitHub absolute URLs as GitHub shorthand", () => {
    expect(parseGitHubSpecifier("https://docs.x.com/skill.md")).toBeNull();
    expect(parseGitHubSpecifier("https://docs.x.com/not-a-skill")).toBeNull();
  });

  test("parses direct HTTPS skill file URLs", () => {
    expect(
      parseDirectSkillFileUrlSpecifier(
        "https://docs.x.com/path/skill.md?download=1",
      ),
    ).toEqual({
      url: "https://docs.x.com/path/skill.md?download=1",
    });
    expect(
      parseDirectSkillFileUrlSpecifier("https://docs.x.com/path/SKILL.md"),
    ).toEqual({
      url: "https://docs.x.com/path/SKILL.md",
    });
    expect(
      parseDirectSkillFileUrlSpecifier("https://docs.x.com/path/readme.md"),
    ).toBeNull();
    expect(
      parseDirectSkillFileUrlSpecifier("https://user:pass@docs.x.com/SKILL.md"),
    ).toBeNull();
    expect(
      parseDirectSkillFileUrlSpecifier("http://docs.x.com/SKILL.md"),
    ).toBeNull();
    expect(
      parseDirectSkillFileUrlSpecifier("http://localhost:3000/SKILL.md"),
    ).toEqual({
      url: "http://localhost:3000/SKILL.md",
    });
  });

  test("parses ClawHub specifiers", () => {
    expect(parseClawHubSpecifier("clawhub/nano-banana-pro")).toEqual({
      slug: "nano-banana-pro",
      version: null,
    });
    expect(parseClawHubSpecifier("clawhub:nano-banana-pro@1.0.1")).toEqual({
      slug: "nano-banana-pro",
      version: "1.0.1",
    });
    expect(
      parseClawHubSpecifier("https://clawhub.ai/skills/nano-banana-pro"),
    ).toEqual({
      slug: "nano-banana-pro",
      version: null,
    });
  });

  test("installs a skill directory into memfs skills using frontmatter name", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-skills-test-"));
    try {
      const sourceDir = join(tempRoot, "source", "finance", "stocks");
      const memoryDir = join(tempRoot, "memory");
      await mkdir(join(sourceDir, "scripts"), { recursive: true });
      writeFileSync(
        join(sourceDir, "SKILL.md"),
        "---\nname: market-data\ndescription: test\n---\n\n# Market Data\n",
      );
      writeFileSync(join(sourceDir, "scripts", "client.py"), "print('ok')\n");

      const result = await installSkillDirectory({ sourceDir, memoryDir });

      expect(result.name).toBe("market-data");
      expect(await readFile(join(result.path, "SKILL.md"), "utf8")).toContain(
        "# Market Data",
      );
      expect(
        await readFile(join(result.path, "scripts", "client.py"), "utf8"),
      ).toBe("print('ok')\n");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("downloads a direct skill file URL as a skill directory", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-skills-test-"));
    let downloaded: { tmpDir: string; sourceDir: string } | null = null;
    try {
      const memoryDir = join(tempRoot, "memory");
      const skillText =
        "---\nname: direct-url\ndescription: test\n---\n\n# Direct URL\n";

      downloaded = await downloadDirectSkillFileSource(
        { url: "https://docs.x.com/SKILL.md" },
        {
          fetchImpl: async (url) => {
            expect(String(url)).toBe("https://docs.x.com/SKILL.md");
            return new Response(skillText, {
              headers: { "content-length": String(skillText.length) },
            });
          },
        },
      );

      const result = await installSkillDirectory({
        sourceDir: downloaded.sourceDir,
        memoryDir,
      });

      expect(result.name).toBe("direct-url");
      expect(await readFile(join(result.path, "SKILL.md"), "utf8")).toBe(
        skillText,
      );
    } finally {
      if (downloaded) {
        await rm(downloaded.tmpDir, { recursive: true, force: true });
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects oversized direct skill file downloads", async () => {
    await expect(
      downloadDirectSkillFileSource(
        { url: "https://docs.x.com/SKILL.md" },
        {
          fetchImpl: async () =>
            new Response("too large", {
              headers: {
                "content-length": String(MAX_DIRECT_SKILL_FILE_BYTES + 1),
              },
            }),
        },
      ),
    ).rejects.toThrow(
      `Direct skill file exceeds ${MAX_DIRECT_SKILL_FILE_BYTES} byte limit.`,
    );
  });

  test("top-level install installs local mod packages", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-install-test-"));
    const consoleCapture = captureConsole();
    try {
      const packageRoot = join(tempRoot, "package");
      const modsRoot = join(tempRoot, "mods");
      writeLocalModPackage({ capabilities: ["commands"], packageRoot });

      const exitCode = await runInstallSubcommand([packageRoot], {
        globalModsDirectory: modsRoot,
      });

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        "Warning: mods are trusted local code and can execute on startup.",
      );
      expect(consoleCapture.logs.join("\n")).toContain(
        "Installed npm:@caren/my-mod@0.1.0",
      );
      expect(consoleCapture.logs.join("\n")).toContain("Run /reload");
      expect(
        existsSync(
          join(
            modsRoot,
            "packages",
            "npm",
            "@caren",
            "my-mod",
            "mods",
            "index.ts",
          ),
        ),
      ).toBe(true);
      expect(
        JSON.parse(readFileSync(join(modsRoot, "packages.json"), "utf8")),
      ).toEqual({
        packages: [
          {
            source: "npm:@caren/my-mod",
            version: "0.1.0",
            enabled: true,
            root: "packages/npm/@caren/my-mod",
            entries: ["mods/index.ts"],
          },
        ],
      });
    } finally {
      consoleCapture.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("top-level install installs local mod packages into agent memory", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-install-test-"));
    const consoleCapture = captureConsole();
    try {
      const packageRoot = join(tempRoot, "package");
      const memoryDir = join(tempRoot, "memory");
      writeLocalModPackage({ packageRoot });

      const exitCode = await runInstallSubcommand(
        ["--agent", "agent-123", packageRoot],
        {
          agentMemoryDirectory: memoryDir,
          commitAgentMemoryChanges: false,
        },
      );

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        "Target: agent agent-123",
      );
      expect(
        existsSync(
          join(
            memoryDir,
            "mods",
            "packages",
            "npm",
            "@caren",
            "my-mod",
            "mods",
            "index.ts",
          ),
        ),
      ).toBe(true);
      expect(
        JSON.parse(
          readFileSync(join(memoryDir, "mods", "packages.json"), "utf8"),
        ),
      ).toEqual({
        packages: [
          {
            source: "npm:@caren/my-mod",
            version: "0.1.0",
            enabled: true,
            root: "packages/npm/@caren/my-mod",
            entries: ["mods/index.ts"],
          },
        ],
      });
      expect(consoleCapture.errors).toEqual([]);
    } finally {
      consoleCapture.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("top-level install installs npm mod packages into agent memory", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-install-test-"));
    const consoleCapture = captureConsole();
    try {
      const memoryDir = join(tempRoot, "memory");
      __testOverrideNpmManagedModPackageInstaller({
        spawnImpl: (_cmd, _args, options) => {
          if (!options.cwd) throw new Error("expected cwd");
          writeInstalledNpmModPackage({
            cwd: options.cwd.toString(),
            version: "0.2.0",
          });
          const child = createChildProcess();
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
      });

      const exitCode = await runInstallSubcommand(
        ["npm:@caren/my-mod", "--agent", "agent-123"],
        {
          agentMemoryDirectory: memoryDir,
          commitAgentMemoryChanges: false,
        },
      );

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        "Target: agent agent-123",
      );
      expect(
        existsSync(
          join(
            memoryDir,
            "mods",
            "packages",
            "npm",
            "@caren",
            "my-mod",
            "mods",
            "index.ts",
          ),
        ),
      ).toBe(true);
      expect(
        JSON.parse(
          readFileSync(join(memoryDir, "mods", "packages.json"), "utf8"),
        ),
      ).toMatchObject({
        packages: [
          {
            source: "npm:@caren/my-mod",
            version: "0.2.0",
            enabled: true,
            root: "packages/npm/@caren/my-mod",
          },
        ],
      });
      expect(consoleCapture.errors).toEqual([]);
    } finally {
      consoleCapture.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("top-level install installs npm mod packages", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-install-test-"));
    const consoleCapture = captureConsole();
    try {
      const modsRoot = join(tempRoot, "mods");
      __testOverrideNpmManagedModPackageInstaller({
        spawnImpl: (_cmd, _args, options) => {
          if (!options.cwd) throw new Error("expected cwd");
          writeInstalledNpmModPackage({
            cwd: options.cwd.toString(),
            version: "0.2.0",
          });
          const child = createChildProcess();
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
      });

      const exitCode = await runInstallSubcommand(["npm:@caren/my-mod"], {
        globalModsDirectory: modsRoot,
      });

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        "Warning: mods are trusted local code and can execute on startup.",
      );
      expect(consoleCapture.logs.join("\n")).toContain(
        "Source: npm:@caren/my-mod",
      );
      expect(consoleCapture.logs.join("\n")).toContain(
        "Repository: https://github.com/caren/my-mod.git",
      );
      expect(consoleCapture.logs.join("\n")).toContain(
        "Capabilities: commands",
      );
      expect(consoleCapture.logs.join("\n")).toContain(
        "Installed npm:@caren/my-mod@0.2.0",
      );
      expect(
        existsSync(
          join(
            modsRoot,
            "packages",
            "npm",
            "@caren",
            "my-mod",
            "mods",
            "index.ts",
          ),
        ),
      ).toBe(true);
    } finally {
      consoleCapture.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("top-level install installs GitHub mod packages", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-install-test-"));
    const consoleCapture = captureConsole();
    try {
      const modsRoot = join(tempRoot, "mods");
      __testOverrideNpmManagedModPackageInstaller({
        gitSpawnImpl: (_cmd, args) => {
          if (args[0] === "clone") {
            writeGitModPackage(String(args.at(-1)));
          }
          const child = createChildProcess();
          queueMicrotask(() => {
            if (args[0] === "rev-parse") child.stdout?.emit("data", "abc123\n");
            child.emit("exit", 0);
          });
          return child;
        },
      });

      const exitCode = await runInstallSubcommand(
        ["git:github.com/caren/git-mod"],
        { globalModsDirectory: modsRoot },
      );

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        "Warning: mods are trusted local code and can execute on startup.",
      );
      expect(consoleCapture.logs.join("\n")).toContain(
        "Source: git:https://github.com/caren/git-mod",
      );
      expect(consoleCapture.logs.join("\n")).toContain(
        "Repository: https://github.com/caren/git-mod",
      );
      expect(consoleCapture.logs.join("\n")).toContain(
        "Installed git:https://github.com/caren/git-mod@0.1.0",
      );
      expect(consoleCapture.logs.join("\n")).toContain("Run /reload");
      expect(
        existsSync(
          join(
            modsRoot,
            "packages",
            "git",
            "github.com",
            "caren",
            "git-mod",
            "src",
            "mod.ts",
          ),
        ),
      ).toBe(true);
    } finally {
      consoleCapture.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("top-level GitHub mod install installs into agent memory", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-install-test-"));
    const consoleCapture = captureConsole();
    try {
      const memoryDir = join(tempRoot, "memory");
      __testOverrideNpmManagedModPackageInstaller({
        gitSpawnImpl: (_cmd, args) => {
          if (args[0] === "clone") {
            writeGitModPackage(String(args.at(-1)));
          }
          const child = createChildProcess();
          queueMicrotask(() => {
            if (args[0] === "rev-parse") child.stdout?.emit("data", "abc123\n");
            child.emit("exit", 0);
          });
          return child;
        },
      });

      const exitCode = await runInstallSubcommand(
        ["--agent", "agent-123", "git:github.com/caren/git-mod"],
        {
          agentMemoryDirectory: memoryDir,
          commitAgentMemoryChanges: false,
        },
      );

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain(
        "Target: agent agent-123",
      );
      expect(
        existsSync(
          join(
            memoryDir,
            "mods",
            "packages",
            "git",
            "github.com",
            "caren",
            "git-mod",
            "src",
            "mod.ts",
          ),
        ),
      ).toBe(true);
      expect(consoleCapture.errors).toEqual([]);
    } finally {
      consoleCapture.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("top-level install installs unscoped npm mod packages", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-install-test-"));
    const consoleCapture = captureConsole();
    try {
      const modsRoot = join(tempRoot, "mods");
      __testOverrideNpmManagedModPackageInstaller({
        spawnImpl: (_cmd, _args, options) => {
          if (!options.cwd) throw new Error("expected cwd");
          writeInstalledNpmModPackage({
            cwd: options.cwd.toString(),
            name: "my-mod",
          });
          const child = createChildProcess();
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
      });

      const exitCode = await runInstallSubcommand(["npm:my-mod"], {
        globalModsDirectory: modsRoot,
      });

      expect(exitCode).toBe(0);
      expect(consoleCapture.logs.join("\n")).toContain("Source: npm:my-mod");
      expect(existsSync(join(modsRoot, "packages", "npm", "my-mod"))).toBe(
        true,
      );
    } finally {
      consoleCapture.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("top-level npm mod install rejects force", async () => {
    const consoleCapture = captureConsole();
    try {
      const exitCode = await runInstallSubcommand([
        "--force",
        "npm:@caren/my-mod",
      ]);

      expect(exitCode).toBe(1);
      expect(consoleCapture.errors.join("\n")).toContain(
        "--force is only supported for skill installs.",
      );
    } finally {
      consoleCapture.restore();
    }
  });

  test("top-level npm mod install reports npm failure", async () => {
    const consoleCapture = captureConsole();
    try {
      __testOverrideNpmManagedModPackageInstaller({
        spawnImpl: () => {
          const child = createChildProcess();
          queueMicrotask(() => {
            child.stderr?.emit("data", "not found");
            child.emit("exit", 1);
          });
          return child;
        },
      });

      const exitCode = await runInstallSubcommand(["npm:@caren/missing-mod"]);

      expect(exitCode).toBe(1);
      expect(consoleCapture.errors.join("\n")).toContain(
        "npm install failed with code 1: not found",
      );
    } finally {
      consoleCapture.restore();
    }
  });

  test("lists installed skill directories with frontmatter metadata", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-skills-test-"));
    try {
      const memoryDir = join(tempRoot, "memory");
      const skillDir = join(memoryDir, "skills", "stocks");
      await mkdir(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: stocks\ndescription: Stock quotes\n---\n\n# Stocks\n",
      );

      expect(await listSkillDirectories({ memoryDir })).toEqual([
        {
          name: "stocks",
          description: "Stock quotes",
          path: skillDir,
        },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("deletes an installed skill directory", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "letta-skills-test-"));
    try {
      const memoryDir = join(tempRoot, "memory");
      const skillDir = join(memoryDir, "skills", "stocks");
      await mkdir(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "# Stocks\n");

      const result = await deleteSkillDirectory({ memoryDir, name: "stocks" });

      expect(result).toEqual({ name: "stocks", path: skillDir });
      expect(existsSync(skillDir)).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
