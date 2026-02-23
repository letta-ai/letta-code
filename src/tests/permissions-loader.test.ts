import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getUserSettingsPaths,
  loadPermissions,
  savePermissionRule,
} from "../permissions/loader";

let testDir: string;

beforeEach(async () => {
  // Create a temporary test directory for project files
  testDir = await mkdtemp(join(tmpdir(), "letta-test-"));
});

afterEach(async () => {
  // Clean up test directory
  await rm(testDir, { recursive: true, force: true });
});

// ============================================================================
// Basic Loading Tests
// ============================================================================

test("Load permissions from empty directory returns rules from user settings", async () => {
  const projectDir = join(testDir, "empty-project");
  const permissions = await loadPermissions(projectDir);

  // Will include user settings from real ~/.letta/settings.json if it exists
  // So we just verify the structure is correct
  expect(Array.isArray(permissions.allow)).toBe(true);
  expect(Array.isArray(permissions.deny)).toBe(true);
  expect(Array.isArray(permissions.ask)).toBe(true);
  expect(Array.isArray(permissions.additionalDirectories)).toBe(true);
});

// Skipped: User settings tests require mocking homedir() which is not reliable across platforms

test("Load permissions from project settings", async () => {
  const projectDir = join(testDir, "project-1");
  const projectSettingsPath = join(projectDir, ".letta", "settings.json");
  await Bun.write(
    projectSettingsPath,
    JSON.stringify({
      permissions: {
        allow: ["Bash(npm run lint)"],
      },
    }),
  );

  const permissions = await loadPermissions(projectDir);

  // Should include project rule (may also include user settings from real home dir)
  expect(permissions.allow).toContain("Bash(npm run lint)");
});

test("Load permissions from local settings", async () => {
  const projectDir = join(testDir, "project-2");
  const localSettingsPath = join(projectDir, ".letta", "settings.local.json");
  await Bun.write(
    localSettingsPath,
    JSON.stringify({
      permissions: {
        allow: ["Bash(git push:*)"],
      },
    }),
  );

  const permissions = await loadPermissions(projectDir);

  // Should include local rule (may also include user settings from real home dir)
  expect(permissions.allow).toContain("Bash(git push:*)");
});

// ============================================================================
// Hierarchical Merging Tests
// ============================================================================

test("Local settings merge with project settings", async () => {
  const projectDir = join(testDir, "project-3");

  // Project settings
  await Bun.write(
    join(projectDir, ".letta", "settings.json"),
    JSON.stringify({
      permissions: {
        allow: ["Bash(cat:*)"],
      },
    }),
  );

  // Local settings
  await Bun.write(
    join(projectDir, ".letta", "settings.local.json"),
    JSON.stringify({
      permissions: {
        allow: ["Bash(git push:*)"],
      },
    }),
  );

  const permissions = await loadPermissions(projectDir);

  // All rules should be merged (concatenated), plus any from user settings
  expect(permissions.allow).toContain("Bash(cat:*)");
  expect(permissions.allow).toContain("Bash(git push:*)");
});

test("Settings merge deny rules from multiple sources", async () => {
  const projectDir = join(testDir, "project-4");

  // Project settings
  await Bun.write(
    join(projectDir, ".letta", "settings.json"),
    JSON.stringify({
      permissions: {
        deny: ["Read(.env)"],
      },
    }),
  );

  // Local settings
  await Bun.write(
    join(projectDir, ".letta", "settings.local.json"),
    JSON.stringify({
      permissions: {
        deny: ["Read(secrets/**)"],
      },
    }),
  );

  const permissions = await loadPermissions(projectDir);

  // Should contain both deny rules (plus any from user settings)
  expect(permissions.deny).toContain("Read(.env)");
  expect(permissions.deny).toContain("Read(secrets/**)");
});

test("Settings merge additionalDirectories", async () => {
  const projectDir = join(testDir, "project-5");

  // Project settings
  await Bun.write(
    join(projectDir, ".letta", "settings.json"),
    JSON.stringify({
      permissions: {
        additionalDirectories: ["../docs"],
      },
    }),
  );

  // Local settings
  await Bun.write(
    join(projectDir, ".letta", "settings.local.json"),
    JSON.stringify({
      permissions: {
        additionalDirectories: ["../shared"],
      },
    }),
  );

  const permissions = await loadPermissions(projectDir);

  // Should contain both (plus any from user settings)
  expect(permissions.additionalDirectories).toContain("../docs");
  expect(permissions.additionalDirectories).toContain("../shared");
});

