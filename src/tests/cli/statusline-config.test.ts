import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_STATUS_LINE_INTERVAL_MS,
  DEFAULT_STATUS_LINE_TIMEOUT_MS,
  MAX_STATUS_LINE_TIMEOUT_MS,
  MIN_STATUS_LINE_INTERVAL_MS,
  isStatusLineDisabled,
  normalizeStatusLineConfig,
  resolveStatusLineConfig,
} from "../../cli/helpers/statusLineConfig";
import { settingsManager } from "../../settings-manager";
import { setServiceName } from "../../utils/secrets.js";

const originalHome = process.env.HOME;
let testHomeDir: string;
let testProjectDir: string;

beforeEach(async () => {
  setServiceName("letta-code-test");
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-sl-home-"));
  testProjectDir = await mkdtemp(join(tmpdir(), "letta-sl-project-"));
  process.env.HOME = testHomeDir;
});

afterEach(async () => {
  await settingsManager.reset();
  process.env.HOME = originalHome;
  await rm(testHomeDir, { recursive: true, force: true }).catch(() => {});
  await rm(testProjectDir, { recursive: true, force: true }).catch(() => {});
});

describe("normalizeStatusLineConfig", () => {
  test("fills in defaults for interval and timeout", () => {
    const result = normalizeStatusLineConfig({ command: "echo hi" });
    expect(result.command).toBe("echo hi");
    expect(result.interval).toBe(DEFAULT_STATUS_LINE_INTERVAL_MS);
    expect(result.timeout).toBe(DEFAULT_STATUS_LINE_TIMEOUT_MS);
  });

  test("clamps interval to minimum", () => {
    const result = normalizeStatusLineConfig({
      command: "echo hi",
      interval: 100,
    });
    expect(result.interval).toBe(MIN_STATUS_LINE_INTERVAL_MS);
  });

  test("clamps timeout to maximum", () => {
    const result = normalizeStatusLineConfig({
      command: "echo hi",
      timeout: 999_999,
    });
    expect(result.timeout).toBe(MAX_STATUS_LINE_TIMEOUT_MS);
  });

  test("clamps timeout minimum to 1000", () => {
    const result = normalizeStatusLineConfig({
      command: "echo hi",
      timeout: 100,
    });
    expect(result.timeout).toBe(1_000);
  });

  test("preserves disabled flag", () => {
    const result = normalizeStatusLineConfig({
      command: "echo hi",
      disabled: true,
    });
    expect(result.disabled).toBe(true);
  });
});

describe("resolveStatusLineConfig", () => {
  test("returns null when no config is defined", async () => {
    await settingsManager.initialize();
    await settingsManager.loadProjectSettings(testProjectDir);
    await settingsManager.loadLocalProjectSettings(testProjectDir);
    expect(resolveStatusLineConfig(testProjectDir)).toBeNull();
  });

  test("returns global config when only global is set", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({
      statusLine: { command: "echo global" },
    });
    await settingsManager.flush();
    await settingsManager.loadProjectSettings(testProjectDir);
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    const result = resolveStatusLineConfig(testProjectDir);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("echo global");
  });

  test("local overrides project and global", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({
      statusLine: { command: "echo global" },
    });
    await settingsManager.loadProjectSettings(testProjectDir);
    settingsManager.updateProjectSettings(
      { statusLine: { command: "echo project" } },
      testProjectDir,
    );
    await settingsManager.loadLocalProjectSettings(testProjectDir);
    settingsManager.updateLocalProjectSettings(
      { statusLine: { command: "echo local" } },
      testProjectDir,
    );
    await settingsManager.flush();

    const result = resolveStatusLineConfig(testProjectDir);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("echo local");
  });

  test("project overrides global", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({
      statusLine: { command: "echo global" },
    });
    await settingsManager.loadProjectSettings(testProjectDir);
    settingsManager.updateProjectSettings(
      { statusLine: { command: "echo project" } },
      testProjectDir,
    );
    await settingsManager.loadLocalProjectSettings(testProjectDir);
    await settingsManager.flush();

    const result = resolveStatusLineConfig(testProjectDir);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("echo project");
  });

  test("returns null when disabled at user level", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({
      statusLine: { command: "echo global", disabled: true },
    });
    await settingsManager.flush();
    await settingsManager.loadProjectSettings(testProjectDir);
    await settingsManager.loadLocalProjectSettings(testProjectDir);

    expect(resolveStatusLineConfig(testProjectDir)).toBeNull();
  });
});

describe("isStatusLineDisabled", () => {
  test("returns false when no disabled flag is set", async () => {
    await settingsManager.initialize();
    await settingsManager.loadProjectSettings(testProjectDir);
    await settingsManager.loadLocalProjectSettings(testProjectDir);
    expect(isStatusLineDisabled(testProjectDir)).toBe(false);
  });

  test("returns true when user has disabled: true", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({
      statusLine: { command: "echo hi", disabled: true },
    });
    await settingsManager.flush();
    await settingsManager.loadProjectSettings(testProjectDir);
    await settingsManager.loadLocalProjectSettings(testProjectDir);
    expect(isStatusLineDisabled(testProjectDir)).toBe(true);
  });

  test("user disabled: false overrides project disabled: true", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({
      statusLine: { command: "echo hi", disabled: false },
    });
    await settingsManager.loadProjectSettings(testProjectDir);
    settingsManager.updateProjectSettings(
      { statusLine: { command: "echo proj", disabled: true } },
      testProjectDir,
    );
    await settingsManager.loadLocalProjectSettings(testProjectDir);
    await settingsManager.flush();
    expect(isStatusLineDisabled(testProjectDir)).toBe(false);
  });

  test("returns true when project has disabled: true (user undefined)", async () => {
    await settingsManager.initialize();
    await settingsManager.loadProjectSettings(testProjectDir);
    settingsManager.updateProjectSettings(
      { statusLine: { command: "echo proj", disabled: true } },
      testProjectDir,
    );
    await settingsManager.loadLocalProjectSettings(testProjectDir);
    await settingsManager.flush();
    expect(isStatusLineDisabled(testProjectDir)).toBe(true);
  });
});
