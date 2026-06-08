import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  getConversationTitleSettings,
  normalizeConversationTitle,
  setConversationTitleSettings,
} from "@/cli/helpers/conversation-title";
import { settingsManager } from "@/settings-manager";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

let testHomeDir = "";

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-title-settings-home-"));
  process.env.HOME = testHomeDir;
  process.env.USERPROFILE = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  if (testHomeDir) {
    await rm(testHomeDir, { recursive: true, force: true });
    testHomeDir = "";
  }

  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
});

describe("normalizeConversationTitle", () => {
  test("returns null for empty input", () => {
    expect(normalizeConversationTitle("")).toBeNull();
    expect(normalizeConversationTitle("   ")).toBeNull();
  });

  test("returns null for slash-command-shaped values", () => {
    expect(normalizeConversationTitle("/rename convo")).toBeNull();
    expect(normalizeConversationTitle("  /resume  ")).toBeNull();
  });

  test("collapses internal whitespace", () => {
    expect(normalizeConversationTitle("  Wire   up  fork  ")).toBe(
      "Wire up fork",
    );
  });

  test("strips a single layer of surrounding quotes", () => {
    expect(normalizeConversationTitle('"Refactor auth flow"')).toBe(
      "Refactor auth flow",
    );
    expect(normalizeConversationTitle("'Plan q4 roadmap'")).toBe(
      "Plan q4 roadmap",
    );
  });

  test("leaves mismatched / nested quotes alone", () => {
    expect(normalizeConversationTitle('"Title with "quoted" word"')).toBe(
      'Title with "quoted" word',
    );
  });

  test("truncates to CONVERSATION_TITLE_MAX_LENGTH", () => {
    const long = "a".repeat(CONVERSATION_TITLE_MAX_LENGTH + 50);
    const result = normalizeConversationTitle(long);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(CONVERSATION_TITLE_MAX_LENGTH);
  });
});

describe("conversation title settings", () => {
  test("defaults off and persists explicit opt-in", async () => {
    expect(getConversationTitleSettings()).toEqual({ enabled: false });

    expect(setConversationTitleSettings(true)).toEqual({ enabled: true });
    await settingsManager.flush();

    await settingsManager.reset();
    await settingsManager.initialize();

    expect(getConversationTitleSettings()).toEqual({ enabled: true });
  });

  test("rolls back legacy opt-ins once before allowing re-enable", async () => {
    await settingsManager.reset();
    const settingsDir = join(testHomeDir, ".letta");
    const settingsPath = join(settingsDir, "settings.json");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ autoConversationTitles: true }, null, 2),
    );

    await settingsManager.initialize();

    expect(getConversationTitleSettings()).toEqual({ enabled: false });
    await settingsManager.flush();

    const migrated = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      autoConversationTitles?: boolean;
      autoConversationTitlesRollbackApplied?: boolean;
    };
    expect(migrated.autoConversationTitles).toBe(false);
    expect(migrated.autoConversationTitlesRollbackApplied).toBe(true);

    expect(setConversationTitleSettings(true)).toEqual({ enabled: true });
    await settingsManager.flush();

    await settingsManager.reset();
    await settingsManager.initialize();

    expect(getConversationTitleSettings()).toEqual({ enabled: true });
  });
});