// ============================================================================
// Saving Permission Rules Tests
// ============================================================================

// Skipped: User settings saving tests require mocking homedir()

test("Save permission to project settings", async () => {
  const projectDir = join(testDir, "project");
  await savePermissionRule(
    "Bash(npm run lint)",
    "allow",
    "project",
    projectDir,
  );

  const projectSettingsPath = join(projectDir, ".letta", "settings.json");
  const file = Bun.file(projectSettingsPath);
  const settings = await file.json();

  expect(settings.permissions.allow).toContain("Bash(npm run lint)");
});

test("Save permission to local settings", async () => {
  const projectDir = join(testDir, "project");
  await savePermissionRule("Bash(git push:*)", "allow", "local", projectDir);

  const localSettingsPath = join(projectDir, ".letta", "settings.local.json");
  const file = Bun.file(localSettingsPath);
  const settings = await file.json();

  expect(settings.permissions.allow).toContain("Bash(git push:*)");
});

test("User settings paths prefer ~/.letta and keep XDG as legacy fallback", () => {
  const homeDir = join("tmp", "home-test");
  const xdgConfigHome = join("tmp", "xdg-test");
  const paths = getUserSettingsPaths({ homeDir, xdgConfigHome });

  expect(paths.canonical).toBe(join(homeDir, ".letta", "settings.json"));
  expect(paths.legacy).toBe(join(xdgConfigHome, "letta", "settings.json"));
});

test("Save permission to deny list", async () => {
  const projectDir = join(testDir, "project");
  await savePermissionRule("Read(.env)", "deny", "project", projectDir);

  const settingsPath = join(projectDir, ".letta", "settings.json");
  const file = Bun.file(settingsPath);
  const settings = await file.json();

  expect(settings.permissions.deny).toContain("Read(.env)");
});

test("Save permission doesn't create duplicates", async () => {
  const projectDir = join(testDir, "project");
  await savePermissionRule("Bash(ls:*)", "allow", "project", projectDir);
  await savePermissionRule("Bash(ls:*)", "allow", "project", projectDir);

  const settingsPath = join(projectDir, ".letta", "settings.json");
  const file = Bun.file(settingsPath);
  const settings = await file.json();

  expect(
    settings.permissions.allow.filter((r: string) => r === "Bash(ls:*)"),
  ).toHaveLength(1);
});

test("Save permission preserves existing rules", async () => {
  const projectDir = join(testDir, "project");

  // Create initial settings
  const settingsPath = join(projectDir, ".letta", "settings.json");
  await Bun.write(
    settingsPath,
    JSON.stringify({
      permissions: {
        allow: ["Bash(cat:*)"],
      },
    }),
  );

  // Add another rule
  await savePermissionRule("Bash(ls:*)", "allow", "project", projectDir);

  const file = Bun.file(settingsPath);
  const settings = await file.json();

  expect(settings.permissions.allow).toContain("Bash(cat:*)");
  expect(settings.permissions.allow).toContain("Bash(ls:*)");
  expect(settings.permissions.allow).toHaveLength(2);
});

test("Save permission preserves other settings fields", async () => {
  const projectDir = join(testDir, "project");

  // Create settings with other fields
  const settingsPath = join(projectDir, ".letta", "settings.json");
  await Bun.write(
    settingsPath,
    JSON.stringify({
      tokenStreaming: true,
      lastAgent: "agent-123",
      permissions: {
        allow: [],
      },
    }),
  );

  await savePermissionRule("Bash(ls:*)", "allow", "project", projectDir);

  const file = Bun.file(settingsPath);
  const settings = await file.json();

  expect(settings.tokenStreaming).toBe(true);
  expect(settings.lastAgent).toBe("agent-123");
  expect(settings.permissions.allow).toContain("Bash(ls:*)");
});

// ============================================================================
// Error Handling Tests
// ============================================================================

test("Load permissions handles invalid JSON gracefully", async () => {
  const projectDir = join(testDir, "project-invalid-json");
  const settingsPath = join(projectDir, ".letta", "settings.json");

  // Write invalid JSON
  await Bun.write(settingsPath, "{ invalid json ");

  const permissions = await loadPermissions(projectDir);

  // Should return empty permissions instead of crashing (silently skip invalid file)
  expect(permissions.allow).toBeDefined();
  expect(permissions.deny).toBeDefined();
});

