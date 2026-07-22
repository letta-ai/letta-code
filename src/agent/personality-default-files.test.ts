import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { applyMemfsFlags } from "@/agent/memory-filesystem";
import { initializeLocalMemoryRepo } from "@/agent/memory-git";
import {
  getPersonalityAssetPath,
  seedPersonalityDefaultMemoryFiles,
} from "@/agent/personality-default-files";
import { buildPersonalityTag } from "@/agent/personality-presets";
import { configureBackendMode } from "@/backend";
import { settingsManager } from "@/settings-manager";

const tempDirs: string[] = [];
const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
const originalLocalBackendExperimental =
  process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
const originalSetMemfsEnabled =
  settingsManager.setMemfsEnabled.bind(settingsManager);

function createTempMemoryRepo(): { agentId: string; memoryDir: string } {
  const agentId = `agent-local-tutor-${crypto.randomUUID()}`;
  const memoryDir = mkdtempSync(join(tmpdir(), "tutor-profile-memory-"));
  tempDirs.push(memoryDir);
  return { agentId, memoryDir };
}

function getCommitCount(memoryDir: string): number {
  return Number.parseInt(
    execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: memoryDir,
      encoding: "utf8",
    }).trim(),
    10,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalLocalBackendDir === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  } else {
    process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalBackendDir;
  }
  if (originalLocalBackendExperimental === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  } else {
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL =
      originalLocalBackendExperimental;
  }
  settingsManager.setMemfsEnabled = originalSetMemfsEnabled;
  configureBackendMode("api");
});

describe("Tutor default profile picture", () => {
  test("ships the normalized PNG in the npm package", async () => {
    const assetPath = getPersonalityAssetPath("tutor-profile");
    const metadata = await sharp(assetPath).metadata();
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
    ) as { files: string[] };

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
    expect(statSync(assetPath).size).toBeLessThan(5 * 1024 * 1024);
    expect(packageJson.files).toContain("assets/protected/tutor-profile.png");
    expect(packageJson.files).not.toContain("assets");
  });

  test("seeds profile.png once in a local memory repo", async () => {
    const { agentId, memoryDir } = createTempMemoryRepo();
    await initializeLocalMemoryRepo({ memoryDir, agentId, files: [] });

    const first = await seedPersonalityDefaultMemoryFiles({
      agentId,
      memoryDir,
      agentTags: [buildPersonalityTag("tutorial")],
      syncMode: "local",
    });

    expect(first).toEqual({
      seededPaths: ["profile.png"],
      skippedPaths: [],
      errors: [],
    });
    expect(readFileSync(join(memoryDir, "profile.png"))).toEqual(
      readFileSync(getPersonalityAssetPath("tutor-profile")),
    );
    expect(
      execFileSync("git", ["log", "-1", "--format=%s"], {
        cwd: memoryDir,
        encoding: "utf8",
      }).trim(),
    ).toBe("chore: set default Tutor profile picture");
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: memoryDir,
        encoding: "utf8",
      }),
    ).toBe("");
    expect(getCommitCount(memoryDir)).toBe(2);

    const second = await seedPersonalityDefaultMemoryFiles({
      agentId,
      memoryDir,
      agentTags: [buildPersonalityTag("tutorial")],
      syncMode: "local",
    });
    expect(second).toEqual({
      seededPaths: [],
      skippedPaths: ["profile.png"],
      errors: [],
    });
    expect(getCommitCount(memoryDir)).toBe(2);
  }, 15_000);

  test("preserves an existing profile picture byte-for-byte", async () => {
    const { agentId, memoryDir } = createTempMemoryRepo();
    await initializeLocalMemoryRepo({ memoryDir, agentId, files: [] });
    const customProfile = Buffer.from("user-selected-profile");
    writeFileSync(join(memoryDir, "profile.png"), customProfile);

    const result = await seedPersonalityDefaultMemoryFiles({
      agentId,
      memoryDir,
      agentTags: [buildPersonalityTag("tutorial")],
      syncMode: "local",
    });

    expect(result).toEqual({
      seededPaths: [],
      skippedPaths: ["profile.png"],
      errors: [],
    });
    expect(readFileSync(join(memoryDir, "profile.png"))).toEqual(customProfile);
    expect(getCommitCount(memoryDir)).toBe(1);
  }, 15_000);

  test("does not restore a profile picture that the user deleted", async () => {
    const { agentId, memoryDir } = createTempMemoryRepo();
    await initializeLocalMemoryRepo({ memoryDir, agentId, files: [] });
    await seedPersonalityDefaultMemoryFiles({
      agentId,
      memoryDir,
      agentTags: [buildPersonalityTag("tutorial")],
      syncMode: "local",
    });
    execFileSync("git", ["rm", "profile.png"], { cwd: memoryDir });
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Tutor",
        "-c",
        `user.email=${agentId}@letta.com`,
        "commit",
        "-m",
        "chore: remove profile picture",
      ],
      { cwd: memoryDir },
    );

    const result = await seedPersonalityDefaultMemoryFiles({
      agentId,
      memoryDir,
      agentTags: [buildPersonalityTag("tutorial")],
      syncMode: "local",
    });

    expect(result).toEqual({
      seededPaths: [],
      skippedPaths: ["profile.png"],
      errors: [],
    });
    expect(() => readFileSync(join(memoryDir, "profile.png"))).toThrow();
    expect(getCommitCount(memoryDir)).toBe(3);
  }, 15_000);

  test("cleans up a copied default when the memory commit fails", async () => {
    const { agentId, memoryDir } = createTempMemoryRepo();

    const result = await seedPersonalityDefaultMemoryFiles({
      agentId,
      memoryDir,
      agentTags: [buildPersonalityTag("tutorial")],
      syncMode: "local",
    });

    expect(result.seededPaths).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(() => readFileSync(join(memoryDir, "profile.png"))).toThrow();
  }, 15_000);

  test("does nothing for personalities without default files", async () => {
    const { agentId, memoryDir } = createTempMemoryRepo();
    await initializeLocalMemoryRepo({ memoryDir, agentId, files: [] });

    const result = await seedPersonalityDefaultMemoryFiles({
      agentId,
      memoryDir,
      agentTags: [buildPersonalityTag("memo")],
      syncMode: "local",
    });

    expect(result).toEqual({
      seededPaths: [],
      skippedPaths: [],
      errors: [],
    });
    expect(getCommitCount(memoryDir)).toBe(1);
  }, 15_000);

  test("seeds through the shared MemFS initialization path", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "tutor-profile-storage-"));
    tempDirs.push(storageDir);
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
    configureBackendMode("local");
    settingsManager.setMemfsEnabled = () => undefined;
    const agentId = `agent-local-${crypto.randomUUID()}`;

    const result = await applyMemfsFlags(agentId, true, {
      agentTags: [buildPersonalityTag("tutorial")],
      skipPromptUpdate: true,
    });

    expect(result.memoryDir).toBeDefined();
    expect(
      readFileSync(join(result.memoryDir as string, "profile.png")),
    ).toEqual(readFileSync(getPersonalityAssetPath("tutor-profile")));
  }, 15_000);
});
