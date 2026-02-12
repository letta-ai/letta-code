import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_STATUS_LINE_DEBOUNCE_MS,
  DEFAULT_STATUS_LINE_TIMEOUT_MS,
  isStatusLineDisabled,
  MAX_STATUS_LINE_TIMEOUT_MS,
  MIN_STATUS_LINE_DEBOUNCE_MS,
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
  test("fills defaults for timeout/debounce and command type", () => {
    const result = normalizeStatusLineConfig({ command: "echo hi" });
    expect(result.command).toBe("echo hi");
    expect(result.type).toBe("command");
    expect(result.timeout).toBe(DEFAULT_STATUS_LINE_TIMEOUT_MS);
    expect(result.debounceMs).toBe(DEFAULT_STATUS_LINE_DEBOUNCE_MS);
    expect(result.refreshIntervalMs).toBeUndefined();
    expect(result.padding).toBe(0);
  });

  test("respects explicit refreshIntervalMs", () => {
    const result = normalizeStatusLineConfig({
      command: "echo hi",
      refreshIntervalMs: 2500,
    });
    expect(result.refreshIntervalMs).toBe(2500);
  });

  test("clamps timeout to maximum", () => {
    const result = normalizeStatusLineConfig({
      command: "echo hi",
      timeout: 999_999,
    });
    expect(result.timeout).toBe(MAX_STATUS_LINE_TIMEOUT_MS);
  });

  test("clamps debounce minimum", () => {
    const result = normalizeStatusLineConfig({
      command: "echo hi",
      debounceMs: 1,
    });
    expect(result.debounceMs).toBe(MIN_STATUS_LINE_DEBOUNCE_MS);
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
    expect(result?.command).toBe("echo global");
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
    expect(result?.command).toBe("echo local");
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