test("Load permissions handles missing permissions field", async () => {
  const projectDir = join(testDir, "project-no-perms");
  const settingsPath = join(projectDir, ".letta", "settings.json");

  await Bun.write(
    settingsPath,
    JSON.stringify({
      tokenStreaming: true,
      // No permissions field
    }),
  );

  const permissions = await loadPermissions(projectDir);

  // Should have empty arrays
  expect(Array.isArray(permissions.allow)).toBe(true);
  expect(Array.isArray(permissions.deny)).toBe(true);
});

test("Save permission creates parent directories", async () => {
  const deepPath = join(testDir, "deep", "nested", "project");
  await savePermissionRule("Bash(ls:*)", "allow", "project", deepPath);

  const settingsPath = join(deepPath, ".letta", "settings.json");
  const file = Bun.file(settingsPath);

  expect(await file.exists()).toBe(true);
});

// ============================================================================
// .gitignore Update Tests
// ============================================================================

test("Saving local settings updates .gitignore", async () => {
  const projectDir = join(testDir, "project");

  // Create .gitignore first
  await Bun.write(join(projectDir, ".gitignore"), "node_modules\n");

  await savePermissionRule("Bash(ls:*)", "allow", "local", projectDir);

  const gitignoreFile = Bun.file(join(projectDir, ".gitignore"));
  const content = await gitignoreFile.text();

  expect(content).toContain(".letta/settings.local.json");
  expect(content).toContain("node_modules"); // Preserves existing content
});

test("Saving local settings doesn't duplicate .gitignore entry", async () => {
  const projectDir = join(testDir, "project");

  await Bun.write(
    join(projectDir, ".gitignore"),
    "node_modules\n.letta/settings.local.json\n",
  );

  await savePermissionRule("Bash(ls:*)", "allow", "local", projectDir);

  const gitignoreFile = Bun.file(join(projectDir, ".gitignore"));
  const content = await gitignoreFile.text();

  const matches = content.match(/\.letta\/settings\.local\.json/g);
  expect(matches).toHaveLength(1);
});

test("Saving local settings creates .gitignore if missing", async () => {
  const projectDir = join(testDir, "project");

  await savePermissionRule("Bash(ls:*)", "allow", "local", projectDir);

  const gitignoreFile = Bun.file(join(projectDir, ".gitignore"));

  expect(await gitignoreFile.exists()).toBe(true);

  const content = await gitignoreFile.text();
  expect(content).toContain(".letta/settings.local.json");
});

test("Save permission dedupes canonical shell aliases", async () => {
  const projectDir = join(testDir, "project");
  await savePermissionRule(
    "run_shell_command(curl -s http://localhost:4321/intro)",
    "allow",
    "project",
    projectDir,
  );
  await savePermissionRule(
    "Bash(curl -s http://localhost:4321/intro)",
    "allow",
    "project",
    projectDir,
  );

  const settingsPath = join(projectDir, ".letta", "settings.json");
  const file = Bun.file(settingsPath);
  const settings = await file.json();

  expect(settings.permissions.allow).toContain(
    "Bash(curl -s http://localhost:4321/intro)",
  );
  expect(
    settings.permissions.allow.filter(
      (r: string) => r === "Bash(curl -s http://localhost:4321/intro)",
    ),
  ).toHaveLength(1);
});

test("Save permission dedupes slash variants for file patterns", async () => {
  const projectDir = join(testDir, "project");
  await savePermissionRule(
    "Edit(.skills\\skilled-mcp\\**)",
    "allow",
    "project",
    projectDir,
  );
  await savePermissionRule(
    "Edit(.skills/skilled-mcp/**)",
    "allow",
    "project",
    projectDir,
  );

  const settingsPath = join(projectDir, ".letta", "settings.json");
  const file = Bun.file(settingsPath);
  const settings = await file.json();

  expect(settings.permissions.allow).toContain("Edit(.skills/skilled-mcp/**)");
  expect(
    settings.permissions.allow.filter(
      (r: string) => r === "Edit(.skills/skilled-mcp/**)",
    ),
  ).toHaveLength(1);
});
